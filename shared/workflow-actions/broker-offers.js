/**
 * shared/workflow-actions/broker-offers.js
 *
 * Workflow module for broker/franchise market offer loading. Consumed by
 * shared/email-workflow-poller.js when invoked with --workflow broker-offers.
 *
 * Inbox: brokeroffers@orangetsunami.com
 * Doc:   Trading Analysis/Broker Offers/broker-offers.md
 *
 * Mirrors the excess workflow architecture but for EXTERNAL broker/franchise
 * sources (not customer excess). Key differences:
 *   - Offer type determined by sender signals (Broker Stock Offer 1000001,
 *     Franchise Offers 1000002, or Franchise Stock Offers 1000004)
 *   - No customer-side "vendor flip" needed — senders ARE brokers/franchises
 *   - No downstream analysis pipeline → no large-offer gate
 *   - All notifications go to operator + internal CC — NEVER external senders
 *
 * The agent reads each unseen email, resolves the partner via shared/partner-lookup.js,
 * extracts lines from attachments + body, determines offer type from sender signals,
 * runs cross-forward dedup, and calls one of the routing actions below.
 */

'use strict';

const { execSync } = require('child_process');
const { writeOffer } = require('../offer-writeback');
const writerAttribution = require('../writer-attribution');
const breadcrumbs = require('../breadcrumbs');
const pending = require('../workflow-pending-state');

// ─── PARTNER NAME LOOKUP ──────────────────────────────────────────────────────
// Look up partner name from bpartnerId if not provided in payload.
// Fallback for when agent doesn't pass partnerName. Matches excess.js + rfq-loader-daemon.js.
function lookupPartnerName(bpartnerId) {
  if (!bpartnerId) return null;
  try {
    const sql = `SELECT name FROM adempiere.c_bpartner WHERE c_bpartner_id = ${parseInt(bpartnerId, 10)} LIMIT 1`;
    const result = execSync(`psql -t -A -c "${sql}"`, {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, PGUSER: 'analytics_user', PGDATABASE: 'idempiere_replica' },
    }).trim();
    return result || null;
  } catch (e) {
    return null;
  }
}

// ─── OFFER TYPE DETERMINATION ─────────────────────────────────────────────────
//
// Agent determines offer type based on sender/content signals:
//   - 1000001 = Broker Stock Offer (default for unknown brokers, broker liquidations)
//   - 1000002 = Franchise Offers (distributor excess, authorized stock)
//   - 1000004 = Franchise Stock Offers (franchise inventory, authorized listings)
//
// Hints the agent should look for:
//   - Sender domain matching known franchise distributors → 1000002 or 1000004
//   - Subject/body containing "franchise", "authorized", "stock offer" → 1000004
//   - Subject/body containing "liquidation", "excess", "lot" → 1000001 or 1000002
//   - Default unknown → 1000001 (Broker Stock Offer)
//
// Override via body hint: "Type: Broker" / "Type: Franchise" / "Type: Franchise Stock"

const OFFER_TYPES = {
  BROKER_STOCK: 1000001,
  FRANCHISE_OFFERS: 1000002,
  FRANCHISE_STOCK: 1000004,
};

// ─── HANDLERS ────────────────────────────────────────────────────────────────

/**
 * Load an extracted offer to OT.
 *
 * Required payload:
 *   bpartnerId, offerType, lines[]
 *
 * Optional:
 *   description (auto-generated from BP name + date if omitted)
 *   sourceUid (for breadcrumb traceability)
 *   partnerName, originalSender, originalCc, originalSubject (for confirmation email)
 */
