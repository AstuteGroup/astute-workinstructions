/**
 * shared/workflow-actions/vq-loading.js
 *
 * Workflow module for VQ Loading. Consumed by shared/email-workflow-poller.js
 * when invoked with --workflow vq-loading.
 *
 * Inbox: vq@orangetsunami.com
 * Doc:   Trading Analysis/RFQ Sourcing/vq_loading/vq-loading.md
 *        Trading Analysis/RFQ Sourcing/vq_loading/agent-prompt.txt (runtime)
 *
 * Replaces the legacy two-step CSV pipeline (vq-parser fetch + manual
 * consolidation + CSV mass-upload). The agent reads each unseen email, runs
 * Two-Agent Validation (extractor → sub-Agent verifier → reconcile) per the
 * .md, and routes via the actions below.
 *
 * NO large-payload gate by design: VQ writes are local to OT — no external
 * API quota at risk, cost of over-load is bounded (deactivate lines). The
 * verifier pass is the safety net for "extractor hallucinated 200 quotes
 * from a 5-quote email" failure mode.
 *
 * Pattern reference: shared/workflow-actions/stockrfq.js (closest structural
 * sibling — vendor BP resolution, breadcrumb writes, clarify round-trip).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { loadBulkSummary } = require('../load-bulk-summary');
const { isKnownBuyer, isKnownSupport, resolveBuyerFromRegistry } = require('../partner-lookup');
const pending = require('../workflow-pending-state');
const breadcrumbs = require('../breadcrumbs');
const writerAttribution = require('../writer-attribution');
const { notifyHighFailureRate } = require('../failure-rate-gate');

const JAKE_USER_ID = 1000004;

// Per-VQ attribution log. Each successful chuboe_vq_line write appends one
// JSONL row tying the new vqLineId to the source email's UID + Message-ID.
// Used by the daily digest for precise per-batch "claimed vs active in OT"
// reconciliation — replaces the load-time-window heuristic that leaked
// across batches when multiple loads hit the same RFQ.
const VQ_ATTRIBUTION_LOG = path.join(
  process.env.HOME || '/home/analytics_user',
  'workspace',
  '.vq-batch-attribution.jsonl',
);

function appendAttribution(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  try {
    const lines = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.appendFileSync(VQ_ATTRIBUTION_LOG, lines);
  } catch (_) { /* log path is best-effort; never fail the load on a log write */ }
}

// ─── HANDLERS ────────────────────────────────────────────────────────────────

/**
 * Write a batch of supplier quotes to OT via loadBulkSummary. Same path for
 * Type 1 (single-vendor) and Type 2 (bulk-summary) — the agent normalizes
 * both shapes into the quotes[] array before routing.
 *
 * Supports multi-RFQ fan-out: if the same broker quote matches multiple
 * active RFQs (and at least one is within the agent's 30-day fan-out window),
 * the agent passes secondaryRfqSearchKeys[] and the handler writes the SAME
 * quotes to each. One inbound email → N VQs across N RFQs.
 *
 * Required payload:
 *   rfqSearchKey  ('1132932', etc. — RFQ.value, NOT chuboe_rfq_id). Primary
 *                  target — the most recent active RFQ matching the MPN.
 *   buyerId       (AD_User_ID of the Astute employee who DID the sourcing
 *                  work — for Type 1 this is the outer forwarder; for Type 2
 *                  it's the person who compiled the summary, NOT the
 *                  forwarder. See vq-loading.md "Buyer Field" section.)
 *   quotes[]      [{ vendorName | vendorSearchKey, mpn, mfr, qty, cost,
 *                    leadTime?, dateCode?, coo?, packaging?, rohs?,
 *                    vendorNotes?, vendorQuotedMpn? }, ...]
 *
 * Optional:
 *   secondaryRfqSearchKeys  Array of additional RFQ.value strings — other
 *                  active RFQs matching the MPN within the agent's 30-day
 *                  window. Same quotes get written to each. Omit / pass []
 *                  for single-RFQ writes.
 *   sourceUid       (for breadcrumb traceability — usually ctx.uid is enough)
 *   messageId       (the source email's RFC822 Message-ID; pass it through
 *                    so a future CQ/PO breadcrumb-grep can link the buy back
 *                    to the originating broker quote email.)
 *   senderEmail     (the deepest-quoted broker From: address, e.g.,
 *                    "sales@howeher.com". For Type 2 bulk summaries this is
 *                    Astute-internal; for Type 1 it's the actual vendor.
 *                    Stored on the breadcrumb for audit.)
 *   senderDomain    (pre-extracted convenience for breadcrumb grep)
 *   brokerMessageId (the broker's ORIGINAL Message-ID — deepest non-Astute,
 *                    non-Outlook-server MID. Same rationale as stockrfq —
 *                    Outlook stamps a new MID at auto-forward; the broker's
 *                    original lives in References. See memory
 *                    reference_brokermessageid_vs_outlook_mid.md)
 *   emailType       ('type1' | 'type2' — observability only, doesn't change
 *                    write logic; loadBulkSummary handles both uniformly)
 *   clarifications  Multi-vendor partial-load: array of { vendorLabel, asks[] }
 *                  for vendors whose quotes couldn't be loaded cleanly. The
 *                  clean quotes still load; after the load, a single
 *                  consolidated email goes to the sender (CC operator)
 *                  asking about all the problematic vendors in one place.
 *                  Sidecar (kind='partial_clarify') holds the outstanding
 *                  state for next-tick reply-stitching.
 *
 *                  Shape (each section optionally carries pendingQuotes — the
 *                  partial quote stubs the agent already extracted, missing
 *                  only the fields in asks[]. Persisting these means the
 *                  reply-tick agent merges the broker's answers into a
 *                  structured stub instead of re-extracting from email body):
 *                    [
 *                      { vendorLabel: 'Acme Trading',
 *                        asks: ['Confirm unit price for MPN XYZ-123',
 *                               'Date code for SKU 456?'],
 *                        pendingQuotes: [
 *                          { mpn: 'XYZ-123', mfr: 'TI', qty: 1000,
 *                            vendorName: 'Acme Trading',
 *                            cost: null, dateCode: null }
 *                        ]
 *                      },
 *                      { vendorLabel: 'Bingo Brokers',
 *                        asks: ['Qty offered for MPN ABC?'],
 *                        pendingQuotes: [
 *                          { mpn: 'ABC', mfr: 'STM', cost: 0.42,
 *                            vendorName: 'Bingo Brokers', qty: null }
 *                        ]
 *                      }
 *                    ]
 *
 *                  Omit / pass [] when everything loaded cleanly.
 */
