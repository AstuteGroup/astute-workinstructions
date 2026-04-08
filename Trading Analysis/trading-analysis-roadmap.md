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

*Last updated: 2026-04-07*