async function action_load_offer(payload, ctx) {
  const { bpartnerId, offerType, lines, description, sourceUid,
          originalSender, originalCc, originalSubject } = payload;

  // Resolve partnerName from payload OR look up from DB (fallback for when
  // agent doesn't pass partnerName). Matches excess.js + rfq-loader-daemon.js.
  const partnerName = payload.partnerName || lookupPartnerName(bpartnerId);

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_write: { bpartnerId, offerType, lineCount: lines.length, description },
    };
  }

  // ── Message-ID idempotency guard ─────────────────────────────────────────
  const dedupMessageId = ctx.currentMessageId;
  if (dedupMessageId) {
    const dupCheck = breadcrumbs.hasMessageIdAlreadyLoaded(dedupMessageId, {
      cog: 'broker-offers',
      events: ['loaded'],
    });
    if (dupCheck.loaded) {
      breadcrumbs.write({
        cog: 'broker-offers',
        event: 'already-loaded-skip',
        uid: ctx.uid,
        messageId: dedupMessageId,
        prior_uid: dupCheck.breadcrumb.uid,
        prior_offer_id: dupCheck.breadcrumb.offerId,
        prior_search_key: dupCheck.breadcrumb.searchKey,
        prior_ts: dupCheck.breadcrumb.ts,
      });
      return {
        already_processed: true,
        messageId: dedupMessageId,
        prior: {
          offerId: dupCheck.breadcrumb.offerId,
          searchKey: dupCheck.breadcrumb.searchKey,
          ts: dupCheck.breadcrumb.ts,
          uid: dupCheck.breadcrumb.uid,
        },
      };
    }
  }

  const result = await writeOffer({
    bpartnerId,
    offerTypeId: offerType,
    description: description || `${new Date().toISOString().slice(0, 10).replace(/-/g, '.')}-bp${bpartnerId}-brokerAgent`,
    writeMpnRecords: true,
    lines,
  });

  // ── Budget exhaustion: defer for retry ──────────────────────────────────────
  // If offer-writeback returned rateLimited, propagate it so the poller leaves
  // the email UNSEEN for the next poll cycle.
  //
  // REPEAT-DEFERRAL CHECK: If we already have a breadcrumb for this UID from a
  // prior tick, don't notify again — the agent should exit silently.
  if (result.rateLimited) {
    const priorDeferral = breadcrumbs.findByUid(ctx.uid, {
      cog: 'broker-offers',
      events: ['load-deferred-budget'],
      sinceMs: Date.now() - 24 * 60 * 60 * 1000, // within 24h
    });
    const alreadyDeferred = priorDeferral.found;

    // Only write a new breadcrumb if this is the first deferral
    if (!alreadyDeferred) {
      breadcrumbs.write({
        cog: 'broker-offers',
        event: 'load-deferred-budget',
        uid: ctx.uid,
        sourceUid: sourceUid || ctx.uid,
        messageId: ctx.currentMessageId || null,
        bpartnerId,
        offerType,
        lineCount: lines.length,
        reason: result.rateLimitReason,
      });
    }

    return {
      rateLimited: true,
      alreadyDeferred,  // <-- agent checks this to skip repeat notification
      rateLimitReason: result.rateLimitReason,
      rateLimitTier: result.rateLimitTier || 'global',
      lineCount: lines.length,
      partnerName: partnerName || null,
      bpartnerId,
      offerType,
    };
  }

  breadcrumbs.write({
    cog: 'broker-offers',
    event: 'loaded',
    uid: ctx.uid,
    sourceUid: sourceUid || ctx.uid,
    messageId: ctx.currentMessageId || null,
    bpartnerId,
    offerType,
    offerId: result.offerId,
    searchKey: result.searchKey,
    linesWritten: result.linesWritten,
    errorCount: result.errors.length,
    chunkedMode: result.chunkedMode || false,
  });

  // Per-row error attribution
  writerAttribution.persistWriterDetails({
    workflow: 'broker-offers',
    ctx,
    result,
  });

  // ── Send confirmation to INTERNAL Astute parties only ─────────────────────
  // NEVER send to external brokers/franchises
  if (result.offerId && !ctx.dryRun) {
    try {
      const isInternal = (email) => email && email.toLowerCase().includes('@astutegroup.com');

      // Build recipient list: internal forwarder first, then internal CCs, then Jake
      const internalRecipients = [];
      if (isInternal(originalSender)) {
        internalRecipients.push(originalSender);
      }
      if (Array.isArray(originalCc)) {
        for (const cc of originalCc) {
          if (isInternal(cc) && !cc.includes('brokeroffers@') && !internalRecipients.includes(cc.toLowerCase())) {
            internalRecipients.push(cc);
          }
        }
      }
      if (ctx.jakeEmail && !internalRecipients.map(e => e.toLowerCase()).includes(ctx.jakeEmail.toLowerCase())) {
        internalRecipients.push(ctx.jakeEmail);
      }

      if (internalRecipients.length > 0) {
        const toEmail = internalRecipients[0];
        const ccList = internalRecipients.slice(1);

        const offerTypeName = offerType === OFFER_TYPES.BROKER_STOCK ? 'Broker Stock Offer'
          : offerType === OFFER_TYPES.FRANCHISE_OFFERS ? 'Franchise Offers'
          : offerType === OFFER_TYPES.FRANCHISE_STOCK ? 'Franchise Stock Offers'
          : `Offer (type ${offerType})`;

        const confirmSubject = originalSubject
          ? `Re: ${originalSubject}`
          : `Market Offer ${result.searchKey} loaded`;

        // Build confirmation body with all metadata
        let confirmBody = `Broker/franchise offer loaded.

Partner: ${partnerName || '(unknown)'}
Market Offer #: ${result.searchKey}
Type: ${offerTypeName}
Contact: Jake Harris
Lines loaded: ${result.linesWritten}`;

        if (description) {
          confirmBody += `\nDescription: ${description}`;
        }

        confirmBody += `

This offer is now in Orange Tsunami.

— Broker Offers System (automated)`;

        const threadingOpts = {
          cc: ccList.length > 0 ? ccList : undefined,
        };
        if (ctx.currentMessageId) {
          threadingOpts.inReplyTo = ctx.currentMessageId;
          threadingOpts.references = ctx.currentMessageId;
        }
        await ctx.notifier.sendEmail(toEmail, confirmSubject, confirmBody, threadingOpts);

        breadcrumbs.write({
          cog: 'broker-offers',
          event: 'confirmation-sent',
          uid: ctx.uid,
          offerId: result.offerId,
          searchKey: result.searchKey,
          partner: partnerName,
          offerType: offerTypeName,
          linesLoaded: result.linesWritten,
          to: toEmail,
          cc: ccList,
        });
      }
    } catch (e) {
      console.error(`[broker-offers.load_offer] confirmation email failed: ${e.message}`);
    }
  }

  return {
    offerId: result.offerId,
    searchKey: result.searchKey,
    linesWritten: result.linesWritten,
    errors: result.errors,
  };
}

