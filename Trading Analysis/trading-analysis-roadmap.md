# Trading Analysis Roadmap

Consolidated roadmap for Trading Analysis workflows.

---

## Workflows

| Workflow | Location | Status |
|----------|----------|--------|
| Vortex Matches | `Vortex Matches/` | Operational |
| Quick Quote | `Quick Quote/` | Operational |
| **Live Opportunities (RFQ → Offers)** | `Market Offer Matching for RFQs/` | Operational |
| **Proactive Opportunities (Offers → Historical)** | `Market Offer Matching for RFQs/` | Partial |
| Inventory File Cleanup | `Inventory File Cleanup/` | Operational |
| LAM Kitting Reorder | `LAM Kitting Reorder/` | Operational |
| LAM EPG Award | `LAM EPG Award/` | In Progress |
| Stock Market Analysis | — | Planned |
| CQ Writeback | `shared/cq-writer.js` | Operational (writer); QQ integration Planned |

---

# Section A: Vortex Matches

| # | Feature | Priority | Status |
|---|---------|----------|--------|
| A1 | Refine Opportunity Amount Calculation | **Next** | Planned |
| A2 | Filter Low % of Demand Matches | **Next** | Planned |
| A3 | MPN Variant Matching | Later | Planned |
| A4 | Vortex output redundancy investigation + cleanup | **Next** | Planned |

---

## A1. Refine Opportunity Amount Calculation

**Status:** Planned | **Priority:** Next

**Problem:** Current Opp Amount = `RFQ Target × RFQ Qty`. This doesn't account for:
- Supplier quantity available (may be less than RFQ qty)
- Actual potential GP (need to factor in supplier price)

**Solution Options:**
1. `MIN(Supplier Qty, RFQ Qty) × RFQ Target` — capped by available qty
2. `MIN(Supplier Qty, RFQ Qty) × (RFQ Target - Supplier Price)` — actual GP opportunity
3. Both columns: Opp Amount (revenue) + Opp GP (margin)

**Decision:** TBD

---

## A2. Filter Low % of Demand Matches

**Status:** Planned | **Priority:** Next

**Problem:** Stock and other matches with very low % of Demand clutter the output:
- Customer needs 100,000 pcs, we have 50 pcs (0.05%)
- Not worth pursuing — creates noise

**Solution:**
- Add configurable threshold (e.g., minimum 5% of demand)
- Apply especially to Stock file where we control inventory
- Option: separate "Partial Coverage" file for matches between 5-50%

**Thresholds to Consider:**

| % of Demand | Action |
|-------------|--------|
| < 5% | Exclude (not worth the effort) |
| 5-50% | Include, flag as partial |
| > 50% | Include (meaningful coverage) |

---

## A4. Vortex Output Redundancy Investigation + Cleanup

**Status:** Planned | **Priority:** Next
**Discovered:** 2026-04-08 — Jake ran Vortex on RFQ 1132021 (Sanmina PPV, 208 lines / 872 line-MPNs) and observed a lot of redundant data. Initial 30-second DB check confirmed: **the redundancy is real in the database, not just a Vortex display issue.**

### Two distinct concerns to address (Jake's framing)

1. **Are the redundant rows duplicate VQs in the DB, or is it a Vortex output/aggregation issue?** → **Both, but the DB dup is the bigger one and is brand new from today's enrichment.**
2. **Does the Vortex output clearly distinguish stock-available pricing vs lead-time pricing?** → Unverified, needs a look. These are fundamentally different supply commitments and Jake needs to see them as such — stock = "ship now" actionable, lead-time = "contractual quote, no stock today."

### Finding 1 (CORRECTED 2026-04-08): The redundancy is upstream in `chuboe_rfq_line_mpn` — pre-dates today's enrichment work

Initial hypothesis was that `enrich-rfq.js` was over-writing. Verified with the DB and the picture is different: **`chuboe_rfq_line_mpn` itself has duplicate rows for the same `(chuboe_rfq_line_id, chuboe_mpn_clean)` pair**, and these dups have existed at the RFQ-load layer for an unknown period (the table has rows going back well before today). My enrichment iterates the table faithfully and writes one VQ per row, so the dup amplifies into VQ writes — but the **root cause is at RFQ load time, not at enrichment time, and was present in the database before any RFQ API Enrichment work ran.**

**Important timeline distinction (corrected after Jake flagged confusion):**
- **`chuboe_rfq_line_mpn` dup pattern:** Pre-existing, long-standing. The loader (whichever path inserts into `chuboe_rfq_line_mpn` for PPV RFQs) has been creating dup rows for weeks/months. The 30-day audit below is on this upstream source data.
- **`chuboe_vq_line` writes from RFQ API Enrichment:** Today only. One run on RFQ 1132021, ~858 VQ writes (~490 of which are dup-amplifications of the upstream source). The cron has been **disabled** until this is resolved so no further amplification happens.

**Verification on RFQ 1132021 (the original sample):**

Same MPN `1843363` is on **only ONE RFQ line** (`chuboe_rfq_line_id = 3069363`, qty 4500), but appears in `chuboe_rfq_line_mpn` **4 times** as exact duplicate rows. Same vendor quoting that one line in my enrichment → 4 VQ writes per vendor per MPN. The user explicitly noted: "there are RFQ lines where the customer has the same part and different qtys so I get that, but this is more than that" — this confirms it. Same-part-different-line is a separate (legitimate) case; this is same-part-same-line dupes in the sub-table.

**RFQ 1132021 totals:** 872 line-MPN rows, **377 distinct (line_id, mpn) pairs**, **495 exact duplicates (57%)**. This RFQ is severely deduplicated.

**The pattern is RFQ-type-correlated, last 30 days:**

| RFQ Type | RFQs | Total line-MPNs | Dups | Dup % |
|---|---:|---:|---:|---:|
| **PPV** | 97 | 5,104 | **675** | **13.2%** |
| Shortage | 875 | 5,144 | 253 | 4.9% |
| EOL/LTB | 82 | 184 | 5 | 2.7% |
| Astute Franchised | 16 | 86 | 2 | 2.3% |
| 3PL/VMI | 15 | 943 | 3 | 0.3% |
| Stock / Hot Parts / Proactive | 16 | 53 | 0 | 0% |

PPV is systematically duplicated and RFQ 1132021 is an extreme outlier even within PPV (57% vs 13.2% average). Strong hypothesis: PPV RFQs come from customer Excel files (often Sanmina-shaped) where the source data has duplicate rows or where the alt-MPN expansion logic emits dupes instead of distinct rows. The loader (`rfq-writer.js` or whatever ingests PPV files) doesn't dedup at insert time.

### The real fix is upstream

The enrichment-side defensive dedup is a band-aid. The actual fix is:

