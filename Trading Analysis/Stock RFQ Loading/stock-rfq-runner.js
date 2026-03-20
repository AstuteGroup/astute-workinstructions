#!/usr/bin/env node

/**
 * Stock RFQ Loading - Automated Runner
 *
 * Fetches RFQ emails from stockRFQ@orangetsunami.com, extracts line items
 * using LLM (two-agent: extract + verify), resolves customers and MFRs,
 * generates ERP-ready CSV, emails to Jake, and commits to git.
 *
 * Consumes shared cogs: email-fetcher, email-tracker, notifier, partner-lookup,
 * mfr-lookup, csv-utils, logger
 *
 * Usage:
 *   node stock-rfq-runner.js              # Full run
 *   node stock-rfq-runner.js --dry-run    # Parse but don't move emails or send notifications
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// Shared cogs
const { createFetcher } = require('../../shared/email-fetcher');
const { createTracker } = require('../../shared/email-tracker');
const { createNotifier } = require('../../shared/notifier');
const sharedLogger = require('../../shared/logger');
const { resolvePartner } = require('../../shared/partner-lookup');
const { normalizeMfr } = require('../../shared/mfr-lookup');
const { writeCSVFile } = require('../../shared/csv-utils');

// Config
const ACCOUNT = 'stockrfq';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'jake.harris@astutegroup.com';
const SMTP_PASS = process.env.SMTP_PASS || 'A$tuteu$a';
const OUTPUT_DIR = path.join(__dirname, 'output');
const DATA_DIR = path.join(__dirname, 'data');
const WORKINSTRUCTIONS_ROOT = path.resolve(__dirname, '../..');
const UNQUALIFIED_BROKER = '1008499';

// RFQ Import Template columns
const RFQ_COLUMNS = [
  'Chuboe_RFQ_ID[Value]',
  'Chuboe_CPC',
  'Chuboe_MFR_Text',
  'Chuboe_MPN',
  'Qty',
  'PriceEntered',
  'Description'
];

// Initialize shared cogs
const log = sharedLogger.createLogger('StockRFQ');
const fetcher = createFetcher(ACCOUNT);
const tracker = createTracker(DATA_DIR);
// Send via vq@ (confirmed SMTP auth working) — stockRFQ@ doesn't have SMTP configured
const notifier = createNotifier({
  fromEmail: 'vq@orangetsunami.com',
  fromName: 'Stock RFQ Loader',
  smtpPass: SMTP_PASS
});

// Parse CLI args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');
if (VERBOSE) process.env.VERBOSE = '1';

// ============================================
// LLM Extraction (Two-Agent Pattern)
// ============================================

function getAnthropicClient() {
  try {
    const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
    if (process.env.ANTHROPIC_API_KEY) {
      return new Anthropic();
    }
  } catch (e) {
    // SDK not available
  }

  // Fallback: try Claude CLI
  return null;
}

const EXTRACTION_PROMPT = `Extract RFQ line items from this customer email. Return a JSON array of objects.

Each object must have:
- "mpn": Manufacturer Part Number (required)
- "qty": Quantity requested as a number (required)
- "mfr": Manufacturer name if stated (optional, null if not given)
- "cpc": Customer's internal part code if distinct from MPN (optional, null if same as or not given)
- "target_price": Customer's target/budget price per unit as a number (optional, null if not stated)
- "notes": Any part-specific notes (optional)

Rules:
- Extract ALL line items, even if there are many
- If quantity has "k" or "K" suffix, multiply by 1000 (e.g., "5k" = 5000)
- Strip quantity suffixes like "pcs", "ea", "units"
- If a line has an MPN but no quantity, use 0
- Do NOT extract header rows, totals, or non-part text
- Return ONLY the JSON array, no other text

Email:
`;

const VERIFICATION_PROMPT = `You are a verification agent. Compare the original email against the extracted data.

Check for:
1. Missing line items (parts in email not in extraction)
2. Wrong quantities (misread numbers, wrong unit conversion)
3. Wrong MPNs (typos, truncation, wrong field used as MPN)
4. Target prices attributed to wrong lines

Return a JSON object:
{
  "verified": true/false,
  "issues": ["description of each issue found"],
  "corrected_data": [corrected array if issues found, or null if verified]
}

Original email:
---
EMAIL_TEXT
---

Extracted data:
---
EXTRACTED_JSON
---

Return ONLY the JSON object.`;

async function extractWithLLM(emailBody, subject) {
  const client = getAnthropicClient();

  if (client) {
    return await extractWithSDK(client, emailBody, subject);
  } else {
    return await extractWithCLI(emailBody, subject);
  }
}

async function extractWithSDK(client, emailBody, subject) {
  const fullText = `Subject: ${subject}\n\n${emailBody}`;

  // Agent 1: Extract
  log.info('  Agent 1 (Extractor): Running...');
  const extractResponse = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: EXTRACTION_PROMPT + fullText }]
  });

  const extractedText = extractResponse.content[0].text.trim();
  let extracted;
  try {
    // Handle markdown code blocks
    const jsonMatch = extractedText.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, extractedText];
    extracted = JSON.parse(jsonMatch[1].trim());
  } catch (e) {
    log.warn('  Agent 1: Failed to parse JSON, attempting cleanup');
    // Try to find JSON array in response
    const arrayMatch = extractedText.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      extracted = JSON.parse(arrayMatch[0]);
    } else {
      log.error('  Agent 1: Could not extract JSON from response');
      return [];
    }
  }

  log.info(`  Agent 1: Extracted ${extracted.length} line items`);

  // Agent 2: Verify
  log.info('  Agent 2 (Verifier): Running...');
  const verifyPrompt = VERIFICATION_PROMPT
    .replace('EMAIL_TEXT', fullText)
    .replace('EXTRACTED_JSON', JSON.stringify(extracted, null, 2));

  const verifyResponse = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: verifyPrompt }]
  });

  const verifyText = verifyResponse.content[0].text.trim();
  try {
    const jsonMatch = verifyText.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, verifyText];
    const verification = JSON.parse(jsonMatch[1].trim());

    if (verification.verified) {
      log.info('  Agent 2: Verified OK');
      return extracted;
    } else {
      log.warn(`  Agent 2: Found issues: ${verification.issues.join('; ')}`);
      if (verification.corrected_data && Array.isArray(verification.corrected_data)) {
        log.info(`  Agent 2: Using corrected data (${verification.corrected_data.length} items)`);
        return verification.corrected_data;
      }
      return extracted; // Use original if no corrected data provided
    }
  } catch (e) {
    log.warn('  Agent 2: Could not parse verification response, using Agent 1 data');
    return extracted;
  }
}

async function extractWithCLI(emailBody, subject) {
  const fullText = `Subject: ${subject}\n\n${emailBody}`;
  const prompt = EXTRACTION_PROMPT + fullText;

  // Write prompt to temp file to avoid shell escaping issues
  const tmpFile = path.join(DATA_DIR, 'tmp-prompt.txt');
  fs.writeFileSync(tmpFile, prompt, 'utf-8');

  try {
    log.info('  Extracting via Claude CLI...');
    const result = execSync(
      `claude -p "$(cat '${tmpFile}')" --output-format json 2>/dev/null`,
      { encoding: 'utf-8', timeout: 120000, maxBuffer: 5 * 1024 * 1024 }
    );

    // Parse Claude CLI JSON output
    const parsed = JSON.parse(result);
    const text = parsed.result || parsed.content || result;
    const arrayMatch = String(text).match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      return JSON.parse(arrayMatch[0]);
    }
  } catch (e) {
    log.error('  CLI extraction failed:', e.message);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
  return [];
}

// ============================================
// Forwarded Email Sender Extraction
// ============================================

/**
 * Extract the original sender from a forwarded email body.
 * Forwarded emails have headers like:
 *   From: sender@domain.com <sender@domain.com>
 *   From: Name <sender@domain.com>
 * We want the FIRST forwarded From: after the forwarding separator.
 */
