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

- **2026-06-17 (Inventory Profiler & Resale Assignment Architecture)**: **Built clean inventory profiler cog and diagnosed critical market profiling coverage gap.**

  **Problem Identified:** Market profiling coverage was ~0.03% (1,022 of 3.6M MPNs). The existing `market-profiler.js` was stuck — reusing exhausted RFQs and finding 0 parts to process. Root cause: profiler didn't handle weekly inventory refreshes or create new RFQs when current one was fully scraped.

  **New Profiler Built:** Created `inventory-profiler.js` with:
  - Weekly RFQ naming: "Inventory Profile YYYY-WXX"
  - **Reconciliation across ALL profile RFQs** — queries actual VQs (cost=0), not watermark file
  - **Bucket support:** `--bucket all/free-stock/consignment/franchise`
  - **Rate control:** `--rate N` MPNs per hour
  - **Full run mode:** `--full` ignores "recently profiled" check for clean slate
  - 10-minute batching with progress reporting and error recovery

  **Full Profile Run Started:** 3,179 MPNs at 100/hour, ~32 hours to completion (RFQ 1137548 "Inventory Profile 2026-W25"). Will provide NC vendor counts for entire inventory.

  **Resale Assignment Logic Designed:** For Active Sourcing batches (delisted parts that were price-checked):
  - Broker VQs = primary price driver (competitors)
  - Franchise data = strategy modifier (long lead/EOL → SCARCITY → price above market; well-stocked → COMMODITY → cap at market)
  - Classification: SCARCITY (≤2 sources OR long lead), COMMODITY (500+ stock, 4+ sources), MIDDLE
  - Alignment flags: UNDERSOLD, QUOTING_LOW, QUOTING_HIGH, CQ_ALIGNED
  - Target resale = broker_high × 1.10 (scarcity) OR broker_low × 0.95 (commodity) OR broker_mid (middle)
  - Floor = broker_low × 1.10 (minimum 10% margin)

  **Key Insight:** Can't classify scarcity from VQ count alone — need NC profile data to distinguish "few vendors exist" vs "few vendors responded to this RFQ." Hence the full profile run first.

  **Files Created:**
  - `Trading Analysis/Market Profiling/inventory-profiler.js` — New profiler cog
  - `Trading Analysis/Inventory Recommended Resale/test-resale-logic.js` — Resale logic tester

  **Next Steps:** After profile run completes (~Thursday), use data for delist prioritization and wire up resale assignment.

- **2026-06-11 (CLAUDE.md Refactor)**: **Refactored CLAUDE.md from 41.8k chars to 9.3k chars (77% reduction) to fix performance warning.** Root cause: CLAUDE.md had drifted into a catch-all, duplicating content from workflow-specific docs (Inventory File Cleanup, Quick Quote) and embedding full procedural docs inline. **Solution:** Created `docs/` folder with extracted content: (1) `docs/session-greeting.md` — full 8-step startup procedure. (2) `docs/workflow-catalog.md` — 26 workflows with descriptions and trigger patterns. (3) `docs/environment.md` — DB access, write-back rules, commands, file system. Both CLAUDE.md files now follow index pattern: behavioral rules inline, everything else via pointers. **Also slimmed in-repo version:** `astute-workinstructions/CLAUDE.md` went from 653 lines (~40k chars) to ~180 lines (7.2k chars) — 83% reduction. Commits: `b1538c8`, `a839c4c`.

- **2026-06-11 (Delisted Parts Pipeline)**: **Major overhaul of Active Sourcing to source from DELISTED parts instead of current inventory.** Changes: (1) `inventory_cleanup.js` now tracks delta (prior - current week offers), writes delisted MPNs to `~/.delisted-parts-queue.json`. (2) `selection-engine.js` reads from delisted queue instead of current inventory offers. (3) `active-sourcing-runner.js` marks MPNs as sourced after processing, sends batch digest email with queue progress %. (4) First pass completion notification when all delisted parts sourced. (5) Profile VQ deactivation when real priced VQs arrive (same MPN/vendor within 10 days). (6) Broker VQ consolidation (multiple rows same MPN/vendor → 1 VQ with total qty). (7) NC scraper skips franchised suppliers (ncauth CSS class) — franchise data comes via APIs. (8) Re-enabled inventory gate (waits for NC upload confirmation before sourcing). **Key distinction:** Profiled parts (current inventory) → NC scrape only, no API calls. Delisted parts → full treatment (API enrichment + NC RFQ). **Documentation:** Updated `market-profiling.md` with full pipeline docs. Commits: `614468e`, `898aac3`, `9192d5c`, `7e8a73f`.

- **2026-06-11 (Budget Exhaustion Handling Overhaul)**: **Fixed inconsistent budget handling across all loaders after 256k writes in one day triggered budget exhaustion.** Root cause: June 10 inventory cleanup wrote 118k×2 offer lines, hitting 30k daily limit. Loaders handled this inconsistently — some routed to NeedsReview with manual-retry email, others silently moved to Processed with `offerId: null`. **Fixes:** (1) **Raised daily limit** 30k → 300k (256k proven safe; burst limits are real protection). (2) **Chunked mode now respects daily limit** — was bypassing all budget checks; now checks daily before starting. (3) **Poller checks `rateLimited: true`** — if handler returns this, email stays UNSEEN for auto-retry on next cycle (no notification). (4) **All handlers propagate `rateLimited`** — broker-offers.js, excess.js, stockrfq-cq.js now check writer result and return rateLimited to poller. (5) **Recovery script** `scripts/recover-budget-stuck.js` — moves emails from NeedsReview or Processed back to INBOX. Supports `--folder` and `--uids` options. **Recovery performed:** 1 from broker-offers NeedsReview, 4 from stockrfq NeedsReview, 8 from vq-loading NeedsReview, 14 from broker-offers Processed = 27 emails total moved back to INBOX for reprocessing. **Writers updated:** offer-writeback.js, rfq-writer.js, cq-writer.js, vq-writer.js. Commits: `064d133`, `b0aa5ee`, `c6db717`, `765119b`, `663637c`.

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
