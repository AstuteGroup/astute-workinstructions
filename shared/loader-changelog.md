# Loader Changelog

Cross-workflow index of changes to the email-driven loaders. **Before touching any one loader, scan recent entries here to see if the same change applies to the others.** See `feedback_parallel_writer_audit.md` for why — the five loaders were brought up in parallel and bug classes cluster across them.

Each loader's own workflow `.md` keeps a per-loader `## Recent Changes` section with the same entries (one row per commit). This file is the cross-reference.

## How to use

Before editing one of:

- `shared/workflow-actions/vq-loading.js` → see also: stockrfq-cq, excess, stockrfq, rfq-loading
- `shared/workflow-actions/stockrfq.js` → see also: vq-loading, rfq-loading, excess
- `shared/workflow-actions/stockrfq-cq.js` → see also: stockrfq, vq-loading
- `shared/workflow-actions/excess.js` → see also: stockrfq, vq-loading, rfq-loading
- `shared/workflow-actions/rfq-loading.js` → see also: stockrfq, vq-loading
- `shared/rfq-writer.js`, `shared/offer-writeback.js`, `shared/vq-writer.js`, `shared/cq-writer.js`, `shared/api-result-writer.js` → see all five loaders

…scan this file's entries from the last ~4 weeks for the other loaders. If a recent sibling change looks applicable, apply it. If it doesn't, add a one-line "doesn't apply because X" annotation when you commit your work.

## Entry format

Newest at the top. One row per commit. Columns:

| Date | Loader(s) touched | Change | Cross-applies? | Commit |

The "Cross-applies?" column is the load-bearing one — say which sibling loaders the change does or doesn't extend to, with a one-line reason if not.

---

## Loader Applicability Matrix

Use this matrix to quickly determine which changes apply across loaders.

### Change Categories

| Category | Description | Typical Scope |
|----------|-------------|---------------|
| **Shared resolver** | BP, MFR, contact lookup changes | ALL loaders using that resolver |
| **Writer pattern** | Chunking, retry, attribution | All writers of same shape (batch vs single-record) |
| **Handler pattern** | Idempotency, breadcrumbs, email threading | All handlers with same architecture |
| **Email escalation** | Recipient routing, formatting, threading | All email-driven workflows |
| **Extraction logic** | Parsing, validation, field mapping | Usually workflow-specific |
| **Edge case fix** | Bean-callout trap, API quirk | All writers hitting that API endpoint |

### Loader Shape Reference

| Loader | Write Shape | Architecture | Sends Confirmation | External Recipients |
|--------|-------------|--------------|-------------------|---------------------|
| **rfq-loading** | Batch (queue-backed) | Daemon + handler | ✅ Yes | ❌ Internal only |
| **vq-loading** | Batch (inline) | Handler | ✅ Yes | ❌ Internal only |
| **stockrfq** | Single-record | Handler | ❌ No | ❌ N/A |
| **stockrfq-cq** | Single-record | Handler | ❌ No | ❌ N/A |
| **excess/offers** | Batch (inline) | Handler | ✅ Yes | ⚠️ Configurable |

### Quick Applicability Rules

1. **Confirmation email changes** → rfq-loading, vq-loading, excess/offers (not stockrfq/cq)
2. **Rate-limit / chunking** → all batch writers (rfq-writer, vq-writer, offer-writeback)
3. **Message-ID dedup** → all handlers (pattern differs: queue-backed vs inline)
4. **Failure-rate gate** → batch loaders only (need >10 items for meaningful rate)
5. **Writer attribution** → all loaders (helper handles both batch + single-record)
6. **Reply stitching** → all email-driven handlers with escalation paths

---

## 2026-06-25

