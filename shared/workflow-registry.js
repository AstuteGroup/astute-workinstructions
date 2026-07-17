/**
 * shared/workflow-registry.js — single source of truth for email-driven workflows.
 *
 * READ THIS IF YOU ARE:
 *   - Adding a new email-driven workflow → copy shared/workflow-actions/_template.js
 *     and add an entry below.
 *   - Modifying anything in shared/email-workflow-poller.js, workflow-pending-state.js,
 *     workflow-actions/_*.js, large-rfq-gate.js → list affected workflows in the
 *     commit body; the parity check will catch what you forgot.
 *   - Wondering whether workflow X has feature Y wired → grep this file, not the code.
 *
 * Enforcement:
 *   scripts/check-workflow-parity.js reads this registry, inspects each handler
 *   module + cron-jobs.js, and flags drift. It runs at session start alongside
 *   check-cron-drift.js.
 *
 * ─── ENTRY SCHEMA ──────────────────────────────────────────────────────────────
 *
 *   status         'active' | 'planned' | 'deprecated'
 *                  - 'active'     full parity check (capabilities, actions, cron)
 *                  - 'planned'    listed in registry but parity check skips
 *                                 capability validation (target state, not current)
 *                  - 'deprecated' parity check skips entirely; kept for archeology
 *
 *   handler        module path under shared/workflow-actions/ (no extension), or null
 *                  for planned workflows
 *
 *   doc            workflow .md path under astute-workinstructions/
 *
 *   inbox          IMAP inbox (informational; the handler export is ground truth)
 *
 *   sourceFolder   IMAP folder the poller reads from (default 'INBOX'; e.g.
 *                  'OutboundPending' for stockrfq-cq)
 *
 *   cron           { name: '<job-name>' } or null. Parity check verifies an entry
 *                  with this `name` exists in cron-jobs.js. Schedule itself is NOT
 *                  compared across workflows — cron cadence is the legitimate-
 *                  divergence layer. The existing scripts/check-cron-drift.js
 *                  handles schedule drift per-job.
 *
 *   actions        Array of action names. Parity check verifies the handler's
 *                  exported actions match this set exactly (set equality).
 *
 *   capabilities   { <capabilityName>: boolean }. See vocabulary below.
 *                  - true  = wired in code; parity check verifies (best-effort
 *                            static inspection — imports, action configs).
 *                  - false = NOT wired. MUST have a matching `deviations` entry
 *                            with a non-empty rationale, OR the parity check
 *                            reports it as a GAP (the migration backlog).
 *
 *   deviations     { <capabilityName>: 'one-line rationale' } — declared
 *                  exemptions for capabilities=false that are intentional, not
 *                  gaps. The presence of an entry here is the contract that says
 *                  "we considered this and decided no." Required for any false
 *                  capability that isn't tracked as an open gap.
 *
 * ─── CAPABILITY VOCABULARY (extend as new shared features land) ────────────────
 *
 *   replyStitching          Workflow uses shared/workflow-pending-state sidecars
 *                           to merge clarification replies with the original
 *                           extraction. Default-on once any action declares
 *                           keepsPending: true. (See email-workflow-architecture.md
 *                           § Reply stitching.)
 *
 *   needInfoClarifications  Handler has at least one action that emails the sender
 *                           asking for missing fields. Conventional name: need_info
 *                           or clarify_*.
 *
 *   largePayloadGate        Handler uses shared/large-rfq-gate.js (or its
 *                           successor large-payload-gate) to pause processing
 *                           above a size threshold pending operator approval.
 *
 *   approvalReplyAction     Handler exposes approve_X / reject_X actions to consume
 *                           operator approval replies (pairs with largePayloadGate).
 *
 *   preWriteIdempotency     Handler performs an explicit duplicate check before
 *                           calling the writer (vs. relying solely on writer-
 *                           internal natural-key dedup).
 *
 *   writeQueue              Handler enqueues to a staging queue rather than
 *                           writing directly. RFQ Loading uses rfq-load-queue;
 *                           crossref-review uses crossref-queue.
 *
 *   breadcrumbWrites        Handler writes structured events via shared/breadcrumbs.js
 *                           for digest + drift visibility.
 *
 *   operatorDigest          Workflow's events surface in an operator-curated
 *                           digest with reply-parser grammar (offer-digest 3×/day).
 *
 *   activityDigest          Workflow has a read-only activity digest (no reply
 *                           loop — sourcing visibility, not action queue).
 *
 *   replyParserGrammar      Workflow consumes structured operator replies via a
 *                           cog that parses key:value directives (PARTNER:, INTENT:,
 *                           SKIP:, or "approve cross-ref:" / "reject cross-ref:").
 *
 *   tieredCron              Workflow's cron is tiered (burst on signal / steady
 *                           otherwise) via an external gate script. RFQ Loading is
 *                           the reference (scripts/should-run-rfqloading-agent.js).
 */