/**
 * Partner couldn't be resolved. Email operator with PARTNER reply prompt.
 *
 * Required payload: { subject, outerFrom, hints }
 * Optional: { extracted } — line data to display so operator can identify vendor
 */
async function action_needs_partner(payload, ctx) {
  const { subject, outerFrom, hints, extracted, investigation_summary } = payload;
  const linesCount = Array.isArray(extracted && extracted.lines) ? extracted.lines.length : 0;

  const extractedLinesHtml = formatExtractedLinesTable(extracted);

  // Investigation summary block — shows agent reasoning. Parity with VQ UID 10064 fix.
  const investigationBlock = investigation_summary
    ? `<p><b>Agent investigation:</b></p><pre style="background:#eef6ff;padding:8px;white-space:pre-wrap;font-size:12px;border-left:3px solid #369">${esc(investigation_summary)}</pre>`
    : '';

  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">Broker Offers — partner unresolved</h2>
<p><b>Subject:</b> ${esc(subject)}<br/>
   <b>From:</b> ${esc(outerFrom)}<br/>
   <b>UID:</b> ${ctx.uid}<br/>
   <b>Inbox:</b> ${esc(ctx.inbox)}<br/>
   <b>Lines parsed:</b> ${fmt(linesCount)}</p>
<p><b>What was tried:</b><br/>${esc(hints || '(no hints provided)')}</p>
${investigationBlock}
${extractedLinesHtml}
<p style="background:#f5f5f5;padding:10px;border-left:3px solid #b00">
   <b>Reply with:</b><br/>
   <code>PARTNER: ${ctx.uid} = &lt;BP search key 6-8 digits OR company name&gt;</code>
</p>
<p style="color:#666;font-size:11px">Message moved to NeedsPartner folder.</p>
</body></html>`;

  if (ctx.dryRun) {
    return { dry_run: true, would_notify_jake: { subject, outerFrom } };
  }

  // Email threading headers — escalation lands in same thread as original
  const opts = { html: true };
  if (ctx.currentMessageId) {
    opts.inReplyTo = ctx.currentMessageId;
    const refs = Array.isArray(ctx.currentReferences) ? [...ctx.currentReferences] : [];
    if (!refs.includes(ctx.currentMessageId)) refs.push(ctx.currentMessageId);
    if (refs.length > 0) opts.references = refs;
  }

  await ctx.notifier.sendEmail(
    ctx.jakeEmail,
    `Broker Offers — NeedsPartner: ${subject || '(no subject)'}`,
    html,
    opts,
  );

  breadcrumbs.write({
    cog: 'broker-offers',
    event: 'escalated-needs_partner',
    uid: ctx.uid,
    subject,
    outerFrom,
    investigation_summary: investigation_summary || null,
  });

  return { notified: ctx.jakeEmail };
}

/**
 * Email the OPERATOR (Jake) asking for partner clarification. The pending-state
 * sidecar persists the partial extraction; when Jake replies with the company
 * name, the next-tick agent merges and routes to load_offer.
 *
 * POLICY: Info-requests NEVER go to external broker/franchise senders.
 *
 * Required payload: { subject, extracted, hints }
 */
async function action_clarify_partner(payload, ctx) {
  const { subject, extracted, hints, outerFrom, investigation_summary } = payload;
  const linesCount = Array.isArray(extracted && extracted.lines) ? extracted.lines.length : 0;
  const offerType = (extracted && extracted.offerType) || null;

  const extractedLinesHtml = formatExtractedLinesTable(extracted);

  let sidecarRecord = null;
  if (!ctx.dryRun && ctx.anchorMessageId) {
    sidecarRecord = pending.writeSidecar(ctx.workflow, ctx.anchorMessageId, {
      original_uid: ctx.uid,
      original_subject: subject || null,
      original_recipient: ctx.jakeEmail,
      external_sender: outerFrom || null,
      extracted: extracted || (ctx.pendingSidecar && ctx.pendingSidecar.extracted) || {},
      missing: ['partner'],
      hints: hints || null,
      investigation_summary: investigation_summary || null,
    });
  }

  const retryCount = sidecarRecord ? sidecarRecord.retry_count : 0;

  // Investigation summary block — shows agent reasoning. Parity with VQ UID 10064 fix.
  const investigationBlock = investigation_summary
    ? `<p><b>Agent investigation:</b></p><pre style="background:#eef6ff;padding:8px;white-space:pre-wrap;font-size:12px;border-left:3px solid #369">${esc(investigation_summary)}</pre>`
    : '';

  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">Broker Offers — partner clarification needed</h2>
<p><b>Subject:</b> ${esc(subject)}<br/>
   <b>External sender:</b> ${esc(outerFrom || '(unknown)')}<br/>
   <b>UID:</b> ${ctx.uid}<br/>
   <b>Inbox:</b> ${esc(ctx.inbox)}<br/>
   ${retryCount ? `<b>Retry:</b> ${retryCount}/2<br/>` : ''}
   <b>Offer type:</b> ${esc(offerType || '(to be determined)')}<br/>
   <b>Line count:</b> ${fmt(linesCount)}</p>
<p><b>Why partner didn't resolve:</b><br/>${esc(hints || '(no hints provided)')}</p>
${investigationBlock}
${extractedLinesHtml}
<p style="background:#f5f5f5;padding:10px;border-left:3px solid #b00">
   <b>Reply to ${esc(ctx.inbox)} with the company name</b> (one line is fine — e.g., <code>Partner is Future Electronics</code>). The next agent tick will merge your reply with the parsed lines and load the offer. Or use the structured directive: <code>PARTNER: ${ctx.uid} = &lt;BP search key OR company name&gt;</code>
</p>
<p style="color:#666;font-size:11px">To discard: reply with <code>SKIP</code>, <code>DROP</code>, <code>IGNORE</code>, or <code>DISCARD</code>.</p>
<p style="color:#666;font-size:11px">Message moved to NeedInfo folder. Sidecar: <code>~/workspace/.broker-offers-pending/${esc(ctx.anchorMessageId || '(no anchor)')}.json</code></p>
</body></html>`;

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_notify_jake: { subject, outerFrom, hints, linesCount },
      would_write_sidecar: { anchor: ctx.anchorMessageId, missing: ['partner'] },
    };
  }

  // Reply-To MUST be the broker-offers inbox — Jake's reply needs to land here
  // Email threading headers — escalation lands in same thread as original
  const opts = { html: true, replyTo: ctx.inbox };
  if (ctx.currentMessageId) {
    opts.inReplyTo = ctx.currentMessageId;
    const refs = Array.isArray(ctx.currentReferences) ? [...ctx.currentReferences] : [];
    if (!refs.includes(ctx.currentMessageId)) refs.push(ctx.currentMessageId);
    if (refs.length > 0) opts.references = refs;
  }

  await ctx.notifier.sendEmail(
    ctx.jakeEmail,
    `Broker Offers — clarify partner: ${subject || '(no subject)'}`,
    html,
    opts,
  );

  breadcrumbs.write({
    cog: 'broker-offers',
    event: 'escalated-clarify_partner',
    uid: ctx.uid,
    notified: ctx.jakeEmail,
    external_sender: outerFrom || null,
    subject,
    hints: hints || null,
    retry_count: retryCount,
    investigation_summary: investigation_summary || null,
  });

  return {
    notified: ctx.jakeEmail,
    sidecar_anchor: ctx.anchorMessageId,
    retry_count: retryCount,
  };
}