| Date | Loader(s) | Change | Cross-applies? | Commit |
|---|---|---|---|---|
| 2026-06-25 | rfq-loading, vq-loading, excess, broker-offers | **Aligned confirmation email format.** Standardized what each loader shows in success confirmations. **RFQ:** Customer, RFQ #, Type, Seller, Lines, Description. **VQ:** Customer, RFQ #, Buyer, VQs, Vendors (no type/description - N/A). **Excess/Broker:** Partner, Offer #, Type, Contact (Jake Harris), Lines, Description. Added lookup helpers: `lookupRfqTypeName`, `lookupContactName`, `lookupCustomerFromRfq`, `lookupOfferTypeName`. All breadcrumbs now include metadata for audit. | **APPLIED TO ALL** confirmation-sending loaders. stockrfq + stockrfq-cq don't send confirmations. | _(uncommitted)_ |
| 2026-06-25 | (shared poller) | **Stuck email recovery: reduced grace period.** Changed `STUCK_MIN_AGE_MINS` from 60 to 20 minutes. Emails that arrive pre-marked SEEN now recover in 20 min instead of 60. Root cause: "FW: Critical parts" sat stuck because it arrived SEEN. | ALL email workflows benefit (shared poller change). | _(uncommitted)_ |
| 2026-06-25 | (shared) | **Created `shared/loader-patterns.js`.** Extracted reusable patterns: `classifyApiError()` (transient vs permanent), `withRetry()` (exponential backoff), `retryLine()` (line-level retry wrapper). Ready for incremental adoption by rfq-fast-loader.js and offer-writeback.js. | ALL batch writers can adopt. Single-record writers (stockrfq, cq) less critical but can use. | _(uncommitted)_ |
| 2026-06-25 | (infra) | **Added pre-commit hook for loader-changelog reminder.** `.git/hooks/pre-commit` prints a reminder when any loader file is modified. Non-blocking — just a nudge to check cross-applicability. | N/A (infrastructure). | _(uncommitted)_ |
| 2026-06-25 | rfq-fast-loader, offer-writeback | **Wired `retryLine` from `loader-patterns.js`.** Line-level writes now retry transient errors (503, ECONNRESET, rate-limit 429) with exponential backoff (max 3 attempts, 500ms→10s delays). Reduces partial-load failures from transient API flakiness. | **APPLIED TO BOTH** batch writers. Single-record writers (stockrfq, cq) less critical — can adopt if needed. | _(uncommitted)_ |
| 2026-06-25 | rfq-loader-daemon, excess | **Wired `evaluateFailureRate` from `failure-rate-gate.js`.** After load completes, checks if error rate exceeds threshold. If so: logs warning, writes `high-failure-rate` breadcrumb, sends alert email to operator. Matches VQ loader pattern. | **APPLIED** to both queue-backed (rfq-loading) and inline (excess) batch loaders. vq-loading + stockrfq-cq already had this. stockrfq doesn't need it (single-record). | _(uncommitted)_ |
| 2026-06-25 | rfq-loader-daemon | **Added writer attribution logging.** `writerAttribution.persistWriterDetails()` now called after load completes. Persists count-style errors[] to `~/.writer-attribution.jsonl` for post-mortem forensics. excess.js already had this. | **Pattern extended** to rfq-loading. excess + broker-offers already have it. VQ uses bucket-style (richer). stockrfq + cq use single-record writes (different shape). | _(uncommitted)_ |

---

## 2026-06-12

| Date | Loader(s) | Change | Cross-applies? | Commit |
|---|---|---|---|---|
| 2026-06-12 | excess, broker-offers | **Partner name lookup fallback.** Confirmation emails were showing `(unknown)` for partner name when the agent didn't pass `partnerName` in the `load_offer` payload. Added `lookupPartnerName(bpartnerId)` helper that queries the DB to resolve partner name from `bpartnerId`. Pattern matches `rfq-loader-daemon.js` fix from 2026-06-11. | **rfq-loading** already fixed in `rfq-loader-daemon.js`. **vq-loading** + **stockrfq** + **stockrfq-cq** don't send confirmation emails with partner names, so not applicable. | `bdae9cd` |

## 2026-06-05

| Date | Loader(s) | Change | Cross-applies? | Commit |
|---|---|---|---|---|
| 2026-06-05 | offer-writeback, rfq-writer, vq-writer, cq-writer | **Chunked mode for large batches.** Large batches were being rejected outright by the upfront budget check (OSIE 2,109-line excess list failed silently with `linesWritten: 0`). Now: batches above threshold bypass the upfront check and write in chunks with delays to self-pace under rate limits. Thresholds: offer/rfq 500 lines (150/chunk, 2s delay), vq 200 items (uses existing inter-item delays), cq 200 lines (100/chunk, 1.5s delay). All writers return `chunkedMode: true` when used. Also fixed: MPN coerced to string in offer-writeback (xlsx parsing returns numbers for numeric-looking MPNs). | **Applied to all four writers.** Pattern is identical across loaders. Future writers should include the same chunked-mode gate. `api-result-writer` skipped — writes single records, not batches. | `505e3a0`, `1577951` |

## 2026-05-26

| Date | Loader(s) | Change | Cross-applies? | Commit |
|---|---|---|---|---|
| 2026-05-26 | vq-loading | **Escalations internal-only.** Retired VQ's broker-outreach override AND the two-email split (`41b6362`). `resolveOutreachRecipients` now builds ONE internal recipient list (operator + internal forwarder + buyer via new `partner-lookup.resolveAstuteUserById(buyerId)` + internal Cc); the external broker is recorded (`externalSender`) but never emailed. `sendSplitRecipientEmail` collapsed to a single internal email; `recipientsFooter`/`externalSenderLabel` show the operator exactly who got it. Breadcrumb fields → `recipients` + `external_sender_not_emailed`. Trigger: UID 8684 — the split sent forwarder Ivy a separate copy the operator couldn't see, reading as "forwarder skipped." | **Operator-scoped to VQ only** (operator: "On VQs it should only be internal… this may apply differently to other loaders"). Do NOT propagate to stockrfq/excess/rfq-loading — several legitimately email external parties. The split-recipient pattern from `41b6362` was never adopted elsewhere. New `resolveAstuteUserById` helper in `partner-lookup.js` is shared/additive and safe for any loader to reuse. | _(uncommitted)_ |

