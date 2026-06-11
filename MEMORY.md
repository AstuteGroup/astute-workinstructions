# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere
- **CPC (Customer Part Code)** — Customer's internal part number. Also called Customer Part Number. "LAM CPC" = LAM's part code (redundant but common usage)

## How to Send Emails

**NEVER use the `mail` command directly.** The basic `mail` command sends from `analytics_user@<hostname>` which doesn't work properly for external recipients.

**ALWAYS use the shared notifier system:**

```javascript
const { createNotifier } = require('./astute-workinstructions/shared/notifier');

const notifier = createNotifier({
  fromEmail: 'stockrfq@orangetsunami.com',  // or other OT email
  fromName: 'Descriptive Name'
});

// Simple email
await notifier.sendEmail('jake.harris@astutegroup.com', 'Subject', 'Body text');

// With attachment
await notifier.sendWithAttachment(
  'jake.harris@astutegroup.com',
  'Subject',
  'Body text',
  [{ filename: 'report.txt', path: '/path/to/file.txt' }]
);
```

**Common sender addresses:**
- `stockrfq@orangetsunami.com` - Stock RFQ operations, reports, general automation
- `excess@orangetsunami.com` - Customer excess analysis
- `vortex@orangetsunami.com` - Vortex matches, sourcing recap

The notifier uses AWS WorkMail SMTP with credentials from `~/workspace/.env`. Works from `analytics_user` - other users route through writeback proxy (see `shared/writeback-proxy.md`).

## Recent Sessions

- **2026-06-11 (Budget Exhaustion Handling Overhaul)**: **Fixed inconsistent budget handling across all loaders after 256k writes in one day triggered budget exhaustion.** Root cause: June 10 inventory cleanup wrote 118k×2 offer lines, hitting 30k daily limit. Loaders handled this inconsistently — some routed to NeedsReview with manual-retry email, others silently moved to Processed with `offerId: null`. **Fixes:** (1) **Raised daily limit** 30k → 300k (256k proven safe; burst limits are real protection). (2) **Chunked mode now respects daily limit** — was bypassing all budget checks; now checks daily before starting. (3) **Poller checks `rateLimited: true`** — if handler returns this, email stays UNSEEN for auto-retry on next cycle (no notification). (4) **All handlers propagate `rateLimited`** — broker-offers.js, excess.js, stockrfq-cq.js now check writer result and return rateLimited to poller. (5) **Recovery script** `scripts/recover-budget-stuck.js` — moves emails from NeedsReview or Processed back to INBOX. Supports `--folder` and `--uids` options. **Recovery performed:** 1 from broker-offers NeedsReview, 4 from stockrfq NeedsReview, 8 from vq-loading NeedsReview, 14 from broker-offers Processed = 27 emails total moved back to INBOX for reprocessing. **Writers updated:** offer-writeback.js, rfq-writer.js, cq-writer.js, vq-writer.js. Commits: `064d133`, `b0aa5ee`, `c6db717`, `765119b`, `663637c`.
- **2026-06-08 (NC Listing Fix + Inventory Cleanup Drift)**: **Fixed `nc-listing` cron job that was broken since refactor.** Root cause: job used `cadence: 'twice-weekly'` but `cadenceToMs()` didn't support it — crashed on every tick with `Error: Unrecognized cadence: twice-weekly`. **Fixes:** (1) Added `twice-weekly` = 3 days to `cron-jobs.js`. (2) Ran `inventory-cleanup` manually (4,188 lines to OT). (3) Ran `nc-listing` manually (560 rows to NetComponents). (4) Re-anchored both sentinels to proper schedule times (inventory-cleanup: Mon 11 UTC, nc-listing: Mon/Thu 12 UTC) — they had drifted to ~20 UTC from late runs. **Also refactored `nc-listing` email logic:** Removed duplicate review copies to jake.harris@ — NetComponents emails already CC him, so 4 emails → 2 emails. Commits: `40c8a80`, `1011461`.
- **2026-06-04 (Stuck Email Detection + Auto-Recovery + Cleanup)**: **Fixed systemic gap where emails could get stuck in SEEN-but-not-processed state.** Root cause: when agent reads an email (marks SEEN) but crashes/pauses before routing, the email becomes invisible to the next `list` call. **Solution (3 parts):** (1) **Auto-recovery in poller** — `list` command now scans for SEEN emails >60 min old, clears their SEEN flag so they reappear. 24-hour cap prevents recovering ancient spam/test emails. (2) **Operations Digest detection** — new section shows stuck emails across all 4 workflows (vq-loading, excess, stockrfq, rfq-loading), separates auto-recoverable (60min-24h) from manual-review (>24h). (3) **New poller commands** — `check-stuck` (read-only monitoring) and `recover-stuck` (manual recovery with configurable threshold). **Also added:** Pause detection to digest (paused jobs now flagged). **Investigation origin:** Ivy's test emails (UID 8765/8768 to VQ inbox) didn't load AND didn't send failure notification because VQ loading agent was paused via `.vq-loading-agent-paused` file since June 2. **Cleanup (post-recovery):** Archived 37 old stuck emails across vq-loading/stockrfq/rfq-loading via new `scripts/archive-stuck-emails.js`. Excess inbox had 8 stuck from May 8-22 — reviewed individually: archived 8 junk (spam, RFQs-not-offers, partial forwards), recovered 3 legitimate offers (USI Mexico, Benchmark Romania, DFI) by clearing SEEN flag. **Root cause of May 8-22 excess stuck emails:** Agent WAS running (confirmed by offers created with "excessAgent" in description), but specific edge-case emails got stuck because agent read them, determined they weren't actionable, but failed to route them to a folder (NotOffer/NeedsReview). Not crashes — routing gaps. The auto-recovery and archive scripts now handle this. Scripts: `archive-stuck-emails.js`, `move-uids-to-archive.js`. Commit: `64d906e`.
- **2026-05-26 (VQ Unknown Vendor Exception + Cron Pause/Resume Planning)**: **Built exception for VQ loading when vendor BP doesn't exist in OT.** Instead of blocking on `needs_vendor`, can now load VQs with vendor name stored in `Chuboe_Note_User`. **Implementation:** (1) `vq-writer.js` — added `unknownVendorPlaceholderBpId` option; when BP resolution fails and option is set, use placeholder BP and prepend "Vendor: <name>" to notes. (2) `load-bulk-summary.js` — added parameter, passes through to writer. (3) `vq-loading.js` — added `UNKNOWN_VENDOR_PLACEHOLDER_BP_ID` constant with setup instructions. **Use case (Nordisk, UID 8655/8668):** 2 quotes stuck because Nordisk BP doesn't exist; operator requested "note vendor in VQ notes" instead of creating BP. **Setup required (one-time):** Create placeholder BP in OT (Name: "Unknown Vendor - Note in VQ", Search Key: "UNKNOWN-VENDOR-VQ-NOTE", Vendor Type: 1000010), set constant to BP ID. **Test script:** `oneoffs/test-unknown-vendor-nordisk-2026-05-26.js` shows manual load example. **Deferred:** Automatic reply detection for "note vendor in VQ notes" phrase (tomorrow). **Cron pause:** All background jobs paused at 22:51 UTC due to system overload concerns. **Resume plan documented** in `deferred-work.md`: 5-phase approach (assess backlog → clear old → utilities → agents staged → monitor). Decision points: skip archiving if <100 emails; stage agents or all-at-once; token budget cap. Commits: `599ba3c`, `81eea17`.