function extractOriginalSender(body) {
  // Look for forwarded separator then From: line
  const fwdSeparators = [
    /_{3,}/,                           // _____ (Outlook style)
    /^-{3,}\s*Forwarded/im,            // --- Forwarded message
    /^-{3,}\s*Original Message/im,     // --- Original Message
    /^From:/m                          // Direct From: line (after envelope headers)
  ];

  // Find the first From: line that appears in the body (not the envelope)
  // Skip the envelope From: (first line) and find the forwarded one
  const lines = body.split('\n');
  let pastEnvelopeHeaders = false;
  let pastSeparator = false;

  for (const line of lines) {
    // Detect when we're past envelope headers (blank line or separator)
    if (!pastEnvelopeHeaders && (line.trim() === '' || /^_{3,}/.test(line.trim()))) {
      pastEnvelopeHeaders = true;
    }

    // Detect forwarding separator
    if (pastEnvelopeHeaders && /_{3,}|^-{3,}/.test(line.trim())) {
      pastSeparator = true;
      continue;
    }

    // Look for From: after separator
    if (pastSeparator && /^From:/i.test(line.trim())) {
      const emailMatch = line.match(/[\w.\-+]+@[\w.\-]+\.\w+/);
      const nameMatch = line.match(/From:\s*(.+?)\s*</i) || line.match(/From:\s*(.+?)(?:\s*<|\s*$)/i);
      if (emailMatch) {
        return {
          email: emailMatch[0],
          name: nameMatch ? nameMatch[1].trim() : ''
        };
      }
    }
  }

  return null;
}

