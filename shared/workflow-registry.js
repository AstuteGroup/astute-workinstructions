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
      'enqueue', 'need_info', 'needs_review', 'not_rfq',
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
      'not_offer', 'dup_skip', 'approve_large_offer', 'reject_large_offer',
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
      'clarify_partner', 'dup_skip',
      'approve_large_stock_rfq', 'reject_large_stock_rfq',
    ],
    capabilities: {
      replyStitching: true,
      needInfoClarifications: true,
      largePayloadGate: true,
      approvalReplyAction: true,
      preWriteIdempotency: true,
      writeQueue: false,
      breadcrumbWrites: true,
      operatorDigest: false,
      activityDigest: true,
      replyParserGrammar: false,
      tieredCron: true,
    },
    deviations: {
      operatorDigest: 'broker stock-RFQs are transactional; activityDigest (stock-rfq-activity-digest 6×/day) covers visibility',
      writeQueue: 'direct write; broker emails carry small batches',
      replyParserGrammar: 'activityDigest is informational-only by design — no curation queue, no operator-override loop. Shared grammar in shared/workflow-reply-grammars.js is available if directives are needed later.',
    },
    // All capabilities now declared. tieredCron wired in scripts/should-run-stockrfq-agent.js
    // (5m burst on pending large-stockrfq sentinel or clarify_partner sidecar; 15m steady —
    // tighter than rfqloading's 30m because operator works the inbound RFQ + outbound CQ chain).
  },

  // ─── STOCK RFQ CQ (operator outbound quote replies → CQ rows) ───────────────
  'stockrfq-cq': {
    status: 'active',
    handler: 'stockrfq-cq',
    doc: 'Trading Analysis/Stock RFQ Loading/stock-rfq-cq-loading.md',
    inbox: 'stockRFQ@orangetsunami.com',
    sourceFolder: 'OutboundPending',
    cron: { name: 'stockrfq-cq-agent' },
    actions: ['add_cq', 'add_cq_with_rfq', 'skip', 'needs_review'],
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
  // NOT YET ON THE PATTERN. Listed here so the migration target is discoverable
  // alongside everything else. Parity check skips capability validation for
  // status='planned' entries but lists the workflow at the bottom of the report
  // so the gap stays visible.
  'vq-loading': {
    status: 'planned',
    handler: null,
    doc: 'Trading Analysis/RFQ Sourcing/vq_loading/vq-loading.md',
    inbox: null,  // TBD — IT to provision vq@ inbox, or operator picks an existing one
    sourceFolder: 'INBOX',
    cron: null,
    actions: [],
    capabilities: {
      // Target state — what we want once migrated. Not validated while status='planned'.
      replyStitching: true,
      needInfoClarifications: true,
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
    deviations: {},
    notes: 'Type 1 (vq-parser fetch) + Type 2 (load-bulk-summary-cli.js) currently manual. Migration plan: see Trading Analysis/RFQ Sourcing/sourcing-roadmap.md. Inherits stitching/gate/clarifications for free once on the pattern.',
  },
};
