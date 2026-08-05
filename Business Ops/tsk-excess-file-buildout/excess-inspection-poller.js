#!/usr/bin/env node
/**
 * Business Ops/tsk-excess-file-buildout/excess-inspection-poller.js
 *
 * Entry point for the excess inspection email workflow.
 * Polls bizops@orangetsunami.com for spreadsheet/PDF attachments,
 * processes them via excess-processor.js, and routes via workflow handler.
 *
 * Usage:
 *   node excess-inspection-poller.js              # Process all unseen emails
 *   node excess-inspection-poller.js --dry-run    # Preview without processing
 *
 * See: excess-inspection-file-buildout.md
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// Path to the email-workflow-poller CLI
const POLLER_CLI = path.join(__dirname, '../../shared/email-workflow-poller.js');
const WORKFLOW_NAME = 'excess-inspection';

// Import processor for PO detection
const processor = require('./excess-processor');

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function runPoller(cmd, args = []) {
  const fullArgs = [cmd, '--workflow', WORKFLOW_NAME, ...args];
  const result = execSync(`node "${POLLER_CLI}" ${fullArgs.join(' ')}`, {
    encoding: 'utf-8',
    timeout: 120000,
  });
  return JSON.parse(result.trim());
}

function log(...args) {
  console.error('[excess-inspection-poller]', new Date().toISOString(), ...args);
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  log('Starting excess inspection poller', dryRun ? '(dry-run)' : '');

  // Step 1: List unseen emails
  let emails;
  try {
    emails = runPoller('list');
  } catch (err) {
    log('ERROR listing emails:', err.message);
    process.exit(1);
  }

  if (!Array.isArray(emails) || emails.length === 0) {
    log('No unseen emails');
    return;
  }

  log(`Found ${emails.length} unseen email(s)`);

  // Step 2: Process each email
  for (const email of emails) {
    log(`Processing UID ${email.uid}: ${email.subject}`);

    try {
      // Check if it looks like an excess inspection file
      const hasRelevantAttachment = (email.attachment_names || []).some(name => {
        const lower = name.toLowerCase();
        return lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.pdf');
      });

      if (!hasRelevantAttachment) {
        log(`UID ${email.uid}: No xlsx/xls/pdf attachment, skipping`);
        if (!dryRun) {
          const payload = { reason: 'no-spreadsheet-or-pdf-attachment' };
          execSync(`node "${POLLER_CLI}" route ${email.uid} skip --workflow ${WORKFLOW_NAME} --payload '${JSON.stringify(payload)}'`, {
            encoding: 'utf-8',
          });
        }
        continue;
      }

      // Read full email
      const fullEmail = runPoller('read', [String(email.uid)]);

      // Download attachments
      const attachResult = JSON.parse(execSync(
        `node "${POLLER_CLI}" download-attachments ${email.uid} --workflow ${WORKFLOW_NAME}`,
        { encoding: 'utf-8' }
      ).trim());

      // Find the xlsx/xls/pdf attachment
      const relevantFile = attachResult.files.find(f => {
        const lower = f.filename.toLowerCase();
        return lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.pdf');
      });

      if (!relevantFile) {
        log(`UID ${email.uid}: Attachment download failed or no relevant file found`);
        if (!dryRun) {
          const payload = {
            reason: 'attachment-download-failed',
            subject: email.subject,
            from: email.from,
          };
          execSync(`node "${POLLER_CLI}" route ${email.uid} needs_review --workflow ${WORKFLOW_NAME} --payload '${JSON.stringify(payload)}'`, {
            encoding: 'utf-8',
          });
        }
        continue;
      }

      // Try to auto-detect PO number
      const poDetection = processor.autoDetectPO({
        subject: fullEmail.subject,
        body: fullEmail.body,
        filename: relevantFile.filename,
      });

      const poNumber = poDetection.po;

      // Determine action
      if (!poNumber) {
        // Need PO number - route to need_info
        log(`UID ${email.uid}: Could not detect PO number, requesting info`);
        if (!dryRun) {
          const payload = {
            recipient: 'jake.harris@astutegroup.com',
            missing: ['poNumber'],
            subject: email.subject,
            extracted: {
              attachmentPath: relevantFile.path,
              filename: relevantFile.filename,
            },
          };
          execSync(`node "${POLLER_CLI}" route ${email.uid} need_info --workflow ${WORKFLOW_NAME} --payload '${JSON.stringify(payload)}'`, {
            encoding: 'utf-8',
          });
        }
        continue;
      }

      // Process the file
      log(`UID ${email.uid}: Processing with PO ${poNumber}`);
      if (!dryRun) {
        const payload = {
          attachmentPath: relevantFile.path,
          poNumber,
          originalSubject: email.subject,
        };
        const result = execSync(`node "${POLLER_CLI}" route ${email.uid} process --workflow ${WORKFLOW_NAME} --payload '${JSON.stringify(payload)}'`, {
          encoding: 'utf-8',
        });
        log(`UID ${email.uid}: Result:`, result.trim());
      } else {
        log(`UID ${email.uid}: Would process with PO ${poNumber}`);
      }

    } catch (err) {
      log(`ERROR processing UID ${email.uid}:`, err.message);

      // Route to needs_review on error
      if (!dryRun) {
        try {
          const payload = {
            reason: `processing-error: ${err.message}`,
            subject: email.subject,
            from: email.from,
          };
          execSync(`node "${POLLER_CLI}" route ${email.uid} needs_review --workflow ${WORKFLOW_NAME} --payload '${JSON.stringify(payload)}'`, {
            encoding: 'utf-8',
          });
        } catch (routeErr) {
          log(`ERROR routing UID ${email.uid} to needs_review:`, routeErr.message);
        }
      }
    }
  }

  log('Poller complete');
}

main().catch(err => {
  console.error('[excess-inspection-poller] Fatal error:', err);
  process.exit(1);
});