/**
 * Email operator diagnostic for manual triage.
 *
 * Required payload: { reason, subject, outerFrom }
 * Optional: { details }
 */
async function action_needs_review(payload, ctx) {
  const { reason, subject, outerFrom, details, investigation_summary } = payload;

  // Investigation summary block — shows agent reasoning. Parity with VQ UID 10064 fix.
  const investigationBlock = investigation_summary
    ? `<p><b>Agent investigation:</b></p><pre style="background:#eef6ff;padding:8px;white-space:pre-wrap;font-size:12px;border-left:3px solid #369">${esc(investigation_summary)}</pre>`
    : '';

  const html = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">Broker Offers — needs manual review</h2>
<p><b>Subject:</b> ${esc(subject)}<br/>
   <b>From:</b> ${esc(outerFrom)}<br/>
   <b>UID:</b> ${ctx.uid}</p>
<p><b>Reason:</b> ${esc(reason)}</p>
${investigationBlock}
${details ? `<pre style="background:#f5f5f5;padding:8px;white-space:pre-wrap;font-size:11px">${esc(details)}</pre>` : ''}
<p style="color:#666;font-size:11px">Message moved to NeedsReview folder.</p>
</body></html>`;

  if (ctx.dryRun) {
    return { dry_run: true, would_notify_jake: { reason } };
  }

  // Email threading headers — escalation lands in same thread as original
  const opts = { html: true };
  if (ctx.currentMessageId) {
    opts.inReplyTo = ctx.currentMessageId;
    const refs = Array.isArray(ctx.currentReferences) ? [...ctx.currentReferences] : [];
    if (!refs.includes(ctx.currentMessageId)) refs.push(ctx.currentMessageId);
    if (refs.length > 0) opts.references = refs;
  }

  await ctx.notifier.sendEmail(
    ctx.jakeEmail,
    `Broker Offers — needs review: ${subject || '(no subject)'}`,
    html,
    opts,
  );

  breadcrumbs.write({
    cog: 'broker-offers',
    event: 'escalated-needs_review',
    uid: ctx.uid,
    subject,
    outerFrom,
    reason,
    investigation_summary: investigation_summary || null,
  });

  return { notified: ctx.jakeEmail };
}

/**
 * Silent move — message is not an offer (junk, automation noise, OOO, bounce).
 *
 * Required payload: { reason }
 */
async function action_not_offer(payload, ctx) {
  if (ctx.dryRun) {
    return { dry_run: true, reason: payload.reason || 'unspecified' };
  }
  breadcrumbs.write({
    cog: 'broker-offers',
    event: 'not-offer',
    uid: ctx.uid,
    reason: payload.reason || 'unspecified',
  });
  return { reason: payload.reason || 'unspecified' };
}

/**
 * Operator-initiated discard of a pending escalation. Triggered when Jake
 * replies with SKIP/IGNORE/DROP/DISCARD.
 *
 * Required payload: { reason }
 */
async function action_drop_pending(payload, ctx) {
  if (ctx.dryRun) {
    return { dry_run: true, reason: payload.reason || 'operator-dropped' };
  }
  breadcrumbs.write({
    cog: 'broker-offers',
    event: 'operator-dropped',
    uid: ctx.uid,
    reason: payload.reason || 'operator-dropped',
    pending_kind: ctx.pendingSidecar && ctx.pendingSidecar.kind || null,
  });
  return { reason: payload.reason || 'operator-dropped' };
}

/**
 * Cross-forward duplicate detected.
 *
 * Required payload: { existingSearchKey }
 */
async function action_dup_skip(payload, ctx) {
  if (ctx.dryRun) {
    return { dry_run: true, existingSearchKey: payload.existingSearchKey };
  }
  breadcrumbs.write({
    cog: 'broker-offers',
    event: 'dup-skipped',
    uid: ctx.uid,
    existingOfferSearchKey: payload.existingSearchKey,
  });
  return { existingSearchKey: payload.existingSearchKey };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }

/**
 * Format extracted offer lines as an HTML table for operator decision-making.
 */
function formatExtractedLinesTable(extracted) {
  const lines = Array.isArray(extracted && extracted.lines) ? extracted.lines : [];
  if (lines.length === 0) {
    return '<p style="color:#666;font-style:italic">No lines extracted yet.</p>';
  }

  const rows = lines.slice(0, 15).map((ln, i) => {
    const mpn = ln.mpn || ln.MPN || '?';
    const mfr = ln.mfr || ln.MFR || '';
    const qty = ln.qty != null ? fmt(ln.qty) : '?';
    const price = ln.price != null ? `$${Number(ln.price).toFixed(4)}` : '';
    const dc = ln.dateCode || ln.dc || '';
    const coo = ln.coo || '';
    return `<tr style="background:${i % 2 === 0 ? '#fff' : '#f9f9f9'}">
      <td style="padding:4px 8px;border:1px solid #ddd;font-family:monospace">${esc(mpn)}</td>
      <td style="padding:4px 8px;border:1px solid #ddd">${esc(mfr)}</td>
      <td style="padding:4px 8px;border:1px solid #ddd;text-align:right">${esc(qty)}</td>
      <td style="padding:4px 8px;border:1px solid #ddd;text-align:right">${esc(price)}</td>
      <td style="padding:4px 8px;border:1px solid #ddd">${esc(dc)}</td>
      <td style="padding:4px 8px;border:1px solid #ddd">${esc(coo)}</td>
    </tr>`;
  }).join('');

  const truncateNote = lines.length > 15
    ? `<p style="color:#666;font-size:11px">Showing first 15 of ${fmt(lines.length)} extracted lines.</p>`
    : '';

  return `
<p style="margin-top:16px"><b>Extracted line data:</b></p>
<table style="border-collapse:collapse;font-size:12px;width:100%">
  <thead>
    <tr style="background:#e0e0e0">
      <th style="padding:4px 8px;border:1px solid #ddd;text-align:left">MPN</th>
      <th style="padding:4px 8px;border:1px solid #ddd;text-align:left">MFR</th>
      <th style="padding:4px 8px;border:1px solid #ddd;text-align:right">Qty</th>
      <th style="padding:4px 8px;border:1px solid #ddd;text-align:right">Price</th>
      <th style="padding:4px 8px;border:1px solid #ddd;text-align:left">DC</th>
      <th style="padding:4px 8px;border:1px solid #ddd;text-align:left">COO</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
${truncateNote}`;
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  inbox: 'brokeroffers@orangetsunami.com',
  notifierConfig: {
    fromEmail: 'brokeroffers@orangetsunami.com',
    fromName: 'Broker Offers',
  },
  actions: {
    load_offer: {
      folder: 'Processed',
      requires: ['bpartnerId', 'offerType', 'lines'],
      handler: action_load_offer,
    },
    needs_partner: {
      folder: 'NeedsPartner',
      requires: ['subject', 'outerFrom'],
      handler: action_needs_partner,
    },
    clarify_partner: {
      folder: 'NeedInfo',
      requires: ['subject', 'extracted'],
      keepsPending: true,
      handler: action_clarify_partner,
    },
    needs_review: {
      folder: 'NeedsReview',
      requires: ['reason'],
      handler: action_needs_review,
    },
    not_offer: {
      folder: 'NotOffer',
      requires: ['reason'],
      handler: action_not_offer,
    },
    dup_skip: {
      folder: 'Processed',
      requires: ['existingSearchKey'],
      handler: action_dup_skip,
    },
    drop_pending: {
      folder: 'NotOffer',
      requires: ['reason'],
      handler: action_drop_pending,
    },
  },
};
