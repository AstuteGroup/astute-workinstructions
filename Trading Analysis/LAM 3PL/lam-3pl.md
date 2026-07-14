# LAM 3PL Workflow

Operational home for Astute's LAM 3PL program: W111 (LAM 3PL) + W115 (LAM Dead Inventory) warehouse monitoring, weekly reorder + franchise sourcing, RFQ writes, customer-facing offer refresh, and contract-pricing reference.

**Previously named:** "LAM Kitting Reorder." Renamed 2026-05-13 to reflect that the workflow covers more than just the reorder step (it also owns customer offer refresh, escalations, and the canonical contract-pricing landing page).

---

## Contract Purchase Price — Where to Look

**RULE:** The **LAM Master Roster** (`LAM_Master_Roster.xlsx`) is the single source of truth for all LAM contract pricing. It consolidates data from all three legacy sources.

| Source | Path | Description |
|--------|------|-------------|
| **Master Roster** | `Trading Analysis/LAM 3PL/LAM_Master_Roster.xlsx` | Consolidated roster of all LAM parts (~1,244 parts). Sheet `Master Roster` → columns `Base Unit Price` (contract buy) and `Resale Price` (contract resale). |

**Procedure:**
1. Open `LAM_Master_Roster.xlsx` → sheet `Master Roster`
2. Search for the MPN or CPC
3. If found → `Base Unit Price` = contract buy, `Resale Price` = contract resale
4. If not found → **no contract price exists** for that part. Report "not under contract."

**Master Roster Columns:**

| Column | Description |
|--------|-------------|
| CPC | LAM Part Number |
| MPN | Manufacturer Part Number |
| Manufacturer | Mfr name |
| Description | Part description |
| Award | Award quantity |
| Base Unit Price | Contract buy price (what we pay) |
| Resale Price | Contract resale (what LAM pays us) |
| Pending | Reason for pending approval (if any) |
| Proposed Resale | New resale price being proposed |
| Last Approved | Date of last LAM approval |
| Reorder Threshold | Qty trigger for reorder |
| MOQ | Minimum order quantity |
| Contractual Lead Time | Lead time per contract |
| Buyer | Assigned buyer |
| Status | Part status (Has Issues, Pending Approval, etc.) |
| Submitted Date | When approval was submitted to LAM |

**Legacy sources (for reference only — data now consolidated in Master Roster):**
- Lam_Kitting_DB_*.xlsx (original kitting roster)
- Lam_EPG_SIPOC.xlsx (EPG award)
- Astute_New Part ADDS_ Working Copy - *.xlsx (Phase 2 adds)

---

## Pending Approval Workflow

When a reorder triggers a price or lead time change that needs LAM approval:

### Two Output Files

The reorder script generates two files:

| File | Contents | Action |
|------|----------|--------|
| `LAM_Reorder_Alerts_YYYY-MM-DD.csv` | Parts ready to order (approved pricing) | Proceed with PO |
| `LAM_Reorder_Pending_Approvals_YYYY-MM-DD.xlsx` | Parts awaiting LAM approval | Submit to LAM, wait for approval |

Parts are mutually exclusive — a part appears on one file or the other, not both.

### Marking a Part for Approval

When a part needs LAM approval (price increase, lead time change, etc.):

1. **Set `Pending`** = reason (e.g., "Cost increase - franchise price up 15%")
2. **Set `Proposed Resale`** = new resale price being proposed
3. **Set `Submitted Date`** = date submitted to LAM
4. **Set `Status`** = "Pending Approval" (optional, for filtering)

The part will appear on the Pending Approvals file (not Reorder Alerts) until approved.

### Processing an Approval

When LAM approves a price/lead time change:

1. **Update `Resale Price`** = approved resale price
2. **Clear `Pending`** = blank
3. **Set `Last Approved`** = approval date
4. **Clear `Status`** = blank (or keep other status if applicable)
5. **Clear `Submitted Date`** = blank

On next reorder run, the part moves to Reorder Alerts (ready to order).

### Pending Approvals File Columns

| Column | Description |
|--------|-------------|
| CPC | LAM Part Number |
| MPN | Manufacturer Part Number |
| Manufacturer | Mfr name |
| Description | Part description |
| Award | Award quantity |
| Current Resale | Current contract resale |
| Proposed Resale | New price being proposed |
| Reason | Why approval is needed |
| Submitted Date | When submitted to LAM |
| Days Pending | Age (for escalation) |
| Last Approved | Previous approval date |
| Status | Current status |