---

## Reconciliation Adjustments

### COV0019122 NRE Credit Adjustment (2026-03-09)

**Problem:** COV0019122 NRE was originally charged at $551,259.06 but was credited and reinvoiced at $504,184.94. The $43,822.11 difference needed to be applied to specific parts for accurate buyer GP.

**Solution:** Used subset-sum algorithm to find exact combination of 9 parts totaling $43,822.11:

| MPN | Contract Base | Buyer |
|-----|---------------|-------|
| K86X-BD-44S-BR | $10,430.65 | Jake Harris |
| ATQR15 | $4,835.88 | Jake Harris |
| LT8645SHV-2#PBF | $4,719.89 | Tracy Xie |
| RC0805FR-0768R1L | $4,670.64 | Jake Harris |
| ESQ-120-39-G-D-DP-TR | $4,625.79 | Jake Harris |
| ERJ-P06J103V | $4,580.58 | Jake Harris |
| SML-E12U8WT86 | $4,575.12 | Jake Harris |
| FT230XS-R | $2,808.42 | Jake Harris |
| RCS080510K0FKEA | $2,575.14 | Jake Harris |
| **TOTAL** | **$43,822.11** | |

**Buyer GP Impact:**
- Jake Harris: -$39,102.22
- Tracy Xie: -$4,719.89

**Files:**
- `Trading Analysis/LAM Billings Review/Stale Inventory/Final/LAM_Buyer_GP_Summary_2024-2025.csv` — Adjusted GP totals (includes this adjustment)