1. **At RFQ load time** — whichever loader handles PPV RFQs (likely `rfq-writer.js` called from the RFQ Loading workflow, or a customer-file ingestion path) needs a UNIQUE constraint or pre-insert dedup on `(chuboe_rfq_line_id, chuboe_mpn_clean)`. Identical sub-rows for the same line+MPN serve no purpose — alt-MPNs should be DIFFERENT MPNs.
2. **Backfill cleanup** — for the existing 938 dup rows across recent RFQs (675 PPV + 253 Shortage + a few others), mark inactive. Leave one per `(line_id, mpn)`.
3. **Audit other consumers** — any workflow that reads `chuboe_rfq_line_mpn` (Vortex, market offer matching, RFQ API Enrichment, suggested resale, BOM monitoring) is probably double-counting silently. The user-visible Vortex redundancy is just the most obvious symptom.

### Defensive dedup in enrich-rfq.js (near-term mitigation)

While the upstream fix is being scoped, `enrich-rfq.js` should defensively dedup its work list:

```javascript
// In enrichRFQ(), after fetchRFQLines()
const seen = new Set();
const dedupedLines = lines.filter(l => {
  const key = `${l.chuboe_rfq_line_id}|${l.chuboe_mpn_clean}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});
```

~5 line change. Eliminates the 4× write amplification on PPVs immediately, while the upstream loader fix is being scoped. Doesn't fix existing dups in the DB.

### Existing dup VQs from today's enrichment of 1132021

Today's run wrote 858 VQs across this RFQ. With the 57% upstream dup ratio, the unique-quote count is closer to ~370. Roughly **490 dup VQ rows** from today need to be cleaned up before Vortex output will look reasonable. Cleanup query: keep `MIN(chuboe_vq_line_id) GROUP BY (chuboe_rfq_id, chuboe_rfq_line_id, chuboe_mpn, c_bpartner_id, cost)`, mark the rest inactive.

### Finding 2: Vortex output / display redundancy (separate from DB dups)

Even after the DB dups are fixed, Vortex may still have output-layer redundancy worth cleaning up:

- **Multiple distributors quoting the same part** — legitimate, but presented row-per-distributor when the user wants row-per-MPN with distributors collapsed into a "vendors" column or sub-rows.
- **Stock + offer + VQ + api_result** — four supply sources, may surface the same physical stock from different angles (e.g., a franchise distributor stocking a part shows up as both a "vendor with stock" AND a "VQ from today's enrichment").
- **api_result thin-pointer rows mixing with chuboe_vq_line.** Today's RFQ API Enrichment wrote 28 thin-pointer rows for live API calls. If Vortex pulls from both tables without distinguishing audit-trail rows from real VQs, there's double counting on top of the DB dup issue.

### Finding 3 (to verify): stock vs lead-time pricing clarity

Tomorrow's check:
1. Open today's Vortex xlsx for 1132021.
2. Pick a part where multiple vendors quoted with mixed stock/lead-time states.
3. Verify the user can tell at a glance: which rows have stock available right now (qty > 0) vs which are lead-time-only quotes (qty = 0, lead_time set).
4. If unclear, propose a column reorg: split into "Stock Available" (qty + price) and "Lead-Time Quote" (lead time + price), or color/icon coding, or split into separate sheets.

VQ-side fields involved:
- `chuboe_vq_line.qty` — stock-on-hand at the vendor when quoted (0 = no stock)
- `chuboe_vq_line.chuboe_lead_time` — string field, e.g. "12 weeks", "Stock", "8-10 wks ARO"
- `chuboe_vq_line.cost` — quoted unit price

### Tomorrow's action plan to eliminate dup amplification moving forward

**Cleanup status as of EOD 2026-04-08:** RFQ 1132021 already cleaned up via `scripts/dedup-vqs-1132021.js` — 502 dup VQ rows deactivated (commit `93e125f`). Pre-existing upstream dups in `chuboe_rfq_line_mpn` are still there (~938 rows over 30d, PPV-concentrated). Cron is **disabled** so no further amplification is happening.

**The five things to do tomorrow to eliminate this moving forward:**

1. **Find the upstream loader writing duplicate `chuboe_rfq_line_mpn` rows.** Likely candidates:
   - `shared/rfq-writer.js` (REST API path) — check the `chuboe_rfq_line_mpn` insert logic. Does it iterate a deduped list or pass through whatever the caller hands it?
   - The PPV / Sanmina file ingestion path — find which workflow actually loads PPV RFQs (probably under `Trading Analysis/RFQ Loading/`). Is it parsing customer Excel files where the same MPN appears on multiple rows and inserting all of them?
   - The iDempiere UI mass-upload path (CSV uploaded through the OT UI) — outside our code, but worth knowing if that's the root.
   - Verify which path is responsible for the actual rows on RFQ 1132021 specifically — query `chuboe_rfq_line_mpn.created` + `createdby` for clues on which user/process created them.

2. **Add pre-insert dedup at the loader.** Wherever the dup-creating insert lives, dedup the input list on `(chuboe_rfq_line_id, chuboe_mpn_clean)` before writing. Optionally add a UNIQUE constraint to `chuboe_rfq_line_mpn` to make this enforceable at the DB layer (but constraint changes need iDempiere admin coordination, so the application-layer dedup is the practical fix).

3. **Backfill cleanup of pre-existing `chuboe_rfq_line_mpn` dups.** Same pattern as today's VQ cleanup: identify dup rows by `(chuboe_rfq_line_id, chuboe_mpn_clean)`, keep `MIN(chuboe_rfq_line_mpn_id)` per group, mark the rest `IsActive='N'` via `record-updater.js patchBatch`. Sweep all 30+ days of dup rows. Confirm afterward by re-running the audit query.

4. **Add defensive dedup to `enrich-rfq.js`.** Belt-and-suspenders — even after the upstream is fixed, the enricher should never write the same `(line_id, mpn, vendor, cost)` twice in a single run. ~5 line change in `enrichRFQ()`:
   ```javascript
   const seen = new Set();
   const dedupedLines = lines.filter(l => {
     const key = `${l.chuboe_rfq_line_id}|${l.chuboe_mpn_clean}`;
     if (seen.has(key)) return false;
     seen.add(key);
     return true;
   });
   ```
   This is independent of the upstream fix and protects against any future dup source.

5. **Audit other consumers reading `chuboe_rfq_line_mpn`.** Vortex Matches, Market Offer Matching, BOM Monitoring, Quick Quote, and any other workflow that joins through this sub-table is probably double-counting silently. Once the source is deduped, those consumers will look correct without code changes — but confirm there are no consumers that depend on the dup-as-feature semantic before deleting rows.

**Verify-after-fix checklist:**
- [ ] `SELECT COUNT(*) FROM chuboe_rfq_line_mpn WHERE rfq_id = 1141436 GROUP BY (line_id, mpn) HAVING count(*) > 1` returns 0 rows
- [ ] Re-run `enrich-rfq.js --rfq <fresh-test-rfq>` and confirm no `(line_id, mpn, vendor, cost)` duplicates land in `chuboe_vq_line`
- [ ] Re-run Vortex on 1132021 — output should be materially smaller and clearer
- [ ] Re-enable the `*/15` cron in crontab.md and `crontab -e`

### Plan of action for tomorrow's session

1. **First** — pick the per-line vs per-(RFQ, MPN, vendor) call. Quick discussion, then commit to one.
2. **Patch enrich-rfq.js** with the chosen dedup strategy.
3. **Backfill cleanup** — mark the existing dup VQs on RFQ 1141436 inactive (keep one per (MPN, vendor)). ~712 rows to deactivate if we keep the most-recent or first one.
4. **Re-run enrichment on a fresh test RFQ** to verify no new dups land.
5. **Re-run Vortex on 1132021** and inspect the output for the remaining (post-DB-cleanup) redundancy classes.
6. **Audit the stock-vs-lead-time presentation** in the Vortex xlsx. Propose layout changes if needed.
7. **Implement Vortex collapse** in `vortex-matches.js` if redundancy persists after step 4.
8. **Validate** by re-running on 1132021 and one un-enriched RFQ as a baseline comparison.

### Out of scope

- Don't change the email/recipient layer — the inbox-driven automation works fine. Output structure only.
- Don't refactor Vortex's SQL strategy wholesale until we know the DB-side dups are gone — could mask the real Vortex bugs.

### Files to look at

- `Trading Analysis/RFQ API Enrichment/enrich-rfq.js` — for the dedup fix
- `Trading Analysis/Vortex Matches/vortex-matches.js` — for output redundancy + stock/lead-time presentation
- `Trading Analysis/Vortex Matches/vortex-matches.md` — current behavior spec
- `shared/data-model.md` — for join patterns when reasoning about which tables Vortex pulls from

---

## A3. MPN Variant Matching

**Status:** Planned | **Priority:** Later

**Problem:** Currently uses exact `chuboe_mpn_clean` matching. Misses:
- Packaging variants (T&R vs Tube)
- RoHS variants (G suffix)
- Same base part, different suffix

**Solution:**
- Extend matching to include packaging-safe variants (from B6 logic in sourcing-roadmap)
- Flag compliance/spec variants for review
- Add `Match Type` column to output

**Depends on:** `mpn_variants.py` module from RFQ Sourcing

---

# Section B: Stock Market Analysis

| # | Feature | Priority | Status |
|---|---------|----------|--------|
| B1 | Warehouse Rotation Schedule | Later | Planned |
| B2 | Market Price Comparison | Later | Planned |
| B3 | Resale Price Recommendations | Later | Planned |

---

## B1. Warehouse Rotation Schedule

**Status:** Planned | **Priority:** Later

**Problem:** Need to systematically analyze inventory across warehouses to optimize resale pricing, but analyzing all warehouses at once is overwhelming.

**Solution:**
- Rotate through warehouses on a schedule (e.g., 1-2 warehouses per week)
- Prioritize high-value or slow-moving inventory
- Track last analysis date per warehouse

**Warehouses to Rotate:**
- Free Stock: W102, W104/W112, W108/W113, W109/W114
- Allocated: MAIN, W105

---

## B2. Market Price Comparison

**Status:** Planned | **Priority:** Later

**Problem:** Current inventory pricing may be stale or not competitive with market.

**Solution:**
- Pull recent VQ data for same MPNs
- Compare to market offers (from Market Offer Loading)
- Identify parts priced above/below market
- Factor in date codes, quantity breaks

**Inputs:**
- Warehouse inventory file (from Inventory File Cleanup)
- VQ history (last 90 days)
- Market offers

---

## B3. Resale Price Recommendations

**Status:** Planned | **Priority:** Later

**Problem:** Need data-driven resale pricing rather than gut feel.

**Solution:**
- Apply Quick Quote logic (min margin, min GP, fat margin fallback)
- Factor in inventory age/date code
- Consider market pricing from B2
- Generate recommended resale prices

**Outputs:**
- Pricing recommendations CSV
- Flagged items needing price adjustments

---

# Section C: LAM Kitting Reorder

| # | Feature | Priority | Status |
|---|---------|----------|--------|
| C1 | LAM Kitting Reorder Workflow | Complete | Operational |
| C2 | Purchase Optimizer | **Next** | Planned |

---

## C2. Purchase Optimizer

**Status:** Planned | **Priority:** Next

**Problem:** When placing POs for a full parts list, selecting the single cheapest vendor per line misses savings from splitting purchases across existing vendors and ignores vendor consolidation benefits (fewer POs, lower shipping).

**Solution:** Optimization tool that runs on top of sourced output:
1. First pass: assign full-coverage lines at best price → builds vendor list
2. Second pass: split partial-stock lines across **existing vendors only** (don't add vendors for partials)
3. Calculate **blended cost** for splits
4. **Prompt user** with optimization results before applying — show savings per line, let user accept/reject

**Key:** Blended cost is the primary metric. Prompt the user with options, don't auto-apply.

---

## C1. LAM Kitting Reorder Workflow

**Status:** Operational | **Priority:** Complete

**Problem:** LAM kitting warehouses (W111, W115) need inventory monitoring to trigger reorders, update lead times, and track historical sourcing.

**Solution:** `lam-kitting-reorder.js` — compares W111+W115 inventory to Excel thresholds, generates reorder alerts with historical sourcing data.

**Output:** `LAM_Reorder_Alerts_YYYY-MM-DD.csv` emailed to jake.harris@astutegroup.com

---

# Section D: Market Offer Matching

Two complementary workflows for matching market offers to demand:

| # | Workflow | Direction | Purpose | Status |
|---|----------|-----------|---------|--------|
| D1 | Live Opportunities | RFQ → Offers | Match new RFQs against existing offers for immediate fulfillment | Operational |
| D2 | Proactive Opportunities | Offers → Historical + Market | Match new offers against historical RFQs + market conditions for proactive outreach | Partial |

---

## D1. Live Opportunities (RFQ → Offers)

**Status:** Operational | **Trigger:** New RFQs

**Purpose:** When new RFQs arrive, identify existing market offers that can fulfill the demand.

**Data Sources:**
- **RFQs:** New RFQs from database (incremental, tracks last processed)
- **Offers:** Customer Excess offers in database (90-day lookback)

**Process:**
1. Get new RFQs since last run
2. Match against Customer Excess offers (type_id = 1000000)
3. Calculate opportunity value and coverage
4. Tier results (TIER_1/2/3)
5. Output `Excess_Match_MM-DD_RFQ_[start]-[end].csv`

**Documentation:** `Market Offer Matching for RFQs/market-offer-matching.md`

**Limitation:** Offers must be imported to database first. Does not see offers still in CSV form.

---

## D2. Proactive Opportunities (Offers → Historical + Market)

**Status:** Partial | **Trigger:** New market offers uploaded

**Purpose:** When new market offers arrive, identify historical demand signals and market conditions for proactive sales outreach.

**Data Sources:**
- **Offers:** New offers from CSV (just extracted, not yet in DB)
- **Historical RFQs:** ALL RFQ history (not time-limited) — demand signal doesn't expire
- **Market Conditions:** VQ history, pricing trends, related offers (TBD)

**Process:**
1. Extract offers from CSV (Market Offer Loading Step 1-6)
2. Match MPNs against ALL historical RFQs
3. Pull market intelligence (VQ pricing, demand frequency, last activity)
4. Identify proactive outreach opportunities
5. Output actionable report

**Current Implementation:** `analyze-new-offers.js` — partial (180-day RFQ lookback only, no market conditions)

**Gaps to Address:**
| Gap | Description | Priority |
|-----|-------------|----------|
| D2.1 | Expand RFQ lookback to ALL TIME (or configurable 2+ years) | Next |
| D2.2 | Add market conditions: VQ pricing history for matched MPNs | Next |
| D2.3 | Add demand frequency: how often has this MPN been requested? | Next |
| D2.4 | Add recency signal: when was the last RFQ for this MPN? | Next |
| D2.5 | Add customer context: which customers have requested this? | Later |

**Output Columns (Target):**
```
offer_mpn, offer_qty, offer_price, offer_partner,
historical_rfq_count, last_rfq_date, customers_requested,
avg_vq_cost, min_vq_cost, max_vq_cost, last_vq_date,
demand_signal_strength, recommended_action
```

---

## D3. Offer Writeback — Known Issue Pattern: System-Level MFR IDs

**Status:** Already handled in `shared/offer-writeback.js` (line 167–172) — documented here so future refactors don't reintroduce the bug.

**Symptom:** Offer line MPN writes return HTTP 500 with `"System ID XXXX cannot be used in Chuboe_MFR_ID"`. Caused by passing a `Chuboe_MFR_ID` that points to a system-level `chuboe_mfr` record (`AD_Client_ID=0`).

**Root cause:** Most well-known MFRs (TI, Vishay, Bourns, Rohm, TDK, Coilcraft, etc.) only exist in `chuboe_mfr` at the system level. Client-level mirror records would need to be created by an iDempiere admin — impractical for hundreds of MFRs. So system-level records are the norm, not the exception.

**Fix (already implemented in offer-writeback.js):**
```js
// Skip system-level (AD_Client_ID=0) MFR IDs - they cause:
// "System ID XXXX cannot be used in Chuboe_MFR_ID"
linePayload.Chuboe_MFR_Text = mfrResult.canonical;
if (mfrResult.id && !mfrResult.isSystem) {
  linePayload.Chuboe_MFR_ID = mfrResult.id;
}
```
Always set `Chuboe_MFR_Text`. Only set `Chuboe_MFR_ID` when the resolved record is non-system. The server's bean callout resolves system-level MFRs from text at write time.

**Same pattern required in:** `rfq-writer.js`, `vq-writer.js`, `cq-writer.js`, `offer-writeback.js`. All four currently implement it correctly. **If you refactor any of these writers, preserve the conditional `Chuboe_MFR_ID` logic** — see also the matching note in Section G1.

**Connection to H1:** This is the immediate write-time fix. **H1 (MFR Backlog Reconciliation)** is the longer-term fix that backfills the FK on existing rows after an admin creates a client-level MFR record. Different problems, complementary solutions.

---

# Completed Items

## Section A: Vortex Matches
- [x] Initial implementation — match RFQs to VQs/MOs/Stock
- [x] Stock file separation (Astute inventory always shown)
- [x] Good Prices / All Prices / No Prices categorization
- [x] RFQ line deduplication (MPN + Qty + Target + CPC)
- [x] Column cleanup (removed RFQ Manufacturer, Vendor Grade)
- [x] MO Type blank for VQs (only applies to Market Offers)
- [x] % Under Target moved to column B in Good Prices
- [x] Decimal precision preserved for prices
- [x] % of Demand as actual percent format

---

# Version History

| Date | Section | Changes |
|------|---------|---------|
| 2026-03-09 | A | Vortex Matches initial setup |
| 2026-03-10 | A | Full implementation: deduplication, column cleanup, MO Type fix |
| 2026-03-17 | C | LAM Kitting Reorder: Operational |
| 2026-03-17 | D | Added Market Offer Matching section with D1 (Live) and D2 (Proactive) workflows |
| 2026-03-26 | E | Added Franchise API MOQ Handling section |

---

# Section E: Franchise API MOQ Handling

| # | Feature | Priority | Status |
|---|---------|----------|--------|
| E1 | MOQ-aware sourcing recommendations | **Next** | Planned |
| E2 | Auto-reassign to next-best vendor when MOQ > need | **Next** | Planned |
| E3 | MOQ cost analysis (buy MOQ vs skip) | Later | Planned |

---

## E1. MOQ-Aware Sourcing Recommendations

**Status:** Planned | **Priority:** Next

**Problem:** Franchise API sourcing reports recommend the cheapest vendor per MPN without checking whether the vendor's MOQ exceeds the customer's need quantity. This leads to non-viable recommendations (e.g., TTI quoting $0.22 but MOQ 1000 when we only need 625).

**Current behavior:** MOQ is captured from APIs but not used to filter or adjust recommendations. The buyer discovers the issue manually when trying to order.

**Solution:**
1. When selecting best vendor per line, only consider vendors where `MOQ <= need qty` (or MOQ = 0)
2. If no vendor meets MOQ, flag the line as "MOQ Issue" with the lowest-MOQ option shown
3. Include MOQ column in all sourcing outputs
4. For kitting reorder reports: same logic applies — `franchiseRfqPrice` at the MOQ-appropriate qty

**Affected workflows:**
- LAM EPG Award sourcing (`epg-full-api-run.js`, `epg-remaining.js`)
- LAM Kitting Reorder sourcing (`lam-kitting-source.js`)
- Any future franchise API sourcing reports

---

## E2. Auto-Reassign to Next-Best Vendor

**Status:** Planned | **Priority:** Next

**Problem:** When the cheapest vendor has MOQ > need, the report should automatically show the next-best vendor that CAN fulfill at the need quantity, rather than requiring manual re-checking.

**Solution:**
1. Sort all API hits by price
2. Filter to `MOQ <= need qty`
3. If filtered list is empty, show best option with MOQ flag + note "consider buying MOQ"
4. Calculate cost differential: `(next_best_price - blocked_price) × need_qty` to quantify the MOQ penalty

---

## E3. MOQ Cost Analysis (Buy MOQ vs Skip)

**Status:** Planned | **Priority:** Later

**Problem:** Sometimes buying the MOQ is still cheaper overall even if we overbuy. For example:
- Need 625, MOQ 1000, price $0.16/ea → total $160 (excess 375 units)
- Next best: MOQ OK, price $0.38/ea → total $237.50
- Buying MOQ saves $77.50 even with excess

**Solution:**
- Calculate: `MOQ × blocked_price` vs `need_qty × next_best_price`
- If MOQ purchase is cheaper, recommend it with excess quantity noted
- Factor in: carrying cost of excess, likelihood of future demand (kitting = recurring)

---

# Section F: RFQ Loading Support Workflows

| # | Feature | Priority | Status |
|---|---------|----------|--------|
| F1 | Business Partner Creation | **Next** | Planned |
| F2 | Contact Creation | **Next** | Planned |

---

## F1. Business Partner Creation

**Status:** Planned | **Priority:** Next

**Problem:** General Customer RFQ Loading requires a known Business Partner (BP) in OT. When a customer doesn't exist, the workflow currently halts and asks the user to create one manually.

**Solution:**
- AI-assisted BP creation workflow triggered from RFQ Loading
- Collect required fields: company name, address, contact info, BP group
- Write to iDempiere via REST API (`shared/api-client.js`)
- Return the new `search_key` to the RFQ Loading workflow

**Trigger:** RFQ Loading Step 4 — customer not found in DB for a General Customer RFQ.

**Interim:** Draft a response to the user listing what's needed to create the BP. User creates manually in OT.

---

## F2. Contact Creation

**Status:** Planned | **Priority:** Next

**Problem:** General Customer RFQ Loading requires a contact person (`chuboe_user_id` on RFQ header). When the contact email doesn't match any `ad_user` under the resolved BP, the workflow halts.

**Solution:**
- AI-assisted contact creation under an existing BP
- Collect: name, email, phone, title/role
- Write to iDempiere via REST API (POST to `ad_user` with `c_bpartner_id`)
- Return the new `ad_user_id` to the RFQ Loading workflow

**Trigger:** RFQ Loading Step 7 — contact email not found under known BP.

**Interim:** Draft a response to the user asking them to confirm the contact details or create manually in OT.

---

# Section G: CQ Writeback

| # | Feature | Priority | Status |
|---|---------|----------|--------|
| G1 | CQ Writer shared module | **Complete** | Operational |
| G2 | Quick Quote → CQ finalization flow | **Next** | Planned |
| G3 | Stock RFQ → CQ pipeline step | Later | Planned |

---

## G1. CQ Writer Shared Module

**Status:** Operational | **Priority:** Complete (2026-04-02)

Shared module `shared/cq-writer.js` writes `chuboe_cq_line` records via REST API.

- `writeCQ(rfqSearchKey, line)` — single line
- `writeCQBatch(rfqSearchKey, lines)` — batch (handles 1000+ lines)
- Resolves RFQ by search key, customer from RFQ header, lines by CPC→MPN→MPN clean
- MFR resolution via `shared/mfr-lookup.js`
- Flags unresolvable lines, missing prices, MFR issues
- Tested on test instance (IDs 1254238-1254240)

### ⚠️ Known Issue Pattern: System-Level MFR IDs

**Symptom:** Writes return HTTP 500 with `"System ID XXXX cannot be used in Chuboe_MFR_ID"`. Caused by passing a `Chuboe_MFR_ID` that points to a system-level `chuboe_mfr` record (`AD_Client_ID=0`).

**Root cause:** Most well-known MFRs (TI, Vishay, Bourns, Rohm, TDK, Coilcraft, etc.) only exist in `chuboe_mfr` at the system level. Client-level mirror records would need to be created by an iDempiere admin — which is impractical for hundreds of MFRs. So system-level records are the norm, not the exception.

**Fix (already implemented in cq-writer.js line 222):**
```js
id: (resolved && !resolved.isSystem) ? resolved.id : null,
// Then in payload:
if (mfrId) payload.Chuboe_MFR_ID = mfrId;  // omit when null
```
Always set `Chuboe_MFR_Text` (mandatory). Only set `Chuboe_MFR_ID` when the resolved record is non-system. The server's bean callout resolves system-level MFRs from text at write time.

**Do not "fix" this by:**
- Adding `Chuboe_MFR_ID` back as required — server rejects system IDs
- Hard-rejecting MFRs that resolve to system-only — this would block ~85% of writes
- Manually creating client-level MFR records — admin task, not scalable

This same pattern is required in `rfq-writer.js`, `vq-writer.js`, and `offer-writeback.js`. All four currently implement it correctly. **If you refactor any of these writers, preserve the conditional `Chuboe_MFR_ID` logic.**

---

## G2. Quick Quote → CQ Finalization Flow

**Status:** Planned | **Priority:** Next

**Problem:** Quick Quote generates a suggested resale CSV, but recording those quotes in OT requires manual CQ entry.

**Solution:** Two-step flow:
1. Quick Quote outputs CSV/Excel with suggested resale (existing workflow — unchanged)
2. User reviews, tweaks prices, removes lines they don't want to quote
3. User provides the final file + RFQ number → `cq-writer.js` writes to OT

**Why two-step:** Pricing decisions need human judgment. The system proposes; the user disposes. Auto-writing CQs from Quick Quote would bypass critical review (margin exceptions, customer relationship context, deal strategy).

**Format handling:** User's final file can be CSV, Excel, or even pasted lines. Parser normalizes to `{ mpn, qty, resale, cpc?, mfrText?, dateCode? }` before passing to `writeCQBatch`.

---

## G3. Stock RFQ → CQ Pipeline Step

**Status:** Planned | **Priority:** Later

**Problem:** Stock RFQ pipeline vision includes a "Propose Quote → Write CQ" step. Currently the pipeline stops at suggested resale.

**Solution:** Same two-step as G2 — pipeline proposes, user confirms, `cq-writer.js` finalizes. For high-volume stock quoting, may eventually support auto-write for lines within defined parameters (e.g., resale > floor, margin > threshold).

**Depends on:** G2 operational first.

---

## H1. MFR Backlog Reconciliation Workflow

**Status:** Planned | **Priority:** TBD — needs scoping (see open questions)

**Problem:** When `lookupMfr()` cannot resolve an MFR text to an existing `chuboe_mfr` record, the writer modules (`rfq-writer`, `vq-writer`, `offer-writeback`, `cq-writer`) preserve the text on the line but leave `chuboe_mfr_id` null. Once an admin later creates the MFR record in OT, the existing rows do **not** auto-backfill the FK — they stay disconnected from the canonical MFR for reporting, dedupe, and search.

First instance surfaced 2026-04-06: Orbel Corporation on RFQ 1132040 (2 MPNs), tracked in `shared/data/mfr-records-to-add.md`.

**Proposed solution sketch:**
1. **Capture** — every writer that hits a passthrough/null-FK MFR appends an entry to `shared/data/mfr-records-to-add.md` (or a structured JSON sibling) with: MFR text, first seen, source workflow, source record ID(s), affected MPNs.
2. **Notify** — periodic check (or session greeting) surfaces the backlog so an admin knows what to add.
3. **Reconcile** — after the admin adds an MFR record in OT, a reconciliation script:
   - Looks up the new `chuboe_mfr_id` by name
   - Finds all historical `chuboe_*_mpn` rows where `chuboe_mfr_text` matches and `chuboe_mfr_id` is null
   - PATCHes them via API to set `Chuboe_MFR_ID`
   - Refreshes `mfr-cache.json` and removes the entry from the backlog file

**Open questions (Jake to think through):**
- **Scope of backfill** — just `chuboe_rfq_line_mpn`, or also `chuboe_vq_line`, `chuboe_offer_line_mpn`, `chuboe_cq_line`, `chuboe_pricing_api_result`? Each has its own MFR column placement.
- **Match criteria** — exact text match? Case-insensitive? Honor `mfr-aliases.json`? What if multiple MFR texts map to one canonical (e.g., "TI" / "Texas Instruments" / "TEXAS INSTRUMENTS")?
- **Time horizon** — only backfill recent records (last 90/180 days), or everything historical?
- **Trigger model** — manual script run, scheduled cron, or event-driven (when admin marks an entry as "added" in the backlog file)?
- **Permissions** — does Tsunami User role have UPDATE permission on these tables via API, or do we need a different role?
- **Audit trail** — should backfill writes log to a separate table / file so they're distinguishable from original writes?

**Depends on:** None — can start as soon as scope is decided. Probably wants to land alongside `feedback_mfr_resolution_mandatory` enforcement so new writes don't keep adding to the backlog.

---

# Section H: iDempiere / OT — Pending Fixes from Astute Side

These are iDempiere field-model and bean-callout configuration issues that block clean data shapes. They're not workflow features — they're upstream blockers that need to be resolved by the OT/iDempiere team. Tracked here so they don't get lost.

| # | Issue | Priority | Status | Owner |
|---|---|---|---|---|
| H1 | `chuboe_offer_line` CPC bean-callout collapse — strict `(offer_id, cpc)` dedup | **High** | Pending Chuck | OT team |
| H2 | `Chuboe_CPC` non-updateable on existing rows (PATCH returns 500) | Medium | Pending Chuck | OT team |
| H3 | `chuboe_pricing_api_result.json_info` is a virtual column — can't write JSON body via REST | Medium | Pending Chuck (workaround shipped) | OT team |
| H4 | iDempiere column `Updateable` flags inconsistency on chuboe_* tables | Low (umbrella) | Investigation | OT team |

---

## H1. chuboe_offer_line CPC bean-callout — strict dedup collapse

**Status:** Pending Chuck | **Priority:** High | **First reported:** 2026-04-08 (Sanmina Q2FY26 E&O load)

**The bug:** A server-side bean callout on `chuboe_offer_line` deduplicates rows by `(chuboe_offer_id, chuboe_cpc)` with strict equality, **ignoring `chuboe_mpn` entirely**. When two lines POST to the same offer with the same non-empty CPC:

1. The earlier survivor's `chuboe_mpn` is **comma-merged in place** (e.g., `MPN_A` → `MPN_A,MPN_B`), corrupting its `chuboe_mpn_clean` join key for all downstream analytics.
2. The new line is set `isactive = N` with description overwritten to `"deactived - duplicate CPC - See Line #<survivor>"`.
3. POST returns `200 OK` with a new ID — **the loader sees no error**. Destruction happens server-side after the response.

**Verified empirically 2026-04-08** twice on offer 1024752 with totally distinct MPNs (`5962-1620804QZC` vs `TESTAVL-COLLAPSE-CHECK`, then `AVL-TEST-MPN-ALPHA` vs `AVL-TEST-MPN-BETA`). The collapse fires regardless of MPN difference — there is no fuzzy match, only CPC equality.

**Why this matters:** When a customer sends an excess list (or AVL) where two distinct industry MPNs share one customer Component code (e.g., LFKB32-0434-01 → `XC7VX415T-L2FFG1158E` AND `XC7VX415T-L2FFG1158E4589`), they are physically different parts even if the customer uses one code to reference both. The dedup conflates them.

**Why it appeared now and not before:** This issue did not exist before the `chuboe_cpc` field was added to `chuboe_offer_line`. Prior offers (e.g., chuboe_offer_id 1000000 from 2018) have multiple active rows with identical MPNs because all CPCs were null and the callout had no key to dedup against. The bean callout was introduced (or activated) at the same time as the CPC field — likely as a guardrail against accidental duplication, but the trigger condition is too coarse.

**Current workaround (deployed in `shared/offer-writeback.js`):** Per-CPC anchor pattern. For each unique CPC in the load batch, only the FIRST occurrence is written with `chuboe_cpc` populated; all subsequent rows for that CPC POST with `chuboe_cpc = ''`. The non-anchor rows capture the CPC linkage in their `description` field as `CPC=<value>`. Verified working on Sanmina offer 1026035 — 1986 lines, all active, 7 CPCs with multi-MPN preserved.

**Limitations of the workaround:**
- The structured `chuboe_offer_line.chuboe_cpc` column only captures the FIRST MPN's relationship to a CPC. Alternate MPNs under the same CPC are linked by description text only — fragile, not joinable in SQL without a `LIKE '%CPC=...%'` predicate.
- Any analysis that wants to find "all parts under CPC X" must scan descriptions, not just filter on `chuboe_cpc`.
- AVL/multi-MPN-per-CPC patterns can't be expressed cleanly through the structured fields.

**Proposed fix:** Change the bean callout's dedup key from `(chuboe_offer_id, chuboe_cpc)` to **`(chuboe_offer_id, chuboe_cpc, chuboe_mpn_clean)`**. Two distinct MPNs sharing one CPC are physically different parts and should NOT collapse. Identical MPNs sharing one CPC (true duplicates) would still collapse — preserving the original guardrail intent.

**Communicated to OT team:** Email sent 2026-04-08 to Jake (for forward to Chuck). Full incident report at `project_chuboe_offer_line_cpc_collapse.md`. Loader-side mitigation documentation at `shared/data-model.md` § Offer Chain, `shared/offer-writeback.js` header, `shared/api-writeback.md` § 12, `Trading Analysis/Market Offer Loading/market-offer-loading.md`, and `CLAUDE.md`.

**Once fixed:** the `feedback_avl_multi_mpn_loading.md` rule simplifies dramatically — Case A becomes "split into N lines all sharing CPC = primary, qty duplicated" with no anchor-pattern workaround needed. The structured CPC column becomes the canonical join key for AVL relationships.

---

## H2. Chuboe_CPC non-updateable on existing chuboe_offer_line rows

**Status:** Pending Chuck | **Priority:** Medium | **First reported:** 2026-04-08 (Blue Origin surgical fix)

**The bug:** PATCH against `chuboe_offer_line` with a `Chuboe_CPC` value returns:
```
HTTP 500 — {"title":"Update error","status":500,"detail":"Cannot update column Chuboe_CPC"}
```
The column has `Updateable=false` in the iDempiere field model. CPC can ONLY be set at POST time.

**Why this matters:** When backfilling CPC on historical offer lines (e.g., during the Blue Origin cleanup where the original loader didn't populate CPC), there is no recovery path through the standard write API. The only options are:
- Deactivate the old line and POST a new one (loses the original ID, breaks any audit linkage)
- Leave CPC blank and capture the linkage in `description` text instead (lossy)

**Proposed fix:** Set `Chuboe_CPC.Updateable = true` in the iDempiere field model. There's no business reason CPC should be immutable after creation — it's customer-supplied metadata, and customers occasionally correct their CPC mappings.

**Bundle with H1:** Same iDempiere field-model bucket; both worth resolving in the same change window.

---

## H3. chuboe_pricing_api_result.json_info virtual column — can't write JSON body via REST

**Status:** Workaround shipped (thin pointer pattern); proper fix Pending Chuck | **Priority:** Medium

**The bug:** `chuboe_pricing_api_result.json_info` is a virtual column in iDempiere. The REST API silently ignores writes to it — POSTs succeed but the JSON body never persists. This was first hit during the Stock RFQ pipeline build-out.

**Workaround:** `shared/api-result-writer.js` writes a thin header row to `chuboe_pricing_api_result` (no JSON) and stores the full envelope in a local cache file at `shared/data/api-pricing-cache/`. All read paths fall back to the cache. The DB row exists for audit linkage only.

**Why this matters:** Without DB-side JSON persistence, every analyzer re-call hits the live franchise APIs again instead of replaying cached results. Cache works locally but doesn't propagate to other consumers (e.g., Hurricane Search reads from the DB column natively).

**Proposed fix:** Reconfigure `json_info` from virtual to a stored JSONB column in iDempiere. Tracked in `api-integration-roadmap.md` § Pricing Envelope OT-Native Storage.

---

## H4. iDempiere column Updateable flags — umbrella investigation

**Status:** Investigation | **Priority:** Low

H2 surfaced one specific column (`Chuboe_CPC` on `chuboe_offer_line`) with a problematic `Updateable=false` setting. Worth a one-time audit of all `chuboe_*` table columns to find others that block legitimate update patterns. Likely candidates: anything with cleaned/derived semantics that probably should never be hand-updated, vs. customer-supplied metadata that should be editable.

**Action:** Pull `ad_column WHERE tablename LIKE 'chuboe_%' AND isupdateable = 'N'` and review the list with Chuck.

---

# Section I: Mil-spec ↔ Commercial ↔ NSN Cross-Reference Enrichment

| # | Feature | Priority | Status |
|---|---|---|---|
| I1 | MPN cross-reference table — schema + manual seed | **Next** | Planned |
| I2 | Loader enrichment via cross-ref sub-rows (Offer / RFQ / VQ) | **Next** | Planned |
| I3 | Auto-research workflow for new mil-spec MPNs | Later | Planned |
| I4 | NSN integration (DLA / FedLog / NSN databases) | Later | Planned |

**Origin:** Blue Origin offer 1024645 (2026-04-08) surfaced this gap. The offer included `JANS1N4109UR-1` (Microsemi mil-spec rad-hard diode) and `5962-1620804QZC` (DLA SMD drawing for Microsemi rad-hard FPGA). Each of these has a commercial equivalent and at least one NSN, but the analyzer treats them as standalone parts. We have no way to assess "what's the demand for the underlying physical part across all its industry, mil-spec, and government identifiers?" because the cross-references aren't captured anywhere in OT.

**Why this matters:** Mil-spec parts are exactly the parts where the commercial-vs-government-vs-OEM demand picture is fragmented across different naming conventions. The same physical part may show up as:

- Commercial industry MPN: `1N4109UR-1` (manufacturer's catalog form)
- Mil-spec drawing: `JANS1N4109UR-1` (JAN-S grade variant)
- DLA SMD: `5962-1620804QZC` (Standard Microcircuit Drawing reference)
- One or more NSNs: `5961-01-XXX-XXXX`, `5961-01-YYY-YYYY`, etc. (National Stock Numbers used in government procurement)

Today: each of these is a separate row that searches independently. There's no SQL join that says "these all refer to the same physical thing." A buyer sourcing the part has to know all four naming conventions to find historical demand, available supply, or active RFQs. An analyst trying to score opportunity on a market offer line can't see the full demand picture.

Same problem applies on the **buy side** when sourcing — when an Astute buyer is looking for `1N4109UR-1` to fulfill an RFQ, they should automatically see VQs and offers for the JANS-grade and the 5962- drawing too, because those parts would (often) fulfill the same need.

---

## I1. MPN cross-reference table — schema + manual seed

**Status:** Planned | **Priority:** Next

**Goal:** A single canonical reference table that joins commercial, mil-spec, and NSN identifiers for the same physical part (or part family).

**Schema sketch (lives in `intermediate` or `mart` schema, NOT `adempiere` — read-only-managed by us, not by iDempiere):**

```sql
CREATE TABLE intermediate.mpn_cross_reference (
  cross_ref_id          serial PRIMARY KEY,
  primary_mpn           text NOT NULL,        -- the canonical/commercial form
  primary_mpn_clean     text NOT NULL,
  primary_mfr           text,
  primary_mfr_clean     text,
  alt_mpn               text NOT NULL,        -- the equivalent identifier
  alt_mpn_clean         text NOT NULL,
  alt_form              text NOT NULL CHECK (alt_form IN
                          ('COMMERCIAL', 'MILSPEC_JAN', 'MILSPEC_JANS', 'MILSPEC_JANTX',
                           'MILSPEC_JANTXV', 'DLA_SMD', 'NSN', 'MFR_VARIANT', 'ALIAS')),
  relationship          text NOT NULL CHECK (relationship IN
                          ('IDENTICAL', 'SAME_DIE', 'SAME_FAMILY', 'CROSS_REF')),
  source                text NOT NULL,        -- where we got this mapping (datasheet, DLA QPL, manual, ...)
  source_date           date,
  notes                 text,
  created               timestamp DEFAULT now(),
  created_by            text,
  isactive              boolean DEFAULT true
);