Sorted by Days Pending (oldest first) to highlight aging items.

### Email Configuration

All LAM workflow emails use: `lamkitting@orangetsunami.com`

---

## Overview

| Setting | Value |
|---------|-------|
| Warehouses | W111 (LAM 3PL) + W115 (LAM Dead Inventory) — combined |
| Trigger | Cron: Mondays at 12:00 PM (after Inventory Cleanup at 11:00 AM) |
| Roster Source | `LAM_Master_Roster.xlsx` → sheet `Master Roster` (~1,244 parts) |
| Join Key | MPN (CPC not in source inventory data) |
| Sourcing | Franchise-only — 8 APIs via `shared/franchise-api.js` |
| Email Account | `lamkitting@orangetsunami.com` |
| LAM bpartner_id | 1000730 |

**Key Design Decisions:**
- **Franchise-only sourcing** — No broker sourcing for this program. Items without API coverage need manual franchise sourcing (checking distributor websites, contacting reps)
- **Combined inventory** — W111 + W115 quantities summed per part (dead stock counts)
- **MPN is join key** — CPC not available in Infor Item Lots Report; join on MPN only
- **Zero-stock detection** — Items in Excel but not in inventory files flagged as CRITICAL
- **LAM-filtered purchase history** — All ERP data filtered to LAM RFQs only (c_bpartner_id = 1000730)
- **Source all parts** — Even parts on order get sourced for current pricing visibility and supplier consolidation opportunities
- **Supplier consolidation** — Fewer suppliers = fewer POs, fewer shipments, lower processing/shipping costs

---

## Automation

**Cron:** Mondays at 12:00 PM
**Runner:** `lam-kitting-runner.js`
**Email:** `lamkitting@orangetsunami.com`

```
Inventory Cleanup (Monday 11:00 AM cron)
    ↓
Produces W111_LAM_3PL.csv + W115_LAM_Dead_Inventory.csv
    ↓
LAM Kitting Runner (Monday 12:00 PM cron)
    ↓
Step 1: Find today's inventory folder (or run cleanup if missing)
Step 2: Load LAM_Master_Roster.xlsx
Step 3: Run lam-kitting-reorder.js --no-email
        → LAM_Reorder_Alerts_*.csv (ready to order)
        → LAM_Reorder_Pending_Approvals_*.xlsx (awaiting LAM approval)
        → "Available Stock (Other WH)" column flags parts with stock elsewhere
Step 4: Run lam-kitting-source.js → _sourced.xlsx
Step 4b: Run lam-kitting-rfq-writer.js → RFQ + VQ lines in OT
Step 4c: Run lam-kitting-customer-offer.js → refresh customer BI offer
Step 5a: Run verification checks (results added to output as columns)
         → Wrong warehouse check: flags parts in non-LAM warehouses
         → Pending orders check: flags stuck orders (VQ ticked, no POV stamp)
Step 5b: Email sourced report + pending approvals to jake.harris@astutegroup.com
         → Output includes "Check: Wrong WH" and "Check: Pending Order" columns
```

**Two-file output:** Parts awaiting LAM approval (price/lead time changes) appear on the Pending Approvals file, NOT the Reorder Alerts. Parts are mutually exclusive between files. See "Pending Approval Workflow" section above.

**Other warehouse stock:** The reorder output includes "Available Stock (Other WH)" and "Available Qty (Other WH)" columns that flag when a reorder part has stock in non-LAM warehouses. This is informational — review before ordering to avoid purchasing parts that can be transferred.

---

## Inputs

### From Inventory File Cleanup (Trigger)

| File | Description |
|------|-------------|
| `W111_LAM_3PL.csv` | Current W111 inventory (Chuboe format) |
| `W115_LAM_Dead_Inventory.csv` | Current W115 inventory (Chuboe format) |

### From Master Roster

| File | Sheet | Key Columns |
|------|-------|-------------|
| `LAM_Master_Roster.xlsx` | `Master Roster` | CPC, MPN, Manufacturer, Description, Award, Base Unit Price, Resale Price, Pending, Proposed Resale, Last Approved, Reorder Threshold, MOQ, Contractual Lead Time, Buyer, Status, Submitted Date |

The Master Roster consolidates all LAM contract data into a single source of truth (~1,244 parts). See "Contract Purchase Price — Where to Look" section for full column definitions.