'use strict';

module.exports = {
  // ─── RFQ LOADING (general customer RFQs) ────────────────────────────────────
  'rfq-loading': {
    status: 'active',
    handler: 'rfq-loading',
    doc: 'Trading Analysis/RFQ Loading/rfq-loading.md',
    inbox: 'rfqloading@orangetsunami.com',
    sourceFolder: 'INBOX',
    cron: { name: 'rfqloading-agent' },
    actions: [
      'enqueue', 'need_info', 'needs_review', 'not_rfq', 'drop_pending',
      'approve_large_rfq', 'reject_large_rfq',
    ],
    capabilities: {
      replyStitching: true,
      needInfoClarifications: true,
      largePayloadGate: true,
      approvalReplyAction: true,
      preWriteIdempotency: true,
      writeQueue: true,
      breadcrumbWrites: false,
      operatorDigest: false,
      activityDigest: false,
      replyParserGrammar: false,
      tieredCron: true,
    },
    deviations: {
      breadcrumbWrites: 'rfq-load-queue job state is the audit trail; each job tracks status/error/retry per job_id',
      operatorDigest: 'transactional flow — large-RFQ approvals surface inline via approval email, not a queue digest',
      activityDigest: 'transactional flow — per-RFQ visibility via OT, no aggregate sourcing intel needed',
      replyParserGrammar: 'approval replies use a subject-line directive parsed inside action_approve_large_rfq; no key:value grammar needed',
    },
    // POLICY 2026-05-14: need_info emails Jake, NOT the external customer. Sidecar +
    // reply-stitching still active — Jake's reply to rfqloading@ with the missing
    // values round-trips and triggers enqueue on the next agent tick.
  },

  // ─── CUSTOMER EXCESS (offers + broker/franchise data capture) ───────────────
  'excess': {
    status: 'active',
    handler: 'excess',
    doc: 'Trading Analysis/Customer Excess Analysis/customer-excess-analysis.md',
    inbox: 'excess@orangetsunami.com',
    sourceFolder: 'INBOX',
    cron: { name: 'excess-agent' },
    actions: [
      'load_offer', 'needs_partner', 'clarify_partner', 'needs_review',
      'not_offer', 'dup_skip', 'drop_pending',
      'approve_large_offer', 'reject_large_offer',
    ],
    capabilities: {
      replyStitching: true,
      needInfoClarifications: true,
      largePayloadGate: true,
      approvalReplyAction: true,
      preWriteIdempotency: true,
      writeQueue: false,
      breadcrumbWrites: true,
      operatorDigest: true,
      activityDigest: false,
      replyParserGrammar: true,
      tieredCron: true,
    },
    deviations: {
      writeQueue: 'direct write — one offer per email; fan-out happens downstream via offer-router, not pre-write',
      activityDigest: 'operatorDigest (offer-digest 3×/day) already provides aggregate visibility',
    },
    // All capabilities now declared. tieredCron wired in scripts/should-run-excess-agent.js
    // (5m burst on pending large-offer sentinel or clarify_partner sidecar; 30m steady).
    //
    // POLICY 2026-05-14: clarify_partner emails Jake, NOT the external sender. Sidecar
    // + reply-stitching still active — Jake's reply to excess@ with the company name
    // round-trips and triggers load_offer on the next agent tick. Reversed the original
    // external-sender variant (commit 0a334bc) alongside the stockrfq deviation after
    // confirming info-requests must never go to unverified third parties.
  },

  // ─── STOCK RFQ LOADING (broker stock RFQs — inbound) ────────────────────────
  'stockrfq': {
    status: 'active',
    handler: 'stockrfq',
    doc: 'Trading Analysis/Stock RFQ Loading/stock-rfq-loading.md',
    inbox: 'stockRFQ@orangetsunami.com',
    sourceFolder: 'INBOX',
    cron: { name: 'stockrfq-agent' },
    actions: [
      'load_rfq', 'needs_review', 'not_rfq', 'outbound_pending',
      'dup_skip',
      'approve_large_stock_rfq', 'reject_large_stock_rfq',
    ],
    capabilities: {
      replyStitching: false,
      needInfoClarifications: false,
      largePayloadGate: true,
      approvalReplyAction: true,
      preWriteIdempotency: true,
      writeQueue: false,
      breadcrumbWrites: true,
      operatorDigest: false,
      activityDigest: true,
      replyParserGrammar: false,
      tieredCron: false,
    },
    deviations: {
      replyStitching: 'broker-side workflow has no info-request path that needs stitching — unresolved-partner cases route directly to Unqualified Broker (1006505) instead of round-tripping. See needInfoClarifications below.',
      needInfoClarifications: 'POLICY: stock RFQs from unverified brokers must NOT trigger an outbound info-request to either the broker or the operator. The broker-side default for unknown senders is "load under Unqualified Broker BP 1006505" — the engagement signal is the value; partner ID is operator triage at the OT layer. Reversed 2026-05-14 after the clarify_partner action (commit 513821d) sent 4 outbound confirmation emails to APAC fishing-pattern brokers within 4 hours. Excess (customer-side) keeps its clarify path but redirects to operator; stockrfq is the deviation.',
      operatorDigest: 'broker stock-RFQs are transactional; activityDigest (stock-rfq-activity-digest 6×/day) covers visibility',
      writeQueue: 'direct write; broker emails carry small batches',
      replyParserGrammar: 'activityDigest is informational-only by design — no curation queue, no operator-override loop. Shared grammar in shared/workflow-reply-grammars.js is available if directives are needed later.',
      tieredCron: 'Removed 2026-05-26 — relaxed from 5m burst / 15m steady to hourly :00 fixed cadence (no gate). Stock RFQs are 1-2 line data-capture loads with no live-decision latency requirement; burst overhead unnecessary.',
    },
  },

  // ─── STOCK RFQ CQ (operator outbound quote replies → CQ rows) ───────────────
  'stockrfq-cq': {
    status: 'active',
    handler: 'stockrfq-cq',
    doc: 'Trading Analysis/Stock RFQ Loading/stock-rfq-cq-loading.md',
    inbox: 'stockRFQ@orangetsunami.com',
    sourceFolder: 'OutboundPending',
    cron: { name: 'stockrfq-cq-agent' },
    actions: ['add_cq', 'add_cq_with_rfq', 'update_cq', 'skip', 'needs_review'],
    capabilities: {
      replyStitching: false,
      needInfoClarifications: false,
      largePayloadGate: false,
      approvalReplyAction: false,
      preWriteIdempotency: true,
      writeQueue: false,
      breadcrumbWrites: true,
      operatorDigest: false,
      activityDigest: false,
      replyParserGrammar: false,
      tieredCron: false,
    },
    deviations: {
      replyStitching: 'CQ writes are operator-initiated (operator already replied with a quote); no external clarification round-trip',
      needInfoClarifications: 'no external sender to clarify with — the operator IS the sender',
      largePayloadGate: 'CQ batches are small (operator quotes a handful of lines per reply)',
      approvalReplyAction: 'operator implicitly approved by replying; no separate approval gate needed',
      writeQueue: 'direct write; volumes small',
      operatorDigest: 'parent stockrfq workflow covers visibility',
      activityDigest: 'parent stockrfq workflow covers visibility',
      replyParserGrammar: 'no operator-override grammar needed — every outbound reply IS the directive',
      tieredCron: 'every 15m at :05/:20/:35/:50 (offset by 5 from inbound stockrfq-agent\'s :00/:15/:30/:45) — no burst gate needed because CQ work is triggered by recent inbound activity, which already bursts on the inbound side',
    },
    // All capabilities now declared. preWriteIdempotency is enforced at the
    // writer level (shared/cq-writer.js writeCQBatch SELECT before POST).
  },

  // ─── CROSS-REF REVIEW (operator approves/rejects ambiguous API cross-refs) ──
  'crossref-review': {
    status: 'active',
    handler: 'crossref-review',
    doc: null,  // V1 documented inline in shared/crossref-queue.md + enrich-poller digest body
    inbox: 'stockRFQ@orangetsunami.com',  // reuses; subject-filter applied in poller
    sourceFolder: 'INBOX',
    cron: null,  // V1 is CLI-driven; phase-3 work to wire to poller
    actions: ['apply_reply'],
    capabilities: {
      replyStitching: false,
      needInfoClarifications: false,
      largePayloadGate: false,
      approvalReplyAction: false,
      preWriteIdempotency: true,
      writeQueue: true,
      breadcrumbWrites: false,
      operatorDigest: true,
      activityDigest: false,
      replyParserGrammar: true,
      tieredCron: false,
    },
    deviations: {
      replyStitching: 'reply IDs are self-contained (xref-<rfq>-<mfr>-<idx>); candidate state lives in crossref-queue, no sidecar needed',
      needInfoClarifications: 'operator-initiated approval; no external sender',
      largePayloadGate: 'per-row decisions; no batch payload to gate',
      approvalReplyAction: 'the apply_reply action IS the approval grammar parser; no separate approve_*/reject_* actions needed',
      breadcrumbWrites: 'crossref-queue status field (pending → written / operator-rejected) is the audit trail',
      activityDigest: 'parent enrich-poller digest covers visibility',
      tieredCron: 'V1 CLI-only; phase-3 will wire to poller with subject filter',
    },
    notes: 'Phase 3: wire to email-workflow-poller with subject filter on enrich-poller digest replies. Currently invoked from CLI / digest reply parser.',
  },

  // ─── VQ LOADING (supplier quotes → VQ records) ──────────────────────────────
  'vq-loading': {
    status: 'active',
    handler: 'vq-loading',
    doc: 'Trading Analysis/RFQ Sourcing/vq_loading/vq-loading.md',
    inbox: 'vq@orangetsunami.com',
    sourceFolder: 'INBOX',
    cron: { name: 'vq-loading-agent' },
    actions: [
      'load_vq', 'need_info_vendor', 'clarify_vendor', 'needs_vendor',
      'needs_review', 'clarify_buyer', 'no_bid', 'not_vq', 'dup_skip', 'drop_pending',
      'outbound_pending', 'forward_to_rfq_loading',
    ],
    capabilities: {
      replyStitching: true,
      needInfoClarifications: true,
      largePayloadGate: false,
      approvalReplyAction: false,
      preWriteIdempotency: true,
      writeQueue: false,
      breadcrumbWrites: true,
      operatorDigest: false,
      activityDigest: true,
      replyParserGrammar: false,
      tieredCron: true,
    },
    deviations: {
      largePayloadGate: 'VQ writes are local to OT — no external API quota at risk. Cost of over-load is bounded (deactivate the lines). The two-agent verifier pass (extractor → independent sub-Agent verifier → reconcile, per agent-prompt.txt step 3.7) is the safety net for "extractor hallucinated N quotes from a small email" failure mode. Decided 2026-05-14.',
      approvalReplyAction: 'No payload gate → no approval needed. Clarification round-trip uses reply-stitching (needInfoClarifications via need_info_vendor / clarify_vendor / needs_vendor sidecars), not approval.',
      writeQueue: 'direct write — loadBulkSummary fans out per quote within a single agent invocation; volumes per email are bounded by Two-Agent Validation runtime budget',
      operatorDigest: 'activityDigest covers visibility; no operator-curation queue (writes are deterministic given valid quotes JSON)',
      replyParserGrammar: 'reply parsing happens inside the agent prompt (step 3.2 stitch logic for clarify/need_info/needs_vendor replies), not in a shared key:value grammar — replies are operator prose, not directives',
    },
    // tieredCron wired in scripts/should-run-vq-loading-agent.js (5m burst on
    // pending clarify_vendor / need_info_vendor / needs_vendor sidecar; 15m
    // steady — matches stockrfq cadence).
    //
    // Two-Agent Validation lives in agent-prompt.txt (step 3.7): extractor pass
    // produces structured JSON, sub-Agent verifier (via Agent tool with
    // subagent_type=general-purpose) independently re-extracts and flags
    // discrepancies, reconciliation either proceeds or routes needs_review.
    // The handler is unaware of the validation — it just receives reconciled
    // quotes.
  },

  // ─── BROKER/FRANCHISE MARKET OFFERS ─────────────────────────────────────────
  'broker-offers': {
    status: 'active',
    handler: 'broker-offers',
    doc: 'Trading Analysis/Broker Offers/broker-offers.md',
    inbox: 'brokeroffers@orangetsunami.com',
    sourceFolder: 'INBOX',
    cron: { name: 'broker-offers-agent' },
    actions: [
      'load_offer', 'needs_partner', 'clarify_partner', 'needs_review',
      'not_offer', 'dup_skip', 'drop_pending',
    ],
    capabilities: {
      replyStitching: true,
      needInfoClarifications: true,
      largePayloadGate: false,
      approvalReplyAction: false,
      preWriteIdempotency: true,
      writeQueue: false,
      breadcrumbWrites: true,
      operatorDigest: false,
      activityDigest: false,
      replyParserGrammar: true,
      tieredCron: false,
    },
    deviations: {
      largePayloadGate: 'No downstream analysis pipeline — offers are data capture only. No per-line cost to gate.',
      approvalReplyAction: 'No payload gate → no approval action needed. Clarification round-trip uses reply-stitching (clarify_partner sidecars).',
      writeQueue: 'Direct write; broker/franchise emails are typically bounded batch sizes.',
      operatorDigest: 'No downstream analysis to curate. Breadcrumbs + confirmation emails provide visibility.',
      activityDigest: 'Low priority; can add later if visibility needed. Confirmations email internal parties on every load.',
      tieredCron: 'No approval gate → no burst trigger. Fixed 30m cadence sufficient for data capture.',
    },
    // POLICY: All notifications go to Jake + internal CC — NEVER to external brokers/franchises.
    // clarify_partner emails Jake (Reply-To: brokeroffers@ for sidecar round-trip).
    // load_offer confirmation emails internal forwarder + internal CCs + Jake; excludes external sender.
  },

  // ─── TRACKING LOADING (supplier shipping confirmations → PO tracking) ───────
  'tracking-loading': {
    status: 'active',
    handler: 'tracking-loading',
    doc: 'Trading Analysis/Tracking Loading/tracking-loading.md',
    inbox: 'tracking@orangetsunami.com',
    sourceFolder: 'INBOX',
    cron: { name: 'tracking-agent' },
    actions: ['patch_tracking', 'needs_review', 'not_tracking'],
    capabilities: {
      replyStitching: false,
      needInfoClarifications: false,
      largePayloadGate: false,
      approvalReplyAction: false,
      preWriteIdempotency: true,
      writeQueue: false,
      breadcrumbWrites: true,
      operatorDigest: false,
      activityDigest: false,
      replyParserGrammar: false,
      tieredCron: false,
    },
    deviations: {
      replyStitching: 'tracking updates are one-shot — no clarification round-trip with external parties',
      needInfoClarifications: 'ambiguous cases route to needs_review for operator manual handling; no external sender to clarify with',
      largePayloadGate: 'tracking numbers are tiny payloads; no gate needed',
      approvalReplyAction: 'no payload gate → no approval needed',
      writeQueue: 'direct PATCH to c_order; single-row updates',
      operatorDigest: 'low-volume workflow; per-email confirmation is sufficient visibility',
      activityDigest: 'low-volume workflow; breadcrumbs provide audit trail',
      replyParserGrammar: 'no operator-override grammar needed — escalations go to needs_review',
      tieredCron: 'fixed cadence (every 15m); shipping confirmations have no urgency signal',
    },
  },

  // ─── LAM KITTING (LAM approval emails → Master Roster updates) ─────────────
  'lam-kitting': {
    status: 'active',
    handler: 'lam-kitting',
    doc: 'Trading Analysis/LAM 3PL/lam-kitting-agent.md',
    inbox: 'lamkitting@orangetsunami.com',
    sourceFolder: 'INBOX',
    cron: { name: 'lam-kitting-agent' },
    actions: [
      'approve_price', 'approve_leadtime', 'approve_flagged', 'skip_flagged',
      'add_award', 'reject', 'need_info', 'needs_review', 'not_approval',
    ],
    capabilities: {
      replyStitching: true,
      needInfoClarifications: true,
      largePayloadGate: false,
      approvalReplyAction: false,
      preWriteIdempotency: true,
      writeQueue: false,
      breadcrumbWrites: true,
      operatorDigest: false,
      activityDigest: false,
      replyParserGrammar: false,
      tieredCron: false,
    },
    deviations: {
      largePayloadGate: 'LAM approval emails are single-item or small batches; no gate needed',
      approvalReplyAction: 'This workflow IS the approval handler; no nested approval gate',
      writeQueue: 'Direct xlsx update to Master Roster; no staging queue needed',
      operatorDigest: 'Low-volume workflow; per-email breadcrumbs provide audit trail',
      activityDigest: 'Low-volume workflow; no aggregate digest needed',
      replyParserGrammar: 'Reply parsing handled by agent prompt, not shared grammar',
      tieredCron: 'Fixed hourly cadence; approval replies are not time-critical',
    },
    // POLICY: All notifications go to Jake (operator) — NEVER to LAM contacts.
    // need_info emails Jake (Reply-To: lamkitting@ for sidecar round-trip).
    // Writes update LAM_Master_Roster.xlsx directly (not OT API).
  },
};