// ============================================
// Email Categorization
// ============================================

// Subject patterns that are definitively NOT RFQs
const NOT_RFQ_SUBJECT_PATTERNS = [
  /purchase order/i,
  /stock order/i,
  /you have new held messages/i,
  /your office/i,
  /para tu pais/i,
  /unsubscribe/i,
  /newsletter/i,
  /out of office/i,
  /automatic reply/i,
  /auto[- ]?reply/i,
  /delivery notification/i,
  /read receipt/i,
  /mailer[- ]daemon/i,
  /postmaster/i,
  /RFQ Import Template.*\.csv/i,
];

// Subject patterns that indicate orders/follow-ups (not new RFQs)
const ORDER_FOLLOW_UP_PATTERNS = [
  /\bPO\b.*\d{5,}/i,                  // PO + number
  /\bCOV\d{5,}/i,                      // COV order reference
  /\bSO\d{5,}/i,                       // Sales order reference
  /shipment|tracking|shipped/i,        // Shipping related
  /invoice|payment|remittance/i,       // Financial
  /following up|follow up|checking in/i, // Follow-ups
];

// News/marketing subject patterns
const JUNK_SUBJECT_PATTERNS = [
  /strikes|kills|bomb|attack|war|conflict/i,  // News headlines
  /\$\d+[BMK]\s/i,                             // Dollar amounts in news ($15B)
  /impeccable|luxury|sale|discount|offer expires/i, // Marketing
];

/**
 * Categorize an email by subject and body content.
 * Returns: 'rfq' | 'not-rfq' | 'needs-review'
 */
function categorizeEmail(subject, body) {
  // Check subject-based rules first (cheapest)
  if (NOT_RFQ_SUBJECT_PATTERNS.some(p => p.test(subject))) return 'not-rfq';
  if (JUNK_SUBJECT_PATTERNS.some(p => p.test(subject))) return 'not-rfq';
  if (ORDER_FOLLOW_UP_PATTERNS.some(p => p.test(subject))) return 'not-rfq';

  // Check body for order/follow-up signals
  if (body) {
    const bodyLower = body.toLowerCase();
    if (bodyLower.includes('please find attached invoice') ||
        bodyLower.includes('tracking number') ||
        bodyLower.includes('has been shipped') ||
        bodyLower.includes('payment confirmation')) {
      return 'not-rfq';
    }
  }

  // Check if email has extractable part data
  if (hasPartData(body, subject)) return 'rfq';

  // Subject has MPN-like pattern but body was empty — likely RFQ with rendering issue
  const mpnInSubject = /[A-Z0-9][A-Z0-9\-\/\.]{3,}/i.test(subject);
  if (mpnInSubject && (!body || body.trim() === '')) return 'needs-review';

  return 'needs-review';
}

function hasPartData(body, subject) {
  const mpnPattern = /[A-Z0-9][A-Z0-9\-\/\.]{3,}/i;
  const qtyPattern = /\b\d+(?:,\d{3})*(?:\s*(?:k|K|pcs|ea|units?|pc))?\b/;

  const fullText = `${subject}\n${body}`;
  return mpnPattern.test(fullText) && qtyPattern.test(fullText);
}

// ============================================
// Main Pipeline
// ============================================