### From ERP (LAM Purchases Only)

| Data | LAM Filter | Notes |
|------|------------|-------|
| Previous Supplier | `rfq.c_bpartner_id = 1000730` | Most recent LAM PO supplier |
| Buyer | Same filter | Who created the PO (`c_order.createdby`) |
| Historical Purchase Price | Same filter | Last price paid |
| Last Promise Date | Same filter | Promise date (more useful than order date) |
| Last RFQ | Same filter | LAM RFQ number |
| Infor POV Number | `chuboe_po_string LIKE 'POV%'` | Must start with 'POV' (not 'STOCK') |
| On Order Qty | Recency-filtered: PO cut ≤90d OR promise date ≥ today | Open qty across all surviving open activity for the MPN |

> **Join Paths:** See [`shared/data-model.md`](../../shared/data-model.md) § Key Join Patterns for the correct RFQ→VQ→Order join chain and common wrong joins.
>
> **POV number:** `c_orderline.chuboe_po_string` (see [`shared/data-model.md`](../../shared/data-model.md) § Order Line).

---

## AVL Multi-MPN Handling

LAM parts often have multiple approved alternates in the AVL (Approved Vendor List). The workflow handles this in two places:

### Inventory Aggregation (Reorder Check)

When checking if a CPC is below threshold, the reorder script sums inventory across ALL approved MPNs for that CPC.

**Example:** CPC 608-096583-504 has two approved MPNs:
- TS63Y504KR10 (roster MPN): 0 pcs in W111
- 84WR500KLF (alt MPN): 105 pcs in W111

**Old behavior:** Would flag as CRITICAL (0 stock for roster MPN)
**New behavior:** Correctly shows 105 pcs total across approved MPNs

When stock is spread across multiple MPNs, the output includes a `Stock Detail` column showing the breakdown (e.g., "84WR500KLF:105, TS63Y504KR10:0").

### Sourcing (Alt MPN Selection)

When sourcing, the script queries ALL approved MPNs and picks the best option (lowest in-stock price, or best lead time if no stock).

If an alternate MPN has better sourcing than the roster MPN:
- Output shows `Selected MPN` column (highlighted light blue)
- Switch is logged to `lam-mpn-switches.json` as a **candidate**

### MPN Switch Tracking

**File:** `lam-mpn-switches.json`

Contains two arrays:
- `candidates`: Switch suggestions from sourcing (auto-populated, pending review)
- `switches`: Confirmed permanent switches (manually moved from candidates)