async function action_load_vq(payload, ctx) {
  const {
    rfqSearchKey, secondaryRfqSearchKeys, buyerId, quotes,
    sourceUid, messageId, senderEmail, senderDomain, brokerMessageId,
    emailType, clarifications, subject, outerFrom,
    bypassRegistryValidation,
  } = payload;

  // Build the full target list — primary first, then secondaries. Dedup in
  // case the agent included the primary in secondaries by accident.
  const seen = new Set();
  const targets = [];
  for (const key of [rfqSearchKey, ...(Array.isArray(secondaryRfqSearchKeys) ? secondaryRfqSearchKeys : [])]) {
    if (!key || seen.has(String(key))) continue;
    seen.add(String(key));
    targets.push(String(key));
  }

  const clarifPreview = Array.isArray(clarifications)
    ? clarifications.filter(c => c && c.vendorLabel && Array.isArray(c.asks) && c.asks.length > 0)
    : [];

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_load: {
        targets,
        primary: rfqSearchKey,
        secondaryCount: targets.length - 1,
        buyerId,
        quoteCount: (quotes || []).length,
        emailType: emailType || null,
      },
      would_clarify: clarifPreview.length > 0 ? {
        sectionCount: clarifPreview.length,
        sections: clarifPreview.map(c => ({ vendorLabel: c.vendorLabel, askCount: c.asks.length })),
      } : null,
    };
  }

  // ─── Buyer registry validation ─────────────────────────────────────────────
  // Source of truth: shared/data/user-role-registry.json. If the agent-proposed
  // buyerId is not in the buyers list, do NOT write — escalate to operator so
  // they can either add the user to the registry OR specify the correct buyer.
  // See deferred-work.md § "VQ buyer-resolution: implement role-registry
  // fallback ladder" for the full design.
  const buyerCheck = bypassRegistryValidation
    ? { buyer: buyerId, source: 'operator_override', reason: 'bypassRegistryValidation flag set (operator reply to clarify_buyer)', escalate: false }
    : resolveBuyerFromRegistry({
        candidateUserId: buyerId,
        citedRfq: rfqSearchKey,
      });
  if (buyerCheck.escalate) {
    breadcrumbs.write({
      cog: 'vq-loading-agent',
      event: 'escalated-buyer-unknown',
      uid: ctx.uid,
      subject,
      outerFrom: outerFrom || senderEmail,
      proposed_buyer_id: buyerId,
      rfq: rfqSearchKey,
      secondary_rfqs: secondaryRfqSearchKeys,
      quote_count: (quotes || []).length,
      reason: buyerCheck.reason,
    });
    const askDetails = [
      `Agent-proposed buyerId: ${buyerId || '(none)'}`,
      `Tier-A candidate role: ${isKnownSupport(buyerId) ? 'support (Ivy/Gopal/Lathis pattern)' : (buyerId ? 'unknown (not in buyer or support registry)' : 'no candidate')}`,
      `Primary RFQ: ${rfqSearchKey}`,
      secondaryRfqSearchKeys && secondaryRfqSearchKeys.length ? `Secondary RFQs: ${secondaryRfqSearchKeys.join(', ')}` : null,
      `Quote count: ${(quotes || []).length}`,
      `Sender (outer): ${outerFrom || senderEmail || '(unknown)'}`,
      '',
      'To resolve:',
      '  1. If the proposed user IS a buyer → add them to shared/data/user-role-registry.json under "buyers" and replay the email.',
      '  2. If the correct buyer is someone else → reply to this email with the buyer name/email and the agent will re-route.',
      '  3. If this load should not happen → move the email to NoBid / NeedsReview / Deleted Items.',
    ].filter(Boolean).join('\n');
    return await action_clarify_buyer({
      reason: `Buyer not in registry — ${buyerCheck.reason}`,
      subject: subject || '(no subject)',
      outerFrom: outerFrom || senderEmail,
      senderEmail: null, // operator-routed only
      proposedBuyerId: buyerId,
      rfqSearchKey,
      secondaryRfqSearchKeys,
      quotes,
      details: askDetails,
      investigation_summary: `Buyer-registry check: ${buyerCheck.reason}`,
    }, ctx);
  }

  // buyerCheck.buyer is the validated buyer ID. Use it from here on (may
  // differ from the original payload buyerId in future ladder versions).
  const validatedBuyerId = buyerCheck.buyer;

  const derivedDomain = senderDomain
    || (senderEmail && senderEmail.includes('@')
        ? senderEmail.split('@')[1].toLowerCase()
        : null);

  const perRfqResults = [];
  let totals = { rfqsWritten: 0, vqsWritten: 0, vqsSkipped: 0, vqsFailed: 0 };

  for (const targetKey of targets) {
    let result;
    try {
      result = await loadBulkSummary({
        rfqSearchKey: targetKey,
        buyerId: validatedBuyerId,
        quotes,
      });
    } catch (err) {
      breadcrumbs.write({
        cog: 'vq-loading-agent',
        event: 'load-failed',
        uid: ctx.uid,
        rfqSearchKey: targetKey,
        quoteCount: (quotes || []).length,
        error: err.message,
      });
      perRfqResults.push({
        rfqSearchKey: targetKey,
        error: err.message,
        written: 0, skipped: 0, failed: (quotes || []).length,
      });
      totals.vqsFailed += (quotes || []).length;
      continue;
    }

    breadcrumbs.write({
      cog: 'vq-loading-agent',
      event: 'loaded',
      uid: ctx.uid,
      sourceUid: sourceUid || ctx.uid,
      messageId: messageId || null,
      brokerMessageId: brokerMessageId || null,
      senderEmail: senderEmail ? senderEmail.toLowerCase() : null,
      senderDomain: derivedDomain,
      // outerFrom (envelope From of the email that hit vq@) is distinct from
      // senderEmail (the DEEPER Tier-A actor — e.g., when Ivy forwards Serena's
      // quotes the outerFrom is Ivy and senderEmail resolves to Serena).
      // Per-loader digests (ivy-vq-digest.js et al.) join on this. Was missing
      // pre-2026-05-21; back-compat handled by digest's IMAP fallback.
      outerFrom: outerFrom ? outerFrom.toLowerCase() : null,
      rfqSearchKey: targetKey,
      isPrimary: targetKey === rfqSearchKey,
      buyerId: validatedBuyerId,
      emailType: emailType || null,
      quotesSubmitted: (quotes || []).length,
      written: result.written.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
      coverageHit: result.coverage.length - result.gaps.length,
      coverageTotal: result.coverage.length,
      gaps: result.gaps,
      // Watchlist signal: when this load was driven by a sidecar reply
      // (need_info / clarify / needs_vendor / partial_clarify resolution),
      // record the kind so the watchlist scanner can surface milestones like
      // "first partial_clarify stitch in production."
      stitched_from: (ctx.pendingSidecar && ctx.pendingSidecar.kind) || null,
    });

    perRfqResults.push({
      rfqSearchKey: targetKey,
      written: result.written.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
      gaps: result.gaps,
      writtenDetails: result.written,    // ← was missing pre-2026-05-20; needed for digest reconciliation
      skippedDetails: result.skipped,
      failedDetails: result.failed,
    });

    // Per-VQ attribution: append a JSONL row for each newly-written VQ tying
    // its vqLineId back to this batch (sourceUid + messageId). See header for
    // rationale + digest consumption.
    if (Array.isArray(result.written) && result.written.length > 0) {
      const nowIso = new Date().toISOString();
      const attribRows = result.written
        .filter(w => w && w.vqLineId)
        .map(w => ({
          ts: nowIso,
          sourceUid: sourceUid || ctx.uid,
          messageId: messageId || null,
          outerFrom: outerFrom ? outerFrom.toLowerCase() : null,
          vqLineId: w.vqLineId,
          rfqValue: targetKey,
          rfqLineNo: w.line || null,
          vendor: w.vendor || null,
          mpn: w.mpn || null,
          cost: w.cost != null ? w.cost : null,
          qty: w.qty != null ? w.qty : null,
          buyerId: validatedBuyerId,
        }));
      appendAttribution(attribRows);
    }

    // Per-row failure + skip attribution. Companion to the breadcrumb COUNT
    // summary — captures the writer's per-quote reason+detail to disk so
    // post-mortems do not need an agent replay. See shared/writer-attribution.js
    // header; primary trigger was Ivy 5/21 UID 8541 where 73 "failed" carried
    // detail='unknown' and we could not tell why each fell over.
    writerAttribution.persistWriterDetails({
      workflow: 'vq-loading',
      ctx,
      result,
    });

    // Rate-based escalation gate. If the batch came back with an unhealthy
    // failure rate (writer-side) or non-dup-skip rate (resolver gap),
    // breadcrumb the signal and ping the operator immediately. See
    // shared/failure-rate-gate.js header — Ivy UID 8541's silent-fail-for-24h
    // is exactly the case this defends against.
    await notifyHighFailureRate({
      cog: 'vq-loading-agent',
      workflow: 'VQ Loading',
      ctx,
      target: targetKey,
      result,
    });

    if (result.written.length > 0) totals.rfqsWritten += 1;
    totals.vqsWritten += result.written.length;
    totals.vqsSkipped += result.skipped.length;
    totals.vqsFailed += result.failed.length;
  }

  const primary = perRfqResults[0] || null;
  const secondaries = perRfqResults.slice(1);

  // Partial-load consolidated clarification: agent loaded the clean vendors,
  // now fire ONE email asking sender (CC operator) about everything else.
  let clarifList = Array.isArray(clarifications)
    ? clarifications.filter(c => c && c.vendorLabel && Array.isArray(c.asks) && c.asks.length > 0)
    : [];

  // Suppress clarify sections for vendors the writer already resolved.
  //
  // Why: the agent's clarify decision and the writer's resolution decision
  // run independently. The agent might flag "Savilter" as unknown while the
  // writer's resolveBP (or the historical-VQ fallback added 2026-05-22)
  // successfully fuzzy-matches it to "Saviliter Technology Co., Ltd" and
  // writes the row. Without this filter, the operator gets a clarify email
  // asking about a vendor that's already in OT — confusing and burns trust.
  //
  // Surfaced via UID 8563 (Ivy 5/22 RFQ 1135078): "Savilter" was
  // simultaneously written as Saviliter AND included in the clarify list.
  //
  // Strategy: every quote the agent submitted carries vendorName/
  // vendorSearchKey — those are the SAME label strings the agent used to
  // build clarifications[]. The writer preserves the agent's original label
  // on each written row (originalVendorLabel) and the writer's skipped[]
  // entries spread `...q` so vendorName survives. We exact-match the
  // clarify section's vendorLabel against those preserved labels — no
  // fuzzy comparison needed, no risk of false-positive suppression on
  // unrelated vendors with similar names.
  if (clarifList.length > 0) {
    const norm = s => String(s || '').toLowerCase().trim();
    const resolvedLabels = new Set();   // exact agent labels that loaded OR pre-existed
    for (const r of perRfqResults) {
      for (const w of r.writtenDetails || []) {
        if (w.originalVendorLabel) resolvedLabels.add(norm(w.originalVendorLabel));
      }
      for (const s of r.skippedDetails || []) {
        if (s.reason !== 'PRE_EXISTING_DUPLICATE') continue;
        // skipped entries spread the original quote, so vendorName /
        // vendorSearchKey are the agent's labels verbatim.
        if (s.vendorName)      resolvedLabels.add(norm(s.vendorName));
        if (s.vendorSearchKey) resolvedLabels.add(norm(s.vendorSearchKey));
      }
    }

    const suppressed = [];
    const remaining = [];
    for (const c of clarifList) {
      const lbl = norm(c.vendorLabel);
      if (lbl && resolvedLabels.has(lbl)) {
        suppressed.push({ vendorLabel: c.vendorLabel, askCount: c.asks.length });
      } else {
        remaining.push(c);
      }
    }

    if (suppressed.length > 0) {
      breadcrumbs.write({
        cog: 'vq-loading-agent',
        event: 'clarify-suppressed-already-loaded',
        uid: ctx.uid,
        sourceUid: sourceUid || ctx.uid,
        messageId: messageId || null,
        primary_rfq: rfqSearchKey,
        suppressed_count: suppressed.length,
        suppressed_sections: suppressed,
        remaining_count: remaining.length,
      });
    }
    clarifList = remaining;
  }
  // Derive loaded_vendors from the input quotes: any distinct vendor label
  // that appeared in the quotes[] is one the agent meant to load this tick.
  // Reply-tick agent uses this as the "DO NOT touch these on the reply" set.
  // Pre-write dedup (step 3.9) is the backstop if this set drifts.
  const loadedVendorLabels = [];
  const seenVendorLabels = new Set();
  for (const q of quotes || []) {
    const labels = [q.vendorName, q.vendorSearchKey, q.vendor]
      .filter(Boolean)
      .map(s => String(s).trim());
    for (const lbl of labels) {
      const key = lbl.toLowerCase();
      if (seenVendorLabels.has(key)) continue;
      seenVendorLabels.add(key);
      loadedVendorLabels.push(lbl);
    }
  }

  let clarifyResult = null;
  if (clarifList.length > 0) {
    clarifyResult = await sendPartialClarify(
      {
        ...payload,
        clarifications: clarifList,
        vqsWritten: totals.vqsWritten,
        rfqsWritten: totals.rfqsWritten,
        loaded_vendors: loadedVendorLabels,
      },
      ctx,
    );
  } else if (!ctx.dryRun && ctx.anchorMessageId) {
    // No clarifications — load_vq is keepsPending=true so the partial-clarify
    // sidecar can survive when needed; we must explicitly clear any existing
    // sidecar (e.g., a need_info_vendor sidecar that this load resolved).
    // No-op if no sidecar exists.
    pending.clearSidecar(ctx.workflow, ctx.anchorMessageId);
  }

  // Post-load notice when operator overrode buyer-registry validation with a
  // user who ISN'T yet in the registry. Per 2026-05-20 policy: the load
  // proceeds, but operator gets a one-off "consider adding to registry"
  // ping so they can decide whether the buyer is a one-off or a recurring
  // colleague worth registering. Fires only when (a) validation was bypassed
  // AND (b) the resolved buyer is not in the buyers registry. Idempotent —
  // re-running the same payload re-sends the same notice (harmless).
  if (!ctx.dryRun && bypassRegistryValidation && validatedBuyerId && !isKnownBuyer(validatedBuyerId)) {
    try {
      let buyerName = String(validatedBuyerId);
      try {
        const { execSync } = require('child_process');
        const out = execSync(`psql -t -A -c "SELECT name FROM adempiere.ad_user WHERE ad_user_id = ${Number(validatedBuyerId)}"`, { encoding: 'utf8' });
        if (out.trim()) buyerName = out.trim();
      } catch (_) { /* fall back to ID */ }
      const noticeHtml = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h3 style="color:#2a5">VQ Loading — Loaded with non-registry buyer</h3>
<p>Per your reply, loaded <b>${totals.vqsWritten}</b> VQs across <b>${totals.rfqsWritten}</b> RFQ${totals.rfqsWritten === 1 ? '' : 's'} with <b>${esc(buyerName)}</b> (id=${esc(String(validatedBuyerId))}) as the buyer.</p>
<p><b>${esc(buyerName)} is not currently in</b> <code>shared/data/user-role-registry.json</code> under "buyers".</p>
<p>If they'll be loading or owning RFQs ongoing, add them to the registry so future loads don't re-trigger a clarify. If this was a one-off, no action needed.</p>
<p style="color:#666;font-size:11px">Subject: ${esc(subject || '(no subject)')}<br/>UID: ${ctx.uid}<br/>Primary RFQ: ${esc(rfqSearchKey || '?')}</p>
</body></html>`;
      await ctx.notifier.sendEmail(
        ctx.jakeEmail,
        `VQ Loading — Loaded with non-registry buyer: ${buyerName}`,
        noticeHtml,
        { html: true },
      );
      breadcrumbs.write({
        cog: 'vq-loading-agent',
        event: 'non-registry-buyer-notice',
        uid: ctx.uid,
        buyer_id: validatedBuyerId,
        buyer_name: buyerName,
        rfq: rfqSearchKey,
        vqs_written: totals.vqsWritten,
      });
    } catch (e) {
      // Notice failure is not load-fatal — log and move on.
      breadcrumbs.write({
        cog: 'vq-loading-agent',
        event: 'non-registry-buyer-notice-failed',
        uid: ctx.uid,
        error: e.message,
      });
    }
  }

  return {
    primaryResult: primary,
    secondaryResults: secondaries,
    totals,
    clarify: clarifyResult,
  };
}

/**
 * Consolidated multi-vendor clarification — fired from action_load_vq when
 * clarifications[] is present (partial-load pattern). Single email lists the
 * successfully loaded vendors + per-vendor outstanding questions for the
 * problematic ones. Sidecar (kind='partial_clarify') persists the outstanding
 * asks so the next tick can stitch the reply.
 */
async function sendPartialClarify(payload, ctx) {
  const {
    clarifications, subject, outerFrom, rfqSearchKey,
    vqsWritten, rfqsWritten, extracted, loaded_vendors,
    buyerId, secondaryRfqSearchKeys,
  } = payload;

  // Normalize clarifications[]: each section may carry an optional
  // pendingQuotes[] — structured partial quote stubs the agent already
  // extracted, missing only the fields named in asks[]. Persisting these
  // means the reply-tick agent doesn't need to re-extract from the email
  // body to figure out what to merge the answers into.
  const normalizedClarifications = clarifications.map(c => ({
    vendorLabel: c.vendorLabel,
    asks: c.asks,
    pendingQuotes: Array.isArray(c.pendingQuotes) ? c.pendingQuotes : [],
  }));

  let sidecarRecord = null;
  if (!ctx.dryRun && ctx.anchorMessageId) {
    sidecarRecord = pending.writeSidecar(ctx.workflow, ctx.anchorMessageId, {
      original_uid: ctx.uid,
      original_subject: subject || null,
      original_recipient: ctx.jakeEmail,
      external_sender: outerFrom || null,
      rfq_search_key: rfqSearchKey || null,
      secondary_rfq_search_keys: Array.isArray(secondaryRfqSearchKeys) ? secondaryRfqSearchKeys : [],
      buyer_id: buyerId || null,
      vqs_already_written: vqsWritten || 0,
      rfqs_already_written: rfqsWritten || 0,
      loaded_vendors: Array.isArray(loaded_vendors) ? loaded_vendors : [],
      extracted: extracted || {},
      clarifications: normalizedClarifications,
      kind: 'partial_clarify',
    });
  }

  const envelope = resolveOutreachRecipients(payload, ctx);

  const sections = clarifications.map(c => {
    const asksList = c.asks.map(a => `<li>${esc(a)}</li>`).join('');
    return `<div style="margin:10px 0 14px 0;padding:8px 12px;border-left:3px solid #b58900;background:#fffdf5">
  <b>${esc(c.vendorLabel)}</b>
  <ul style="margin:6px 0 0 0">${asksList}</ul>
</div>`;
  }).join('');

  const senderHtml = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<p>Hello,</p>
<p>Thanks for your quote${vqsWritten ? ` — we successfully logged ${vqsWritten} quote line${vqsWritten === 1 ? '' : 's'}` : ''}. We hit some gaps for the items below — could you reply with the missing details?</p>
${sections}
<p>Just reply to this email; your answers route directly back to our quote-loading system.</p>
<p>Thanks,<br/>Astute Electronics — VQ Loading</p>
<p style="color:#999;font-size:11px;border-top:1px solid #eee;padding-top:8px">Reference: ${esc(subject || '(no subject)')}</p>
</body></html>`;

  const operatorHtml = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b58900">VQ Loading — partial load + clarifications</h2>
<p><b>Subject:</b> ${esc(subject)}<br/>
   <b>External sender:</b> ${esc(envelope.senderUsed || outerFrom || '(unknown)')}<br/>
   <b>UID:</b> ${ctx.uid}<br/>
   <b>VQs written (this email):</b> ${vqsWritten || 0}<br/>
   <b>Outstanding vendor sections:</b> ${clarifications.length}</p>
${sections}
<p style="background:#fff3cd;padding:10px;border-left:3px solid #b58900">
   Sender was asked these questions directly (you're on CC). Reply to ${esc(ctx.inbox)} from either side and the next tick will stitch.
</p>
<p style="color:#666;font-size:11px">Sidecar: <code>~/workspace/.vq-loading-pending/${esc(ctx.anchorMessageId || '(no anchor)')}.json</code></p>
</body></html>`;

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_email: { to: envelope.to, cc: envelope.cc, senderUsed: envelope.senderUsed },
      would_write_sidecar: {
        anchor: ctx.anchorMessageId,
        kind: 'partial_clarify',
        loaded_vendors: Array.isArray(loaded_vendors) ? loaded_vendors : [],
        clarifications: normalizedClarifications.map(c => ({
          vendorLabel: c.vendorLabel,
          askCount: c.asks.length,
          pendingQuoteCount: c.pendingQuotes.length,
        })),
      },
    };
  }

  await ctx.notifier.sendEmail(
    envelope.to,
    `VQ Loading — clarifications needed: ${subject || '(no subject)'}`,
    envelope.senderUsed ? senderHtml : operatorHtml,
    { html: true, replyTo: ctx.inbox, cc: envelope.cc || undefined },
  );

  breadcrumbs.write({
    cog: 'vq-loading-agent',
    event: 'escalated-partial_clarify',
    uid: ctx.uid,
    sectionCount: clarifications.length,
    sender_emailed: envelope.senderUsed || null,
    cc_operator: !!envelope.cc,
  });

  return {
    notified: envelope.to,
    cc: envelope.cc || null,
    sender_emailed: envelope.senderUsed || null,
    sidecar_anchor: ctx.anchorMessageId,
    section_count: clarifications.length,
  };
}

/**
 * Email asking for missing fields (qty, price, MFR, etc.) when the
 * extractor + verifier agreed the quote is intentional but incomplete.
 *
 * ROUTING (VQ-specific override of the operator-only policy in
 * feedback_info_requests_go_to_operator_not_origin.md): TO=broker sender,
 * CC=Jake. The broker is the one who can answer "what's the qty?" — Jake
 * needs visibility on the ask + the answer. Reply-To stays vq@ so the
 * reply round-trips and the sidecar-stitch path picks it up next tick.
 * Falls back to operator-only when senderEmail isn't usable.
 *
 * Required payload: { missing[] }
 * Optional / accepted: { subject, extracted, outerFrom, senderEmail, recipient }
 *   senderEmail  preferred outreach target (deepest non-Astute broker)
 *   outerFrom    fallback if senderEmail absent
 *   recipient    IGNORED — kept for prompt back-compat with stockrfq pattern
 *   extracted    partial parse (RFQ #, line items so far) — persisted to sidecar
 *                for the merge on the reply
 */
async function action_need_info_vendor(payload, ctx) {
  const { missing, subject, extracted, outerFrom, senderEmail, investigation_summary } = payload;
  const missingList = Array.isArray(missing) ? missing : [];
  const quotesParsed = Array.isArray(extracted && extracted.quotes) ? extracted.quotes.length : 0;

  let sidecarRecord = null;
  if (!ctx.dryRun && ctx.anchorMessageId) {
    sidecarRecord = pending.writeSidecar(ctx.workflow, ctx.anchorMessageId, {
      original_uid: ctx.uid,
      original_subject: subject || null,
      original_recipient: ctx.jakeEmail,
      external_sender: outerFrom || null,
      extracted: extracted || (ctx.pendingSidecar && ctx.pendingSidecar.extracted) || {},
      missing: missingList,
      kind: 'need_info_vendor',
      investigation_summary: investigation_summary || null,
    });
  }
  const envelope = resolveOutreachRecipients(payload, ctx);
  if (!ctx.dryRun) {
    breadcrumbs.write({
      cog: 'vq-loading-agent',
      event: 'escalated-need_info_vendor',
      uid: ctx.uid,
      missing: missingList,
      investigation_summary: investigation_summary || null,
      sender_emailed: envelope.senderUsed || null,
      cc_operator: !!envelope.cc,
    });
  }

  const retryCount = sidecarRecord ? sidecarRecord.retry_count : 0;
  const missingItemsSender = missingList.map(m => `<li>${esc(missingLabelForSender(m))}</li>`).join('');
  const missingItemsOperator = missingList.map(m => `<li>${esc(missingLabel(m))}</li>`).join('');

  // Sender-facing (outreach mode) — friendly, no internal jargon, no sidecar paths.
  const senderHtml = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<p>Hello,</p>
<p>Thanks for your quote — we're working to log it in our system, but we're missing a few details before we can finalize:</p>
<ul>${missingItemsSender || '<li>(see note below)</li>'}</ul>
<p>Could you reply to this email with the missing information? Your reply will route directly back to our quote-loading system.</p>
<p>Thanks,<br/>Astute Electronics — VQ Loading</p>
<p style="color:#999;font-size:11px;border-top:1px solid #eee;padding-top:8px">Reference: ${esc(subject || '(no subject)')}</p>
</body></html>`;

  // Operator-facing (fallback or for the operator's own copy via CC).
  const operatorHtml = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">VQ Loading — info needed</h2>
<p><b>Subject:</b> ${esc(subject)}<br/>
   <b>External sender:</b> ${esc(envelope.senderUsed || outerFrom || '(unknown)')}<br/>
   <b>UID:</b> ${ctx.uid}<br/>
   <b>Inbox:</b> ${esc(ctx.inbox)}<br/>
   ${retryCount ? `<b>Retry:</b> ${retryCount}/2<br/>` : ''}
   <b>Quotes parsed so far:</b> ${quotesParsed}</p>
<p><b>Missing fields:</b></p>
<ul>${missingItemsOperator || '<li>(none specified)</li>'}</ul>
<p style="background:#f5f5f5;padding:10px;border-left:3px solid #b00">
   <b>Reply to ${esc(ctx.inbox)} with the missing values</b> — the next agent tick will merge your answers with the parsed quotes and load the VQs.
</p>
<p style="color:#666;font-size:11px">To discard instead of answering: reply with <code>SKIP</code>, <code>DROP</code>, <code>IGNORE</code>, or <code>DISCARD</code> on the first line. The next tick will move this to NotOffer and clear the pending state.</p>
<p style="color:#666;font-size:11px">Message moved to NeedInfo folder. Sidecar: <code>~/workspace/.vq-loading-pending/${esc(ctx.anchorMessageId || '(no anchor)')}.json</code></p>
</body></html>`;

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_email: { to: envelope.to, cc: envelope.cc, senderUsed: envelope.senderUsed },
      would_write_sidecar: { anchor: ctx.anchorMessageId, extracted, missing: missingList },
    };
  }
  await ctx.notifier.sendEmail(
    envelope.to,
    `VQ Loading — needs info: ${subject || '(no subject)'}`,
    envelope.senderUsed ? senderHtml : operatorHtml,
    { html: true, replyTo: ctx.inbox, cc: envelope.cc || undefined },
  );
  return {
    notified: envelope.to,
    cc: envelope.cc || null,
    sender_emailed: envelope.senderUsed || null,
    sidecar_anchor: ctx.anchorMessageId,
    retry_count: retryCount,
  };
}

function missingLabel(key) {
  switch (key) {
    case 'qty':           return 'Quantity — vendor didn\'t state offered qty';
    case 'cost':          return 'Unit cost — vendor didn\'t state price';
    case 'mfr':           return 'Manufacturer — needed for the right alt';
    case 'mpn':           return 'MPN — couldn\'t extract a part number';
    case 'rfq_number':    return 'RFQ # — couldn\'t resolve which RFQ this quote is for';
    case 'buyer':         return 'Buyer (Astute sourcer) — ambiguous in forward chain';
    case 'date_code':     return 'Date code — vendor quote didn\'t include it';
    default:              return key;
  }
}

/**
 * Vendor BP is ambiguous. The OPERATOR is the one who picks the BP (the sender
 * can't know which internal BP record to use) — but we still email the sender
 * (CC operator) asking them to confirm their company identity. The operator
 * then picks the BP using both the sender's confirmation and the candidate list.
 *
 * keepsPending: sidecar holds the partial extraction so the operator's pick
 * stitches on the next tick.
 *
 * Required payload: { candidates[] }   // [{ bpartnerId, searchKey, name, reason }, ...]
 * Optional: { subject, extracted, outerFrom, senderEmail, vendorName, vendorEmail }
 */
async function action_clarify_vendor(payload, ctx) {
  const { candidates, subject, extracted, outerFrom, senderEmail, vendorName, vendorEmail, investigation_summary } = payload;
  const candidateList = Array.isArray(candidates) ? candidates : [];

  let sidecarRecord = null;
  if (!ctx.dryRun && ctx.anchorMessageId) {
    sidecarRecord = pending.writeSidecar(ctx.workflow, ctx.anchorMessageId, {
      original_uid: ctx.uid,
      original_subject: subject || null,
      original_recipient: ctx.jakeEmail,
      external_sender: outerFrom || null,
      vendor_name: vendorName || null,
      vendor_email: vendorEmail || null,
      extracted: extracted || (ctx.pendingSidecar && ctx.pendingSidecar.extracted) || {},
      candidates: candidateList,
      kind: 'clarify_vendor',
      investigation_summary: investigation_summary || null,
    });
  }
  const envelope = resolveOutreachRecipients(payload, ctx);
  if (!ctx.dryRun) {
    breadcrumbs.write({
      cog: 'vq-loading-agent',
      event: 'escalated-clarify_vendor',
      uid: ctx.uid,
      candidateCount: candidateList.length,
      vendorName: vendorName || null,
      investigation_summary: investigation_summary || null,
      sender_emailed: envelope.senderUsed || null,
      cc_operator: !!envelope.cc,
    });
  }

  const retryCount = sidecarRecord ? sidecarRecord.retry_count : 0;
  const rows = candidateList.map((c, i) =>
    `<tr><td style="padding:3px 14px 3px 0">${i + 1}.</td>` +
    `<td style="padding:3px 14px 3px 0"><code>${esc(c.searchKey || c.bpartnerId)}</code></td>` +
    `<td style="padding:3px 14px 3px 0">${esc(c.name || '(unnamed)')}</td>` +
    `<td style="color:#666;font-size:12px">${esc(c.reason || '')}</td></tr>`
  ).join('');

  // Sender-facing list — names only, no search keys / match reasons.
  const senderCandidateRows = candidateList.map((c, i) =>
    `<li><b>${esc(c.name || '(unnamed)')}</b></li>`
  ).join('');

  const senderHtml = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<p>Hello,</p>
<p>Thanks for your quote. Before we log it, we need to confirm which company you're quoting on behalf of. We have a few records that could match — could you confirm which one (or none)?</p>
<ul>${senderCandidateRows || '<li>(no candidates listed)</li>'}</ul>
<p>If none of these is your company, please reply with:</p>
<ul>
  <li>Your legal company name</li>
  <li>Company website</li>
  <li>A short description of the relationship (authorized distributor, broker, OEM, etc.)</li>
</ul>
<p>Reply to this email and your answer will route back to our quote-loading system.</p>
<p>Thanks,<br/>Astute Electronics — VQ Loading</p>
<p style="color:#999;font-size:11px;border-top:1px solid #eee;padding-top:8px">Reference: ${esc(subject || '(no subject)')}</p>
</body></html>`;

  const operatorHtml = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b58900">VQ Loading — ambiguous vendor BP</h2>
<p><b>Subject:</b> ${esc(subject)}<br/>
   <b>Vendor in email:</b> ${esc(vendorName || '(name not given)')} ${vendorEmail ? `&lt;${esc(vendorEmail)}&gt;` : ''}<br/>
   <b>External sender:</b> ${esc(envelope.senderUsed || outerFrom || '(unknown)')}<br/>
   <b>UID:</b> ${ctx.uid}<br/>
   ${retryCount ? `<b>Retry:</b> ${retryCount}/2<br/>` : ''}
</p>
<p>Found ${candidateList.length} active BP candidate${candidateList.length === 1 ? '' : 's'}. Which one is this quote for?</p>
<table style="border-collapse:collapse;font-size:13px;margin:8px 0">
  <tr><th></th><th style="text-align:left;padding-right:14px">Search Key</th><th style="text-align:left;padding-right:14px">Name</th><th style="text-align:left">Match reason</th></tr>
  ${rows}
</table>
<p style="background:#fff3cd;padding:10px;border-left:3px solid #b58900">
   <b>Reply to ${esc(ctx.inbox)}</b> with either the search key (e.g. <code>1009842</code>) or the row number (<code>1</code>). If none of these is right, reply with <code>NEW</code> and add the vendor to OT first.
</p>
<p style="color:#666;font-size:11px">To discard this thread entirely: reply with <code>SKIP</code>, <code>DROP</code>, <code>IGNORE</code>, or <code>DISCARD</code> on the first line.</p>
<p style="color:#666;font-size:11px">Sidecar: <code>~/workspace/.vq-loading-pending/${esc(ctx.anchorMessageId || '(no anchor)')}.json</code></p>
</body></html>`;

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_email: { to: envelope.to, cc: envelope.cc, senderUsed: envelope.senderUsed },
      would_write_sidecar: { anchor: ctx.anchorMessageId, vendorName, candidates: candidateList },
    };
  }
  await ctx.notifier.sendEmail(
    envelope.to,
    `VQ Loading — clarify vendor: ${subject || '(no subject)'}`,
    envelope.senderUsed ? senderHtml : operatorHtml,
    { html: true, replyTo: ctx.inbox, cc: envelope.cc || undefined },
  );
  return {
    notified: envelope.to,
    cc: envelope.cc || null,
    sender_emailed: envelope.senderUsed || null,
    sidecar_anchor: ctx.anchorMessageId,
    retry_count: retryCount,
  };
}

/**
 * Vendor's domain has no active BP at all. Jake has to add the vendor to OT
 * (the sender can't do that for us), but the sender CAN supply the company
 * details Jake needs to create the record — so we email the sender (CC Jake)
 * asking for legal name / website / relationship.
 *
 * keepsPending so the sidecar survives until the agent confirms the BP
 * exists and writes.
 *
 * Required payload: { vendorName, vendorEmail }
 * Optional: { subject, extracted, outerFrom, senderEmail }
 */
async function action_needs_vendor(payload, ctx) {
  const { vendorName, vendorEmail, subject, extracted, outerFrom, senderEmail, investigation_summary } = payload;
  const quotesParsed = Array.isArray(extracted && extracted.quotes) ? extracted.quotes.length : 0;

  let sidecarRecord = null;
  if (!ctx.dryRun && ctx.anchorMessageId) {
    sidecarRecord = pending.writeSidecar(ctx.workflow, ctx.anchorMessageId, {
      original_uid: ctx.uid,
      original_subject: subject || null,
      original_recipient: ctx.jakeEmail,
      external_sender: outerFrom || null,
      vendor_name: vendorName || null,
      vendor_email: vendorEmail || null,
      extracted: extracted || (ctx.pendingSidecar && ctx.pendingSidecar.extracted) || {},
      kind: 'needs_vendor',
      investigation_summary: investigation_summary || null,
    });
  }
  const envelope = resolveOutreachRecipients(payload, ctx);
  if (!ctx.dryRun) {
    breadcrumbs.write({
      cog: 'vq-loading-agent',
      event: 'escalated-needs_vendor',
      uid: ctx.uid,
      vendorName: vendorName || null,
      investigation_summary: investigation_summary || null,
      sender_emailed: envelope.senderUsed || null,
      cc_operator: !!envelope.cc,
    });
  }

  const retryCount = sidecarRecord ? sidecarRecord.retry_count : 0;

  const senderHtml = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<p>Hello,</p>
<p>Thanks for your quote. We don't see your company in our records yet — to add you so we can process this and future quotes, could you reply with:</p>
<ul>
  <li>Legal company name</li>
  <li>Company website</li>
  <li>Main business address</li>
  <li>Short description of your business (authorized franchise distributor, independent broker, OEM/CM, etc.)</li>
</ul>
<p>Once we add you, the parsed quotes will load automatically. Reply to this email and your answer will route back to our system.</p>
<p>Thanks,<br/>Astute Electronics — VQ Loading</p>
<p style="color:#999;font-size:11px;border-top:1px solid #eee;padding-top:8px">Reference: ${esc(subject || '(no subject)')}</p>
</body></html>`;

  const operatorHtml = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">VQ Loading — vendor not in OT</h2>
<p><b>Subject:</b> ${esc(subject)}<br/>
   <b>Vendor (from email):</b> ${esc(vendorName || '(name not given)')} ${vendorEmail ? `&lt;${esc(vendorEmail)}&gt;` : ''}<br/>
   <b>External sender:</b> ${esc(envelope.senderUsed || outerFrom || '(unknown)')}<br/>
   <b>UID:</b> ${ctx.uid}<br/>
   ${retryCount ? `<b>Retry:</b> ${retryCount}/2<br/>` : ''}
   <b>Quotes parsed (waiting to load):</b> ${quotesParsed}</p>
<p style="background:#f5f5f5;padding:10px;border-left:3px solid #b00">
   <b>Add the vendor to OT</b> (BP table — set IsVendor='Y', IsCustomer='N', vendor type per relationship). The next agent tick will auto-detect the new BP and load the ${quotesParsed} parsed quote${quotesParsed === 1 ? '' : 's'} without further action.
</p>
<p style="color:#888;font-size:11px">If this isn't a real vendor (e.g. broker forwarded from a personal address with no company), reply with <code>SKIP</code>, <code>DROP</code>, <code>IGNORE</code>, or <code>DISCARD</code> on the first line to discard the parsed quotes.</p>
<p style="color:#666;font-size:11px">Sidecar: <code>~/workspace/.vq-loading-pending/${esc(ctx.anchorMessageId || '(no anchor)')}.json</code></p>
</body></html>`;

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_email: { to: envelope.to, cc: envelope.cc, senderUsed: envelope.senderUsed },
      would_write_sidecar: { anchor: ctx.anchorMessageId, vendorName, extracted },
    };
  }
  await ctx.notifier.sendEmail(
    envelope.to,
    `VQ Loading — needs vendor: ${esc(vendorName || vendorEmail || subject || '(no subject)')}`,
    envelope.senderUsed ? senderHtml : operatorHtml,
    { html: true, replyTo: ctx.inbox, cc: envelope.cc || undefined },
  );
  return {
    notified: envelope.to,
    cc: envelope.cc || null,
    sender_emailed: envelope.senderUsed || null,
    sidecar_anchor: ctx.anchorMessageId,
    retry_count: retryCount,
  };
}

/**
 * Operator triage: extractor + verifier disagree, multi-vendor format the
 * agent can't safely split, PNG-only quote where vision can't parse, conflict
 * between two passes, etc.
 *
 * Routing: TO=sender (CC operator) when senderEmail provided — the sender
 * may be able to resend in a cleaner format that bypasses the failure mode.
 * Falls back to operator-only.
 *
 * Required payload: { reason, subject, outerFrom }
 * Optional: { details, extracted, senderEmail, askSender }
 *   askSender  optional sender-facing question (e.g., "Could you resend the
 *              quote as an Excel attachment? The image-only PDF was hard to
 *              parse cleanly.") If omitted, a generic resend-request is used.
 */
async function action_needs_review(payload, ctx) {
  const {
    reason, subject, outerFrom, senderEmail, details, extracted, askSender,
    investigation_summary, rfqSearchKey, secondaryRfqSearchKeys, buyerId, quotes,
  } = payload;
  const extractedBlock = extracted && Object.keys(extracted).length > 0
    ? `<pre style="background:#f5f5f5;padding:8px;white-space:pre-wrap;font-size:11px">${esc(JSON.stringify(extracted, null, 2))}</pre>`
    : '';

  const envelope = resolveOutreachRecipients(payload, ctx);

  // Write a sidecar so any reply to this bounce (from Ivy/external sender OR
  // from Jake/operator) re-attaches the original context on the next agent
  // tick. Without this, today's UID 8508 → 8516 failure mode recurs: the
  // text-format resend lost Betty's chain because the agent treated it as a
  // fresh email rather than a re-attempt on a known bounce. See
  // deferred-work § "needs_review should write a sidecar..." for the design.
  let sidecarRecord = null;
  if (!ctx.dryRun && ctx.anchorMessageId) {
    sidecarRecord = pending.writeSidecar(ctx.workflow, ctx.anchorMessageId, {
      original_uid: ctx.uid,
      original_subject: subject || null,
      original_recipient: ctx.jakeEmail,
      external_sender: outerFrom || senderEmail || null,
      internal_forwarder: envelope.senderUsed || null,
      reason: reason || null,
      rfq_search_key: rfqSearchKey || null,
      secondary_rfq_search_keys: Array.isArray(secondaryRfqSearchKeys) ? secondaryRfqSearchKeys : [],
      proposed_buyer_id: buyerId || null,
      quote_count_at_bounce: Array.isArray(quotes) ? quotes.length : 0,
      extracted: extracted || {},
      investigation_summary: investigation_summary || null,
      kind: 'needs_review_bounce',
    });
  }

  const senderAsk = askSender && askSender.trim()
    ? askSender.trim()
    : 'Could you resend the quote in a structured text format (Excel, or a plain table in the email body)? Image-only quotes are harder for us to extract reliably.';

  const operatorFooter = envelope.cc
    ? `<p style="color:#999;font-size:10px;border-top:1px dashed #ccc;margin-top:16px;padding-top:8px"><i>Operator reference (CC only): UID ${ctx.uid}</i></p>`
    : '';
  const senderHtml = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<p>Hello,</p>
<p>Thanks for your quote — we hit a snag while trying to log it in our system.</p>
<p>${esc(senderAsk)}</p>
<p>Reply to this email and your response will route back to our quote-loading system.</p>
<p>Thanks,<br/>Astute Electronics — VQ Loading</p>
<p style="color:#999;font-size:11px;border-top:1px solid #eee;padding-top:8px">Reference: ${esc(subject || '(no subject)')}</p>
${operatorFooter}
</body></html>`;

  const operatorHtml = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b00">VQ Loading — needs manual review</h2>
<p><b>Subject:</b> ${esc(subject)}<br/>
   <b>From:</b> ${esc(envelope.senderUsed || outerFrom)}<br/>
   <b>UID:</b> ${ctx.uid}</p>
<p><b>Reason:</b> ${esc(reason)}</p>
${details ? `<pre style="background:#f5f5f5;padding:8px;white-space:pre-wrap;font-size:11px">${esc(details)}</pre>` : ''}
${extractedBlock ? `<p><b>What the extractor produced:</b></p>${extractedBlock}` : ''}
<p style="color:#666;font-size:11px">Message moved to NeedsReview folder.</p>
</body></html>`;

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_email: { to: envelope.to, cc: envelope.cc, senderUsed: envelope.senderUsed, reason },
    };
  }
  await ctx.notifier.sendEmail(
    envelope.to,
    `VQ Loading — needs review: ${subject || '(no subject)'}`,
    envelope.senderUsed ? senderHtml : operatorHtml,
    { html: true, replyTo: ctx.inbox, cc: envelope.cc || undefined },
  );
  breadcrumbs.write({
    cog: 'vq-loading-agent',
    event: 'escalated-needs_review',
    uid: ctx.uid,
    subject,
    outerFrom: envelope.senderUsed || outerFrom,
    reason,
    investigation_summary: investigation_summary || null,
    sender_emailed: envelope.senderUsed || null,
    cc_operator: !!envelope.cc,
  });
  return {
    notified: envelope.to,
    cc: envelope.cc || null,
    sender_emailed: envelope.senderUsed || null,
  };
}

/**
 * Buyer-resolution couldn't pick a known buyer (Tier-A returned support /
 * unknown / no candidate). Ask the operator (Jake only — internal registry
 * concern, never the external sender) to specify the buyer. Operator replies
 * with a name/email; the next agent tick stitches the sidecar, parses the
 * reply, and dispatches load_vq with `bypassRegistryValidation: true`. If
 * the resolved buyer ISN'T in the registry, the load still proceeds (per
 * operator policy 2026-05-20 — registry is a heuristic for fresh loads, not
 * a blocker), and the handler emits a one-off "loaded with non-registry
 * buyer" notice so operator can decide whether to add them.
 *
 * Required payload: { reason, subject }
 * Optional: { proposedBuyerId, outerFrom, rfqSearchKey, secondaryRfqSearchKeys,
 *             quotes, details, investigation_summary }
 */
async function action_clarify_buyer(payload, ctx) {
  const {
    reason, subject, outerFrom, proposedBuyerId, rfqSearchKey,
    secondaryRfqSearchKeys, quotes, details, investigation_summary,
  } = payload;

  // Sidecar — capture everything the reply tick needs to retry the load.
  let sidecarRecord = null;
  if (!ctx.dryRun && ctx.anchorMessageId) {
    sidecarRecord = pending.writeSidecar(ctx.workflow, ctx.anchorMessageId, {
      original_uid: ctx.uid,
      original_subject: subject || null,
      external_sender: outerFrom || null,
      reason: reason || null,
      rfq_search_key: rfqSearchKey || null,
      secondary_rfq_search_keys: Array.isArray(secondaryRfqSearchKeys) ? secondaryRfqSearchKeys : [],
      proposed_buyer_id: proposedBuyerId || null,
      // Stash the full quotes array so the reply tick re-dispatches without
      // re-extracting from the original email body. Avoids extraction drift
      // between bounce and retry.
      quotes: Array.isArray(quotes) ? quotes : [],
      investigation_summary: investigation_summary || null,
      kind: 'clarify_buyer',
    });
  }

  const operatorHtml = `<html><body style="font-family:Arial,sans-serif;font-size:13px">
<h2 style="color:#b80">VQ Loading — Clarify buyer</h2>
<p><b>Subject:</b> ${esc(subject)}<br/>
   <b>From:</b> ${esc(outerFrom || '(unknown)')}<br/>
   <b>UID:</b> ${ctx.uid}</p>
<p><b>Reason:</b> ${esc(reason || '')}</p>
${details ? `<pre style="background:#fff8e0;padding:8px;white-space:pre-wrap;font-size:11px">${esc(details)}</pre>` : ''}
<p><b>To resolve, reply to this email with the buyer:</b></p>
<ul>
<li><code>buyer: Stephanie Hill</code></li>
<li><code>buyer: stephanie.hill@astutegroup.com</code></li>
<li>or just the name/email on its own line</li>
</ul>
<p style="color:#888;font-size:12px"><i>Policy (2026-05-20): if the buyer you name isn't yet in <code>shared/data/user-role-registry.json</code>, the load still proceeds. You'll get a one-off notice afterward so you can add them at your convenience.</i></p>
<p style="color:#666;font-size:11px;border-top:1px solid #eee;padding-top:8px;margin-top:16px">Sidecar key: ${esc(ctx.anchorMessageId || '(no anchor)')}<br/>Quotes stashed: ${(quotes || []).length}</p>
</body></html>`;

  if (ctx.dryRun) {
    return {
      dry_run: true,
      would_email: { to: ctx.jakeEmail, reason },
      would_write_sidecar: !!ctx.anchorMessageId,
    };
  }

  await ctx.notifier.sendEmail(
    ctx.jakeEmail,
    `VQ Loading — Clarify buyer: ${subject || '(no subject)'}`,
    operatorHtml,
    { html: true, replyTo: ctx.inbox },
  );
  breadcrumbs.write({
    cog: 'vq-loading-agent',
    event: 'escalated-clarify_buyer',
    uid: ctx.uid,
    subject,
    outerFrom: outerFrom || null,
    proposed_buyer_id: proposedBuyerId || null,
    rfq: rfqSearchKey || null,
    quote_count: Array.isArray(quotes) ? quotes.length : 0,
    reason: reason || null,
    investigation_summary: investigation_summary || null,
  });
  return {
    notified: ctx.jakeEmail,
    sidecar_written: !!sidecarRecord,
  };
}

/**
 * Vendor explicitly declined (no-bid). Move to NoBid folder + breadcrumb.
 *
 * NOTE: As of 2026-05-20, `shared/vq-writer.js` now accepts 0/0 rows
 * (`cost === 0 && qty === 0`) alongside the standard `cost > 0 && qty > 0`
 * gate. The PRIMARY path for capturing a "we asked, they declined" signal
 * in OT is the agent's Pass 1 extraction (see agent-prompt.txt § 3.7.0a):
 * the agent emits 0/0 quotes inside `load_vq` with `vendorNotes` starting
 * `NO BID — `, which flow into Chuboe_Note_User on the VQ row.
 *
 * This action handler stays in place for edge cases where the email is
 * exclusively a no-bid notification (no quote rows worth a load_vq call)
 * AND there's no per-line ambiguity — it bookkeeps via breadcrumb + IMAP
 * move but does NOT itself write a 0/0 VQ today. If a future need arises
 * to write a single no-bid VQ from this action's payload, the writer is
 * now ready.
 *
 * Required payload: { reason }
 * Optional: { vendorBpartnerId, rfqSearchKey, vendorName }
 */
async function action_no_bid(payload, ctx) {
  if (ctx.dryRun) {
    return { dry_run: true, reason: payload.reason || 'no-bid' };
  }
  breadcrumbs.write({
    cog: 'vq-loading-agent',
    event: 'no-bid',
    uid: ctx.uid,
    reason: payload.reason || 'no-bid',
    vendorBpartnerId: payload.vendorBpartnerId || null,
    vendorName: payload.vendorName || null,
    rfqSearchKey: payload.rfqSearchKey || null,
  });
  return { reason: payload.reason || 'no-bid' };
}

/**
 * Silent move — message is not a quote (orders, shipping notifications,
 * OOO, marketing, sourcing requests, etc.).
 *
 * Required payload: { reason }
 */
async function action_not_vq(payload, ctx) {
  if (ctx.dryRun) {
    return { dry_run: true, reason: payload.reason || 'unspecified' };
  }
  breadcrumbs.write({
    cog: 'vq-loading-agent',
    event: 'not-vq',
    uid: ctx.uid,
    reason: payload.reason || 'unspecified',
  });
  return { reason: payload.reason || 'unspecified' };
}

/**
 * Pre-write duplicate detected. Same vendor + MPN + qty + cost on the same
 * RFQ within 30d already exists. The agent does the SQL check before
 * routing; this handler just breadcrumbs the decision so the digest can
 * show how often resends fire.
 *
 * Required payload: { existingVqId, reason }
 */
async function action_dup_skip(payload, ctx) {
  if (ctx.dryRun) {
    return { dry_run: true, existingVqId: payload.existingVqId };
  }
  breadcrumbs.write({
    cog: 'vq-loading-agent',
    event: 'dup-skipped',
    uid: ctx.uid,
    existingVqId: payload.existingVqId,
    reason: payload.reason || 'duplicate',
  });
  return { existingVqId: payload.existingVqId };
}

/**
 * Operator-initiated discard of a pending escalation. Triggered when Jake
 * replies to a need_info_vendor / clarify_vendor / needs_vendor email with a
 * directive like SKIP / IGNORE / DROP / DISCARD / NOT A QUOTE. The agent
 * parses the directive in step 3.2 stitch logic and routes here.
 *
 * Side effects:
 *   - Silent move to NoBid (signal that we considered + declined to load).
 *   - Breadcrumb 'operator-dropped' so the digest can show how often this fires.
 *   - The poller clears the sidecar automatically (this action is NOT keepsPending).
 *
 * Required payload: { reason } — usually the directive Jake typed
 *   (e.g., "SKIP — broker sent from a personal Gmail account, no company")
 * Optional: { original_message_id } — passed by the stitch logic so the
 *   poller clears the right sidecar.
 */
async function action_drop_pending(payload, ctx) {
  if (ctx.dryRun) {
    return { dry_run: true, reason: payload.reason || 'operator-dropped' };
  }
  breadcrumbs.write({
    cog: 'vq-loading-agent',
    event: 'operator-dropped',
    uid: ctx.uid,
    reason: payload.reason || 'operator-dropped',
    pending_kind: ctx.pendingSidecar && ctx.pendingSidecar.kind || null,
  });
  return { reason: payload.reason || 'operator-dropped' };
}

/**
 * Astute-internal reply chain that isn't a new quote (operator replying back
 * to the broker, asking for date code, declining the quote internally, etc.).
 * Move to OutboundPending so it doesn't get re-processed as inbound and
 * doesn't pollute the breadcrumb 'loaded' stream.
 *
 * Required payload: { reason }
 */
async function action_outbound_pending(payload, ctx) {
  if (ctx.dryRun) {
    return { dry_run: true, reason: payload.reason || 'outbound reply' };
  }
  breadcrumbs.write({
    cog: 'vq-loading-agent',
    event: 'outbound-pending',
    uid: ctx.uid,
    reason: payload.reason || 'outbound reply',
  });
  return { reason: payload.reason || 'outbound reply' };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * VQ-specific override of the standing operator-only escalation policy
 * (memory: feedback_info_requests_go_to_operator_not_origin.md).
 *
 * VQ replies typically come from brokers who CAN answer "what's the qty?"
 * or "what's your legal company name?" — the questions are about their own
 * quote. So we send TO the broker, CC the operator (so Jake sees the ask
 * and the eventual answer), and route the reply back to vq@ so the
 * sidecar-stitch path picks up the answer next tick.
 *
 * Falls back to operator-only when there's no usable sender (Type 2 bulk
 * summaries that lost the original broker address, or extractor couldn't
 * pull a sender at all).
 *
 * Returns { to, cc, senderUsed }:
 *   - senderUsed truthy → outreach mode: to=sender, cc=operator
 *   - senderUsed null   → operator-only mode (legacy behavior preserved)
 */
function resolveOutreachRecipients(payload, ctx) {
  const candidate = (payload.senderEmail || payload.outerFrom || '').trim();
  // Reject the obvious anti-self-send cases. We DO allow Astute-internal
  // forwarders (Gopal compiling a Type 2 summary) — they may be the one
  // who can answer the question.
  const looksLikeEmail = /^[^\s<>"]+@[^\s<>"]+\.[^\s<>"]+$/.test(candidate);
  if (!looksLikeEmail) return { to: ctx.jakeEmail, cc: null, senderUsed: null };
  // Don't email vq@ inbox itself (that would just trigger a loop).
  if (ctx.inbox && candidate.toLowerCase() === ctx.inbox.toLowerCase()) {
    return { to: ctx.jakeEmail, cc: null, senderUsed: null };
  }
  return {
    to: candidate,
    cc: ctx.jakeEmail,
    senderUsed: candidate,
  };
}

/**
 * Render a missing-field list in human-readable form for the sender.
 * Operator-facing version uses the existing missingLabel() — this is a
 * lighter, less-jargon version suited for an external broker.
 */
function missingLabelForSender(key) {
  switch (key) {
    case 'qty':           return 'Quantity offered';
    case 'cost':          return 'Unit price';
    case 'mfr':           return 'Manufacturer';
    case 'mpn':           return 'Manufacturer part number (MPN)';
    case 'rfq_number':    return 'Which RFQ this quote is for';
    case 'buyer':         return 'Which of our buyers requested this';
    case 'date_code':     return 'Date code';
    default:              return key;
  }
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  inbox: 'vq@orangetsunami.com',
  notifierConfig: {
    fromEmail: 'vq@orangetsunami.com',
    fromName: 'VQ Loader',
  },
  actions: {
    load_vq: {
      folder: 'Processed',
      requires: ['rfqSearchKey', 'buyerId', 'quotes'],
      // keepsPending=true so a partial-clarify sidecar can survive when the
      // payload includes clarifications[]. The handler explicitly clears any
      // pre-existing sidecar when no clarifications are present.
      keepsPending: true,
      handler: action_load_vq,
    },
    need_info_vendor: {
      folder: 'NeedInfo',
      requires: ['missing'],
      keepsPending: true,
      handler: action_need_info_vendor,
    },
    clarify_vendor: {
      folder: 'NeedInfo',
      requires: ['candidates'],
      keepsPending: true,
      handler: action_clarify_vendor,
    },
    needs_vendor: {
      folder: 'NeedsVendor',
      requires: ['vendorName'],
      keepsPending: true,
      handler: action_needs_vendor,
    },
    needs_review: {
      folder: 'NeedsReview',
      requires: ['reason'],
      handler: action_needs_review,
    },
    clarify_buyer: {
      folder: 'NeedInfo',
      requires: ['reason'],
      keepsPending: true,
      handler: action_clarify_buyer,
    },
    no_bid: {
      folder: 'NoBid',
      requires: ['reason'],
      handler: action_no_bid,
    },
    not_vq: {
      folder: 'Processed',
      requires: ['reason'],
      handler: action_not_vq,
    },
    dup_skip: {
      folder: 'Duplicates',
      requires: ['existingVqId'],
      handler: action_dup_skip,
    },
    drop_pending: {
      folder: 'NoBid',
      requires: ['reason'],
      handler: action_drop_pending,
    },
    outbound_pending: {
      folder: 'OutboundPending',
      requires: ['reason'],
      handler: action_outbound_pending,
    },
  },
  constants: {
    JAKE_USER_ID,
  },
};