async function run() {
  log.info(`=== Stock RFQ Runner starting ${DRY_RUN ? '(DRY RUN)' : ''} ===`);

  // Ensure folders exist
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  await fetcher.createFolder('Processed');
  await fetcher.createFolder('NotRFQ');
  await fetcher.createFolder('NeedsReview');

  // Step 1: Fetch inbox
  const envelopes = await fetcher.listEnvelopes('INBOX', 500);
  log.info(`Found ${envelopes.length} emails in INBOX`);

  if (envelopes.length === 0) {
    log.info('No emails to process. Done.');
    return;
  }

  // Filter already processed
  const unprocessed = envelopes.filter(e => !tracker.isProcessed(e.id));
  log.info(`${unprocessed.length} unprocessed emails (${envelopes.length - unprocessed.length} already tracked)`);

  if (unprocessed.length === 0) {
    log.info('All emails already processed. Done.');
    return;
  }

  const allRows = [];
  const processedIds = [];
  const notRfqIds = [];
  const needsReviewIds = [];
  const summary = { processed: 0, notRfq: 0, needsReview: 0, totalLines: 0, errors: 0 };

  for (const envelope of unprocessed) {
    log.info(`--- Processing email ${envelope.id}: "${envelope.subject}" from ${envelope.from?.addr || 'unknown'}`);

    try {
      // Step 2: Read email
      const body = await fetcher.readMessage(envelope.id);

      // Step 2b: Categorize (subject + body analysis)
      const category = categorizeEmail(envelope.subject, body || '');
      if (category === 'not-rfq') {
        log.info(`  Categorized as NotRFQ (order/follow-up/junk)`);
        notRfqIds.push(envelope.id);
        summary.notRfq++;
        continue;
      }
      if (category === 'needs-review') {
        log.info(`  Needs review (empty body or ambiguous)`);
        needsReviewIds.push(envelope.id);
        summary.needsReview++;
        continue;
      }

      // Step 3: Extract line items (two-agent)
      const items = await extractWithLLM(body, envelope.subject);

      if (!items || items.length === 0) {
        log.warn(`  No items extracted → NeedsReview`);
        needsReviewIds.push(envelope.id);
        summary.needsReview++;
        continue;
      }

      // Step 4: Resolve customer
      // For forwarded emails (FW:), extract the original sender from the body
      const isForwarded = /^(FW|Fwd):/i.test(envelope.subject);
      let senderEmail = envelope.from?.addr || '';
      let senderName = envelope.from?.name || '';

      if (isForwarded) {
        const originalSender = extractOriginalSender(body);
        if (originalSender) {
          log.info(`  Forwarded email — original sender: ${originalSender.email} (${originalSender.name})`);
          senderEmail = originalSender.email;
          senderName = originalSender.name || senderName;
        } else {
          log.warn(`  Forwarded email but could not extract original sender`);
        }
      }

      let customerKey = UNQUALIFIED_BROKER;
      let customerName = senderName || senderEmail;

      if (senderEmail) {
        const partner = resolvePartner({
          email: senderEmail,
          companyName: senderName,
          partnerType: 'any'
        });

        if (partner.matched) {
          customerKey = partner.search_key;
          customerName = partner.name;
          log.info(`  Customer matched: ${customerName} (${customerKey})`);
        } else {
          log.info(`  Customer not matched → Unqualified Broker (${UNQUALIFIED_BROKER})`);
          customerName = senderName || senderEmail;
        }
      }

      // Steps 5-6: MFR matching + build CSV rows
      for (const item of items) {
        const mfr = item.mfr ? normalizeMfr(item.mfr) : '';
        const mpn = (item.mpn || '').trim();
        const cpc = item.cpc || mpn; // Default CPC to MPN if not distinct
        const qty = parseInt(item.qty, 10) || 0;
        const price = item.target_price != null ? parseFloat(item.target_price) : '';

        // Description: if unqualified broker, include customer name
        let description = item.notes || '';
        if (customerKey === UNQUALIFIED_BROKER && customerName) {
          description = description ? `${customerName} - ${description}` : customerName;
        }

        allRows.push([
          customerKey,    // Chuboe_RFQ_ID[Value]
          cpc,            // Chuboe_CPC
          mfr,            // Chuboe_MFR_Text
          mpn,            // Chuboe_MPN
          qty,            // Qty
          price,          // PriceEntered
          description     // Description
        ]);
      }

      log.info(`  Extracted ${items.length} lines`);
      summary.totalLines += items.length;
      processedIds.push(envelope.id);
      summary.processed++;

    } catch (err) {
      log.error(`  Error processing email ${envelope.id}:`, err.message);
      needsReviewIds.push(envelope.id);
      summary.errors++;
    }
  }

  // Step 6: Generate output CSV
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const timestamp = new Date().toISOString().slice(11, 16).replace(':', '');

  if (allRows.length > 0) {
    const outputFile = path.join(OUTPUT_DIR, `RFQ_UPLOAD_${dateStr}_${timestamp}.csv`);
    writeCSVFile(outputFile, RFQ_COLUMNS, allRows);
    log.info(`Generated ${outputFile} with ${allRows.length} lines`);

    if (!DRY_RUN) {
      // Step 7: Move emails
      for (const id of processedIds) {
        const moved = await fetcher.moveMessage(id, 'Processed');
        if (moved) {
          tracker.markProcessed(id, { status: 'processed', lines: allRows.length });
        } else {
          log.warn(`  Failed to move email ${id}, adding to retry queue`);
          tracker.addToRetryQueue(id, 'move-failed');
        }
      }

      for (const id of notRfqIds) {
        const moved = await fetcher.moveMessage(id, 'NotRFQ');
        if (moved) tracker.markProcessed(id, { status: 'not-rfq' });
      }

      for (const id of needsReviewIds) {
        const moved = await fetcher.moveMessage(id, 'NeedsReview');
        if (moved) tracker.markProcessed(id, { status: 'needs-review' });
      }

      // Step 8: Email notification
      const emailSubject = `Stock RFQ Upload Ready - ${new Date().toISOString().slice(0, 10)}`;
      const emailBody = [
        `=== Stock RFQ Automated Run (${new Date().toISOString().slice(0, 16).replace('T', ' ')}) ===`,
        '',
        `Emails processed: ${summary.processed}`,
        `Not RFQ (moved): ${summary.notRfq}`,
        `Needs review: ${summary.needsReview}`,
        `Errors: ${summary.errors}`,
        '',
        `Total RFQ lines extracted: ${summary.totalLines}`,
        `Output file: ${path.basename(outputFile)}`,
        '',
        'CSV attached for review before ERP import.',
        '',
        '---',
        'Automated by Stock RFQ Runner'
      ].join('\n');

      await notifier.sendWithAttachment(NOTIFY_EMAIL, emailSubject, emailBody, [
        { filename: path.basename(outputFile), path: outputFile }
      ]);

      // Step 9: Git commit + push
      try {
        execSync(
          `git -C "${WORKINSTRUCTIONS_ROOT}" add "Trading Analysis/Stock RFQ Loading/output/" && ` +
          `git -C "${WORKINSTRUCTIONS_ROOT}" commit -m "Auto: Stock RFQ upload ${new Date().toISOString().slice(0, 10)}" && ` +
          `git -C "${WORKINSTRUCTIONS_ROOT}" push`,
          { encoding: 'utf-8', timeout: 30000 }
        );
        log.info('Git commit and push complete');
      } catch (gitErr) {
        // May fail if nothing to commit (already committed) — that's OK
        if (gitErr.message.includes('nothing to commit')) {
          log.info('Git: nothing new to commit');
        } else {
          log.warn('Git commit/push failed:', gitErr.message);
        }
      }
    } else {
      log.info('[DRY RUN] Would move emails, send notification, and git commit');
    }
  } else {
    log.info('No RFQ lines extracted this run');

    // Still move NotRFQ and NeedsReview emails even if no lines
    if (!DRY_RUN) {
      for (const id of notRfqIds) {
        const moved = await fetcher.moveMessage(id, 'NotRFQ');
        if (moved) tracker.markProcessed(id, { status: 'not-rfq' });
      }
      for (const id of needsReviewIds) {
        const moved = await fetcher.moveMessage(id, 'NeedsReview');
        if (moved) tracker.markProcessed(id, { status: 'needs-review' });
      }
    }
  }

  // Update stats
  tracker.updateStats({
    emailsProcessed: summary.processed,
    recordsGenerated: summary.totalLines
  });

  log.info(`=== Stock RFQ Runner complete: ${summary.processed} emails → ${summary.totalLines} lines ===`);
}

// Run
run().catch(err => {
  log.error('Fatal error:', err.message);
  process.exit(1);
});