**Workflow:**
1. Sourcing finds better alt MPN → logs to `candidates[]`
2. Review candidates after each sourcing run
3. If switch is permanent (we'll always buy the alt), move to `switches[]` and update Master Roster MPN column

**When to confirm a switch:**
- Alt MPN is consistently better priced/available
- We're actively stocking the alt MPN
- Original MPN is obsolete or consistently unavailable

**Updating the roster:**
When confirming a switch, update the `MPN` column in `LAM_Master_Roster.xlsx` to the new active MPN. The Master Roster MPN should always reflect "what we're actually buying/stocking" for that CPC.

---

## End-to-End Workflow

### Step 1: Run Automated Pipeline (Cron)

The runner handles everything automatically:

```bash
node lam-kitting-runner.js
```

Or run manually:

```bash
# Reorder detection only
node lam-kitting-reorder.js "<inventory-folder>" "<excel-file>" [--no-email]

# Sourcing only (DO NOT pass output path - script auto-generates _sourced.xlsx)
node lam-kitting-source.js output/LAM_Reorder_Alerts_YYYY-MM-DD.csv

# WRONG - passing xlsx output path breaks the file format:
# node lam-kitting-source.js input.csv output.xlsx  ← DON'T DO THIS
```

### Step 2: Review Sourced Report

Review the color-coded Excel. Priority levels:

| Priority | Criteria | Action |
|----------|----------|--------|
| CRITICAL | Zero stock (100% shortfall) | Source immediately |
| HIGH | 75%+ shortfall | Source soon |
| MEDIUM | 50-74% shortfall | Source this week |
| LOW | <50% shortfall | Monitor / source as needed |
| PENDING ORDER PLACEMENT | Recent activity but no Infor POV stamp yet (OT PO without Infor stamp, OR VQ ticked with no PO at all). Recency = PO cut ≤90d OR promise date ≥ today | Chase the PO — order is committed but not fully placed. Informational on main tab. **Skipped from franchise sourcing.** |
| PENDING RECEIPT | Infor POV stamped, qty undelivered, recency rule satisfied | Wait — vendor shipment in flight. Informational on main tab. **Skipped from franchise sourcing.** |
| STOCK ARRIVED | Escalations-tab synthesis only — manual escalation MPN that's now above threshold but has W111+W115 stock | Josh: confirm new LAM resale was approved + update Kitting DB Resale Price column. Then remove entry from `lam-escalations.json` |

PENDING ORDER PLACEMENT and PENDING RECEIPT share `priorityOrder` value 4 — they sort together at the bottom of the main tab, with PENDING ORDER PLACEMENT first inside the bucket (more actionable: chase the PO vs wait for vendor).

**Recency filter (loadRecentPOVs SQL):** open POs are dropped entirely when `c_order.created < CURRENT_DATE − 90 days` AND `datepromised < CURRENT_DATE`. Same rule for VQ_TICKED (using `rfq.created` and `vl.datepromised`). Stuck/orphan 2024–2025 POs no longer leak into the Recent POV cell or trigger PENDING priorities.

**Sourcing Status values:**

| Status | Meaning | Buyer Action |
|--------|---------|--------------|
| SOURCED | At least one franchise found stock or lead time | Use the In Stock / Lead Time columns |
| NO COVERAGE | APIs returned cleanly, zero matches across 8 distys | Manual franchise sourcing (rep, website) |
| RESTRICTED - <MFR> | MFR is franchise-restricted (ADI/Maxim/Linear/TI). LAM Kitting is franchise-only and cannot purchase these through distribution. Franchise pricing fields are blanked even though APIs returned data. | Source via TI Store / ADI direct / authorized non-franchise channel. Pricing capture still hits `chuboe_pricing_api_result` for market intel. |
| SKIPPED - TIMEOUT/ERROR | Sourcing was interrupted before this row processed | Re-run sourcing manually for this row |

The restricted-MFR rule is shared (`shared/restricted-mfrs.js` + `shared/restricted-mfrs.json`). The display-side masking (blanking columns + status label) is LAM-specific because LAM Kitting is the only franchise-only program — other workflows (Stock RFQ, RFQ Sourcing, Market Offer) keep showing the franchise pricing as-is.

Margin colors:

| Color | Margin | Action |
|-------|--------|--------|
| Green | >18% | Good to buy — proceed with PO |
| Yellow | 0-18% | Review — margin thin but acceptable |
| Red | <0% | Escalate — franchise price > resale, need price review |

### Step 3: Check Recent POV / On Order

Parts with a **Recent POV** (90-day window) already have an open order. Review before re-ordering:
- On Order Qty shows open quantity on that specific POV line
- Still sourced for current pricing / alternative supplier visibility
- Look for supplier consolidation opportunities (same supplier across multiple parts)

### Step 4: Create Purchase Orders

For items needing reorder:
1. Review franchise pricing vs. historical purchase price
2. Consider supplier consolidation (fewer POs = lower processing/shipping costs)
3. Create PO in iDempiere
4. Update LAM Kitting DB as needed

### Step 4d: Escalations Tab

The rebuilt xlsx adds a separate **Escalations** worksheet alongside the main reorder list. Items rendered there are removed from the main tab — each MPN lives in exactly one place. Three sources feed the tab:

| Source | Persistence | Reason cell color |
|---|---|---|
| **Manual** — entries in `lam-escalations.json` (Jake-curated: price approvals, contract renegotiations, vendor escalations) | Survives weekly runs until manually removed OR off-list AND zero stock | Uncolored |
| **Stock-arrived synthesis** — manual entry whose MPN is now above threshold but W111+W115 stock > 0 | Survives until manually removed (signals LAM contract approval). Stock presence ≠ approval — only operator removal does | Light blue |
| **Auto** — restricted-MFR margin compression detected this run (franchise pricing < 18% margin vs current LAM resale, OR no franchise route at all) | Ephemeral — recomputed each run from `_sourced_franchise_data.json` | Amber |

**Sidecar:** `lam-kitting-reorder.js` writes `output/LAM_Reorder_Alerts_<date>_escalations_context.json` with current inventory + POV state for every manual-escalation MPN regardless of threshold position. The runner uses it to synthesize stock-arrived rows and to drive `persistResolvedEscalations`.

**Auto-resolution rule:** a manual entry is dropped from `lam-escalations.json` only when the MPN is BOTH off the reorder list AND has zero W111+W115 stock. Stock-arrived entries are NEVER auto-cleared — Jake removes them once new contract pricing is confirmed.

**Auto-escalation logic (`computeAutoEscalations` in runner.js):**
- Iterates this week's reorder CSV
- Skips non-restricted MFRs (handled by normal margin/auto-purchase flow)
- Skips MPNs already in `lam-escalations.json` (manual reason takes precedence — no override)
- For surviving rows:
  - Franchise pricing puts margin <18% at LAM MOQ vs current `Resale Price` → emit `renegotiate` entry with franchise ref price + supplier
  - Franchise APIs returned no usable pricing → emit `no_route` entry pointing at direct-supplier sourcing
  - Margin ≥18% on a restricted MFR → no entry (LAM contract still works; procurement happens via broker / direct separately)

**Email body:** the runner email surfaces manual + auto + stock-arrived counts separately, with up to 5 auto-flagged MPNs inline so Josh sees the actionable items without opening the xlsx.

### Step 5: Customer-Facing Inventory Offer (auto)

Runs as Step 4c of the runner — refreshes the LAM customer-facing BI dashboard's
backing market offer. Operator action: none (verify the email body shows the new
search key).

| Setting | Value |
|---------|-------|
| Offer type | `chuboe_offer_type_id = 1000025` ("LAM Kitting Inventory") |
| BPartner | 1000730 (Lam Research) |
| Pattern | Deactivate prior offer of same (BP, type) → write new (matches `inventory_cleanup.js`) |
| Roster | All parts in `Lam_Kitting_DB.xlsx` INVENTORY sheet (~939 unique after dedup) — including zero-stock parts. Manual cycle has been writing all roster parts too (current offer = 939 lines) — automation matches that scope. Exact duplicate rows in the Kitting DB (same CPC+MPN+everything) are dropped silently with a console warning so the operator can clean the source file |
| Qty | sum(W111+W115 lots per MPN) or 0 if absent from this week's inventory. MPN matching uses `canonicalMpn()` (strips leading zeros) to bridge inventory CSVs (`09552156612741`) vs Kitting DB (`9552156612741`) |
| Resale (`priceentered`) | Kitting DB "Resale Price" column (LAM contract resale) |
| Lead Time | Manual codes (LTB, Obsolete, EOL, NRND, etc.) preserved as-is. Weeks-form values (e.g. "11 Weeks") refreshed when this week's sourced CSV has fresh franchise lead time for that MPN; otherwise carried as-is from Kitting DB |
| CPC | Kitting DB "Lam P/N". For ~6 CPCs with multiple MPNs (LAM AVL alts), only the first MPN row carries the CPC field (per-CPC anchor pattern) — required to dodge the `chuboe_offer_line` server-side dedup bean-callout |
| Description | "Lam Kitting Inventory - YYYY.MM.DD" (matches manual-cycle convention) |

**Dashboard query:** filters by offer type 1000025 + isactive='Y' (confirmed with operator). Stable offer ID is therefore not required — fresh offer per Monday is fine.

**Failure handling:** Step 4c is wrapped in try/catch. A failure logs + surfaces in the buyer email body but does NOT block the email or fail the runner. The next Monday tick retries.

**Manual / one-off run:**
```bash
node lam-kitting-customer-offer.js [inventory-folder] [excel-file] [--dry-run]
# --no-fresh-lt   skip lead-time refresh from sourced CSV
# --sourced-csv X override sourced CSV path
```

---

## Output Format

### Two Reorder Output Files

The reorder script generates two mutually exclusive files:

| File | Purpose | Contents |
|------|---------|----------|
| `LAM_Reorder_Alerts_YYYY-MM-DD.csv` | Ready to order | Parts with approved pricing — proceed with PO |
| `LAM_Reorder_Pending_Approvals_YYYY-MM-DD.xlsx` | Awaiting LAM approval | Parts with `Pending` set — need price/lead time approval before ordering |

A part appears on one file or the other, never both.

### Customer-Facing Offer (`chuboe_offer_type_id=1000025`)

| `chuboe_offer_line` field | Source |
|---|---|
| `Chuboe_MPN` | Kitting DB MPN — read with `raw: true` so 13+ digit numeric MPNs (21 of them) keep full precision instead of rendering as `9.55167E+12` |
| `Chuboe_MFR_Text` (+ `_ID` via `shared/mfr-resolver`) | Kitting DB Manufacturer |
| `Chuboe_CPC` | Kitting DB Lam P/N (anchor pattern for duplicate CPCs) |
| `Qty` | sum(W111+W115 lots) or 0 — matched via `canonicalMpn()` (strips leading zeros) |
| `PriceEntered` | Kitting DB Resale Price, rounded to 4 decimals (matches manual-cycle convention) |
| `Chuboe_Lead_Time` | Manual code preserved, else fresh-from-sourcing-or-as-is (see Step 5) |
| `Chuboe_MOQ` | Literal `"YES"` (matches the manual-cycle convention since ~Nov 2025 — operator confirmed intentional pending seller follow-up; the field is `varchar(60)` so any string works). Kitting DB has real numeric MOQs but they're not being passed through |
| `C_Country_ID` | 100 (United States) |
| `C_Currency_ID` | 100 (USD) |
| `Description` | Kitting DB Item Description |

Sidecar JSON: `output/LAM_Customer_Offer_<date>.json` — run metadata for the runner email.

### Reorder Alert Columns (22 total)

| # | Group | Column | Source |
|---|-------|--------|--------|
| 1 | Part ID | Lam P/N | Excel (CPC) |
| 2 | Part ID | MPN | Excel |
| 3 | Part ID | Manufacturer | Excel |
| 4 | Part ID | Item Description | Excel |
| 5 | Inventory | QTY ON HAND | Inventory Files (W111+W115) |
| 6 | Inventory | W115 Stale Inventory | YES if W115 > 0 (amber highlight) |
| 7 | Inventory | Reorder Threshold | Excel (Column H) |
| 8 | Inventory | Shortfall | Threshold - QTY ON HAND |
| 9 | Inventory | Priority | CRITICAL/HIGH/MEDIUM/LOW |
| 10 | Inventory | On Order Qty | ERP (90-day, specific POV line) |
| 11 | Inventory | Recent POV | ERP (90-day, Infor POV number) |
| 12 | Inventory | Last Promise Date | ERP (LAM purchases only) |
| 13 | Inventory | Last RFQ | ERP (LAM RFQ number + customer) |
| 14 | Pricing | Base Unit Price | Excel |
| 15 | Pricing | Resale Price | Excel |
| 16 | Pricing | Historical Purchase Price | ERP (LAM purchases only) |
| 17 | History | OT Previous Supplier | ERP (LAM purchases only) |
| 18 | History | OT Buyer | ERP (who created PO) |
| 19 | History | Historical Buyer | Excel (Column J) |
| 20 | Kitting | Lead Time | Excel |
| 21 | Kitting | LAM MOQ | Excel |

### Sourced Columns (added by lam-kitting-source.js)

| Column | Description |
|--------|-------------|
| In Stock Supplier | Best franchise with stock (lowest price) |
| In Stock Price | Price at LAM MOQ quantity |
| In Stock Qty | Available quantity |
| In Stock Margin % | (Resale - Price) / Resale |
| Lead Time Supplier | Alternative with lead time |
| Lead Time Price | Price for lead time order |
| Lead Time (Weeks) | Expected wait |
| Lead Time Margin % | Margin for lead time option |

---

## Franchise APIs (via shared/franchise-api.js)

All 8 active distributors, queried at LAM MOQ quantity:

| API | Module |
|-----|--------|
| DigiKey | `franchise_check/digikey.js` |
| Arrow | `franchise_check/arrow.js` |
| Rutronik | `franchise_check/rutronik.js` |
| Future | `franchise_check/future.js` |
| Master | `franchise_check/master.js` |
| TTI | `franchise_check/tti.js` |
| Newark/Farnell | `franchise_check/newark.js` |
| Mouser | `franchise_check/mouser.js` |

**Important:** Sourcing uses `shared/franchise-api.js` — adding a new API there automatically includes it in LAM sourcing.

---

## Architecture Notes

### Single buildAlert() Function
All output columns are defined in one place (`ALERT_COLUMNS` array + `buildAlert()` function). Both code paths (inventory items and zero-stock CRITICAL items) call the same function. To add/remove/reorder columns, update `ALERT_COLUMNS` and `buildAlert()` — no other changes needed.

### SQL Execution in rbash
The rbash environment causes non-zero exit codes even on successful queries. The script writes SQL to temp files and uses `psql -o` for file-based output to avoid stdout issues.

---

## Questions Resolved

| Question | Answer |
|----------|--------|
| Source of truth? | **LAM_Master_Roster.xlsx** — consolidates all LAM contract data (~1,244 parts) |
| Join key? | **MPN only** — CPC not in Infor Item Lots Report |
| Threshold source? | Master Roster → `Reorder Threshold` column |
| Which warehouses? | W111 + W115 combined |
| Dead stock? | Yes, counts toward inventory level |
| Zero stock detection? | Yes, items in Excel but not in inventory = CRITICAL |
| Sourcing? | **Franchise-only** via `shared/franchise-api.js` (8 APIs) |
| Broker sourcing? | No — manual franchise sourcing for items without API coverage |
| Source parts on order? | Yes — for pricing visibility and supplier consolidation |
| ERP join path? | See `shared/data-model.md` § Key Join Patterns |
| Infor POV number? | `c_orderline.chuboe_po_string` — see `shared/data-model.md` § Order Line |
| Promise date vs order date? | **Promise date** (`c_orderline.datepromised`) |
| LAM filter? | `rfq.c_bpartner_id = 1000730` (Lam Research only) |
| CMs (Naprotek, etc)? | Filtered out of Last RFQ — those are sales TO CMs, not supplier purchases |
| Email account? | `lamkitting@orangetsunami.com` — all LAM workflow emails |
| Pending parts? | Appear on **Pending Approvals** file (not Reorder Alerts) until approved |
| Two-file output? | Reorder Alerts (ready) + Pending Approvals (awaiting LAM) — mutually exclusive |

---

## Files

### Core Data

| File | Description |
|------|-------------|
| `LAM_Master_Roster.xlsx` | **Single source of truth** for all LAM contract data (~1,244 parts). Contains CPC, MPN, pricing, approval status, thresholds, etc. |

### Scripts

| File | Description |
|------|-------------|
| `lam-kitting-runner.js` | Cron runner — chains cleanup → reorder → sourcing → rfq-write → customer-offer → email |
| `lam-kitting-reorder.js` | Reorder detection + ERP enrichment + two-file output |
| `lam-kitting-source.js` | Franchise sourcing via shared API module |
| `lam-kitting-rfq-writer.js` | Writes RFQ + VQ lines for items without on-order |
| `lam-kitting-customer-offer.js` | Refreshes the customer-facing BI dashboard offer (type 1000025) |
| `lam-kitting-dashboard.js` | Dashboard generator |

### Output Files

| File | Description |
|------|-------------|
| `output/LAM_Reorder_Alerts_*.csv` | Parts ready to order (approved pricing) |
| `output/LAM_Reorder_Pending_Approvals_*.xlsx` | Parts awaiting LAM approval (with aging) |
| `output/LAM_Reorder_Alerts_<date>_RFQ<N>_sourced.xlsx` | Sourced alerts + RFQ Line # column. RFQ search key baked into filename |
| `output/LAM_Reorder_Alerts_<date>_rfq_mapping.json` | MPN → RFQ line number map + auto-approved R_Request document numbers |
| `output/LAM_Reorder_Alerts_<date>_sourced_franchise_data.json` | Raw franchise API responses per MPN (used for auto-escalation margin checks) |
| `output/LAM_Reorder_Alerts_<date>_escalations_context.json` | Sidecar: per-MPN inventory + POV state for every manual-escalation entry |
| `output/LAM_Customer_Offer_<date>.json` | Customer-offer run metadata (offer ID, search key, line counts) |

### Supporting Data

| File | Description |
|------|-------------|
| `lam-escalations.json` | Manual escalation entries — `{mpn, reason, date}`. Buyer-curated; auto-resolved only when MPN is off the reorder list AND zero stock |
| `Lam_Kitting_DB_*.xlsx` | **Legacy** — original kitting database. Data now consolidated in Master Roster |
| `Lam_EPG_SIPOC.xlsx` | **Legacy** — EPG award data. Now in Master Roster |
| `Astute_New Part ADDS_*.xlsx` | **Legacy** — Phase 2 adds. Now in Master Roster |

---

## TODO

### Completed
- [x] Map columns — MPN is join key (CPC not in source)
- [x] Build reorder script (Node.js) — detection + ERP enrichment
- [x] Zero-stock detection (CRITICAL priority)
- [x] Historical data from ERP (supplier, buyer, price, date)
- [x] Email report to jake.harris@astutegroup.com
- [x] Add franchise sourcing with margin analysis
- [x] Excel output with color-coded margins (green/yellow/red)
- [x] Query at LAM MOQ for accurate bulk pricing
- [x] Integrate as cron job (Monday 12pm, after Inventory Cleanup at 11am)
- [x] LAM-only purchase history filter (chuboe_vq_line → chuboe_rfq join)
- [x] Infor POV numbers (chuboe_po_string)
- [x] Recent POV with on-order qty (90-day window)
- [x] Use shared/franchise-api.js (all 8 APIs)
- [x] Single buildAlert() function (prevents column sync issues)
- [x] Excel number formatting (currency/integers)
- [x] Customer-facing LAM Kitting Inventory offer auto-refresh (Step 4c — replaces manual weekly update)
- [x] Master Roster consolidation — single source of truth replacing 3-file lookup (2026-07-10)
- [x] Two-file reorder output — Reorder Alerts + Pending Approvals (2026-07-10)
- [x] Email account migration to lamkitting@orangetsunami.com (2026-07-10)

### Pending
- [ ] Auto-load RFQ for reorder lines (via shared/rfq-writer.js)
- [ ] Add Mouser API to shared/franchise-api.js distributor list (module exists, needs BP verification)
- [ ] **Approval intake handler** — process email/terminal notifications when LAM approves price/lead time changes; update Master Roster and clear pending status
- [ ] **Phase 2 — Roster-wide lead-time refresher.** Customer offer currently only refreshes lead times for parts on this week's reorder list (~14 of 945). Above-threshold parts keep whatever was in the Kitting DB. Build a separate refresher that hits cached franchise API data (or scheduled API calls — monthly default, more frequent for short-lead, less for long-lead) for the full roster. Preserve manual override codes (LTB, Obsolete, EOL, NRND, TBD, etc.) — only refresh weeks-form values
- [ ] **Phase 3 — LAM EPG (round-2 wins) customer offer.** EPG is a separate award round under the same program. Build a parallel customer-facing offer with its own offer type (TBD — request from Chuck) so the BI dashboard can show kitting and EPG separately. Source data and pipeline to be defined

---

*Created: 2026-03-16*
*Updated: 2026-03-24* — Major overhaul: LAM-filtered ERP data, correct RFQ join path, 8 franchise APIs, cron automation, column reorganization, single buildAlert() architecture
*Updated: 2026-05-05* — Step 4c: customer-facing LAM Kitting Inventory offer auto-refresh (replaces manual weekly update). Roster-driven from Kitting DB; deactivate-prior + write-new pattern matches `inventory_cleanup.js`. Phase 2 (roster-wide lead-time refresh) and Phase 3 (LAM EPG separate offer) queued.
*Updated: 2026-05-05* — Priority overhaul + Escalations tab plumbing. (1) `PENDING RECEIPT` split into `PENDING ORDER PLACEMENT` (no Infor POV stamp yet) + `PENDING RECEIPT` (POV stamped). (2) `loadRecentPOVs` SQL recency filter — keep open POs only when cut ≤90d ago OR promise date still ≥ today; stale 2024–2025 POVs no longer leak (951→178 rows LAM-wide). (3) Escalations tab now sources from three places: manual entries (`lam-escalations.json`), stock-arrived synthesis (manual MPN above threshold but stock on hand → "Action with seller — new LAM resale still pending"), and auto entries for restricted-MFR margin compression (franchise <18% margin vs current LAM resale → Josh: push new resale based on franchise ref). (4) Escalations sidecar (`_escalations_context.json`) drives `persistResolvedEscalations` — manual entries only auto-resolve when off list AND zero stock; never on stock presence alone (operator removes from JSON when LAM approves new pricing).
*Updated: 2026-07-10* — **Master Roster consolidation + two-file output.** (1) LAM_Master_Roster.xlsx replaces 3-file lookup (Lam_Kitting_DB + Lam_EPG_SIPOC + New Part ADDS) as single source of truth (~1,244 parts). (2) Two-file reorder output: `LAM_Reorder_Alerts_*.csv` (ready to order) + `LAM_Reorder_Pending_Approvals_*.xlsx` (awaiting LAM approval). Parts are mutually exclusive — appear on one file or the other. (3) Added Pending column (reason), Proposed Resale, Submitted Date, Status, Days Pending (aging) for approval tracking. (4) Email account changed to `lamkitting@orangetsunami.com`. (5) Added "Pending Approval Workflow" section documenting how to mark parts for approval and process approvals.