## 2026-05-22

| Date | Loader(s) | Change | Cross-applies? | Commit |
|---|---|---|---|---|
| 2026-05-22 | vq-loading | Cross-workflow forward+park — vq-loading agent forwards unrecognized blocks to rfq-loading and parks the broker quotes; `vq-loading-resumer` cron picks them up after the new RFQ exists. New action `forward_to_rfq_loading` + sidecar kind `waiting_for_new_rfq` + dedicated cron. | Not directly applicable to other loaders today (no equivalent "create a parent record in another workflow" pattern). If a similar need surfaces (e.g., stockrfq-cq needing the CQ's parent RFQ created first), the pattern transfers. | `cb1ceb9` |
| 2026-05-22 | vq-loading | Deterministic envelope-From from poller (`ctx.currentFrom`) + multi-RFQ partition guidance in agent prompt. Recipient resolution now trusts the parsed envelope From over agent-supplied outerFrom; CC list includes any @astutegroup.com address from the original envelope Cc. | The poller-level change (`ctx.currentFrom`, `ctx.currentCc`) benefits ALL email-driven handlers automatically. Other handlers' escalation paths can adopt the same `resolveOutreachRecipients`-style logic if they grow the forwarder-vs-buyer recipient question. | `5410587` |
| 2026-05-22 | vq-loading | Clarify-suppression for vendors already loaded by the writer | Not needed elsewhere — the same-call partial-load + simultaneous-clarify pattern is VQ-only (broker emails carry multi-vendor batches). Other loaders handle one-record-per-email so the agent picks load-or-clarify, never both. | `0d6f09d` |
| 2026-05-22 | (shared) | `vendor-aliases.json` curated tier for acronyms like XJH | Resolver helper — benefits all loaders that call `resolveBP`. No per-loader wiring needed. | `fefc2cc` |
| 2026-05-22 | vq-loading | `matchMpnToLine` asymmetric ≥6 threshold (lets 7-char RFQ MPNs accept cross-ref offers) | Specific to load-bulk-summary; not used by other loaders. | `9452120` |
| 2026-05-22 | (shared writer) | `mfr-resolver` historical-VQ fallback (opt-in `consultMfrHistory`) | Resolver helper — opt-in flag set in vq-writer + cq-writer. No additional wiring needed elsewhere. | `68a6ab3` |
| 2026-05-22 | rfq-loading | Two-layer Message-ID dedup (handler check + queue-level in-flight dedup + daemon emits `rfq-loaded`) | stockrfq + excess already covered by handler-level Message-ID dedup (commit `2a04ffe`). rfq-loading specifically needed the queue layer because its writes happen out-of-band in `rfq-loader-daemon`. | `b683323` |
| 2026-05-22 | (shared resolver) | `resolveBPHistorical` — historical-VQ fallback for short broker labels | Wired into load-bulk-summary (vq-loading callers). Not wired into offer-writeback / rfq-writer / cq-writer because those resolve via different paths; revisit if Yuexunfa-class issues appear in those workflows. | `dfd896b` |
| 2026-05-22 | vq-loading, stockrfq-cq | Failure-rate gate — operator email when failed/skipped rate exceeds threshold | NOT wired into stockrfq + excess because they use count-style writers (errors[] only); the gate's bucket-rate analysis doesn't apply. Revisit if those workflows ever start submitting batches large enough to need rate analysis. | `106abdb` |
| 2026-05-22 | vq-loading, stockrfq-cq, stockrfq, excess | `writer-attribution` per-row failure/skip log to `~/workspace/.writer-attribution.jsonl` | Applied to all four bucket-style + count-style handlers. Helper handles both shapes. | `9823ede` |
| 2026-05-22 | stockrfq, excess | Handler-level Message-ID dedup via `breadcrumbs.hasMessageIdAlreadyLoaded()` | rfq-loading covered separately by `b683323` (queue-backed, different shape). vq-loading + stockrfq-cq skipped — they already have row-level writer dedup (`PRE_EXISTING_DUPLICATE` / `DUP_EXISTING_CQ`). | `2a04ffe` |
| 2026-05-22 | (shared writer) | `load-bulk-summary` propagates writer's `skipped[]` correctly (the original UID 8541 bug) | Audited all five writers + their callers; only `load-bulk-summary` had the misclassification bug. `stockrfq-cq.js` and `crossref-review.js` already read `result.skipped[]`. Count-style writers (rfq/offer) don't have a `skipped[]` bucket — different shape, no same-class bug. | `80c9c38` |