CREATE INDEX ON intermediate.mpn_cross_reference(primary_mpn_clean);
CREATE INDEX ON intermediate.mpn_cross_reference(alt_mpn_clean);
```

The `relationship` field distinguishes:
- `IDENTICAL` — same die, same package, same screening; just different naming convention. The strongest form (a buyer can substitute one for the other freely).
- `SAME_DIE` — same silicon, different screening grade (commercial vs JANTX vs JANS). Functionally interchangeable for many use cases but the buyer needs to know the grade difference.
- `SAME_FAMILY` — related but not directly substitutable. Useful for proactive search but flagged as "not a 1:1 swap."
- `CROSS_REF` — informational link only (e.g., "this datasheet mentions both forms").

**Manual seed candidates:** Blue Origin offer parts (Microsemi JANS diodes, Microsemi RT4G rad-hard FPGAs, ADI RH-prefix amps, DLA 5962- references), plus any other mil-spec MPNs in active RFQs/offers. Probably 20–50 manually-curated rows to start.

**Open questions:**
- Source tagging — how granular? (datasheet URL? page number? manual review by who?)
- Canonical form — is the commercial MPN always "primary" or do we let it vary by lookup direction?
- Hierarchy — should `IDENTICAL` rows imply transitivity? (A↔B and B↔C → A↔C)
- Permissions — who can edit? Should writes go through a review workflow, or just direct?

---

## I2. Loader enrichment via cross-reference sub-rows

**Status:** Planned | **Priority:** Next | **Depends on:** I1

**Goal:** When loading an offer / RFQ / VQ line, look up the MPN in the cross-reference table and write the alternate identifiers as sub-rows on `chuboe_offer_line_mpn` / `chuboe_rfq_line_mpn` / (no sub-table for VQ — see below).

**Why sub-rows:** The sub-tables already exist for this exact use case, AND they sidestep the `chuboe_offer_line` CPC bean-callout entirely (which means we can write multiple alternates without anchor-pattern gymnastics). The sub-table's `chuboe_mpn_clean` index gets used by every analytics query that joins on cleaned MPN, so the cross-refs become searchable for free.

**Implementation:**

```javascript
// shared/cross-ref-enrich.js (new cog)
function enrichLineWithCrossRefs(line) {
  const refs = lookupCrossReferences(line.mpn, line.mfr);
  return refs.map(r => ({
    chuboe_mpn: r.alt_mpn,
    chuboe_mpn_clean: r.alt_mpn_clean,
    description: `${r.alt_form} cross-ref of ${line.mpn} (${r.relationship})`,
  }));
}
```

Each loader (`offer-writeback.writeOffer`, `rfq-writer.writeRFQ`, `vq-writer.writeVQBatch`) calls this and POSTs the resulting sub-rows under the parent line.

**Where this bites for VQ specifically:** `chuboe_vq_line` is **flat** — no sub-table for cross-refs (per `data-model.md`). For VQ enrichment, we'd need either:
- (a) A new `chuboe_vq_line_mpn` table (Chuck-side schema change)
- (b) Write a duplicate `chuboe_vq_line` row per cross-ref (cheap but inflates the VQ table)
- (c) Capture cross-refs only on RFQ + Offer for now, and let VQ matching pick them up via the RFQ side (RFQ has cross-refs → vendor sources against any of them → VQ comes back → matches against the specific RFQ MPN)

**The user's intuition** — "this should happen on the RFQ side as well which would translate into how a buyer would source (so maybe at vq instead?)" — points at exactly this question. Probably the right answer is:
- **RFQ enrichment:** mandatory. Buyer sees all cross-refs when sourcing.
- **VQ enrichment:** the FRANCHISE API pull side already returns the canonical commercial MPN; the cross-ref happens implicitly. For broker/manual VQs, no enrichment for now (option c above).
- **Market offer enrichment:** mandatory. Offer analyzer surfaces all linked demand across forms.

Worth a design conversation before building.

**Side benefit:** Once cross-refs are sub-rows on `chuboe_offer_line_mpn`, the Market Offer Analyzer's three-state classification model becomes much more accurate. A `5962-` part that has its commercial JANS equivalent linked will hit franchise APIs via the alt MPN and surface a real supply picture instead of falling into NO_LISTING_MILSPEC.

---

## I3. Auto-research workflow for new mil-spec MPNs

**Status:** Planned | **Priority:** Later | **Depends on:** I1, I2

**Goal:** When a new mil-spec MPN is encountered that isn't in the cross-reference table, kick off a research task that proposes additions for human review.

**Sources to crawl:**
- Manufacturer datasheets (Microsemi, Microchip, Analog Devices, TI, etc.) — most JANS/RH/MIL-prefix parts have a "commercial equivalent" line in the datasheet
- DLA QPL / QML lists (Qualified Products List / Qualified Manufacturers List) — public PDFs at https://qpldocs.dla.mil
- LLM-assisted research with manual review — feed the MPN + a search prompt to an LLM, get back a structured candidate row, queue for human approval
- Published cross-reference tables from distributors (Mouser/DigiKey/Avnet sometimes publish these)

**Workflow shape:**
1. Cron picks up new mil-spec MPNs from the last 24 hours of loaded offers/RFQs
2. For each, queries the cross-ref table — if missing, flags for research
3. Research worker (LLM + heuristics) proposes candidate cross-references
4. Output: candidates queued in a `proposed_cross_references` table for daily human review
5. Human (Jake or analyst) approves / rejects / corrects → entries land in `mpn_cross_reference`

**Open questions:**
- LLM choice — Claude API for reasoning over datasheet text? Local LLM for cost?
- Confidence scoring — how does the worker say "I'm 95% sure this is a SAME_DIE relationship" vs "speculative"?
- Datasheet sourcing — Octopart? Direct manufacturer URLs? Stored locally?

---

## I4. NSN integration

**Status:** Planned | **Priority:** Later | **Depends on:** I1

**Goal:** For any commercial or mil-spec MPN in our system, link all associated National Stock Numbers (NSNs). Lets us answer "is this part used in any government program we should know about?" and "what's the DLA demand history for this part?"

**Sources:**
- **NSN Center** (https://nsncenter.com) — public lookup service, may have an API
- **FedLog** — DLA's official catalog tool, requires government access
- **GSAAdvantage** (https://www.gsaadvantage.gov) — public procurement portal with NSN search
- **DLA's NSN extract** — periodic public data dumps if they exist
- **NSNLookup.com** — another public NSN search service

**Why this matters:**
- Government procurement happens at the NSN level, not the MPN level. If a customer's RFQ has an NSN reference, our matching has to expand from NSN → mil-spec MPN → commercial MPN to find any inventory we have.
- NSN demand signals are a leading indicator for industrial demand on the underlying part — if we see DLA buying activity on an NSN, we can anticipate broker/OEM follow-on.
- Astute could position itself as a known supplier on a specific NSN by understanding the cross-ref better than commodity brokers do.

**Technical sketch:**
- New rows in `mpn_cross_reference` with `alt_form='NSN'`
- One MPN can have many NSNs (different government programs procure under different stock numbers)
- A separate `nsn_demand_history` table for any DLA/government procurement signals we can ingest

**Open questions:**
- Which NSN data source has the cleanest API / bulk download?
- Cost — most NSN lookup services are free for low-volume; bulk would need a contract
- Refresh cadence — NSN catalog changes slowly (weeks/months), so monthly sync is probably enough

---

**Cross-cutting impact when I1+I2 land:**

| Workflow | What changes |
|---|---|
| Market Offer Analysis | mil-spec lines hit franchise APIs via commercial cross-ref → real supply data instead of NO_LISTING_MILSPEC |
| Vortex Matches | mil-spec RFQs match against commercial VQs/offers automatically |
| Quick Quote | mil-spec parts can be quoted using commercial-equivalent VQ history as a comparable |
| Suggested Resale | broader VQ/SO history pulls via cross-refs → tighter pricing |
| Stock RFQ Loading | incoming customer NSN references resolve to MPNs we actually have |
| RFQ Sourcing | buyers see all forms of a part automatically when sourcing |

---

*Last updated: 2026-04-07*
