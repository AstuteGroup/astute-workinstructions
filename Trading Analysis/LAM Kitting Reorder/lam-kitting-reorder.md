# LAM Kitting Reorder Workflow

Monitor LAM kitting warehouse inventory levels to trigger reorders and source replenishment.

---

## Overview

| Setting | Value |
|---------|-------|
| Warehouses | W111 (LAM 3PL) + W115 (LAM Dead Inventory) — combined |
| Trigger | Cron: Mondays at 12:00 PM (after Inventory Cleanup at 11:00 AM) |
| Threshold Source | `Lam_Kitting_DB.xlsx` → INVENTORY sheet → Column H (Reorder Threshold) |
| Join Key | MPN (CPC not in source inventory data) |
| Sourcing | Franchise-only — 8 APIs via `shared/franchise-api.js` |
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

```
Inventory Cleanup (Monday 11:00 AM cron)
    ↓
Produces W111_LAM_3PL.csv + W115_LAM_Dead_Inventory.csv
    ↓
LAM Kitting Runner (Monday 12:00 PM cron)
    ↓
Step 1: Find today's inventory folder (or run cleanup if missing)
Step 2: Find latest Lam_Kitting_DB*.xlsx
Step 3: Run lam-kitting-reorder.js --no-email
Step 4: Run lam-kitting-source.js → _sourced.xlsx
Step 4b: Run lam-kitting-rfq-writer.js → RFQ + VQ lines in OT
Step 4c: Run lam-kitting-customer-offer.js → refresh customer BI offer
Step 5: Email sourced report to jake.harris@astutegroup.com
```

One email with the final sourced Excel (color-coded margins) + customer-offer status line. No intermediate unsourced email.

---

## Inputs

### From Inventory File Cleanup (Trigger)

| File | Description |
|------|-------------|
| `W111_LAM_3PL.csv` | Current W111 inventory (Chuboe format) |
| `W115_LAM_Dead_Inventory.csv` | Current W115 inventory (Chuboe format) |

### From LAM Kitting Database

| File | Sheet | Key Columns |
|------|-------|-------------|
| `Lam_Kitting_DB_*.xlsx` | INVENTORY | Lam P/N (A), MPN (B), Reorder Threshold (H), LAM MOQ (I), Buyer (J), Notes (K) |

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

# Sourcing only
node lam-kitting-source.js output/LAM_Reorder_Alerts_YYYY-MM-DD.csv
```

### Step 2: Review Sourced Report

Review the color-coded Excel. Priority levels:

| Priority | Criteria | Action |
|----------|----------|--------|
| CRITICAL | Zero stock (100% shortfall) | Source immediately |
| HIGH | 75%+ shortfall | Source soon |
| MEDIUM | 50-74% shortfall | Source this week |
| LOW | <50% shortfall | Monitor / source as needed |
| PENDING ORDER PLACEMENT | Recent activity but no Infor POV stamp yet (OT PO without Infor stamp, OR VQ ticked with no PO at all). Recency = PO cut ≤90d OR promise date ≥ today | Chase the PO — order is committed but not fully placed. Informational on main tab |
| PENDING RECEIPT | Infor POV stamped, qty undelivered, recency rule satisfied | Wait — vendor shipment in flight. Informational on main tab |
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
| 6 | Inventory | Lam Owned Inventory? | YES if W115 > 0 |
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
| Join key? | **MPN only** — CPC not in Infor Item Lots Report |
| Threshold source? | INVENTORY sheet Column H (Reorder Threshold) |
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

---

## Files

| File | Description |
|------|-------------|
| `lam-kitting-runner.js` | Cron runner — chains cleanup → reorder → sourcing → rfq-write → customer-offer → email |
| `lam-kitting-reorder.js` | Reorder detection + ERP enrichment |
| `lam-kitting-source.js` | Franchise sourcing via shared API module |
| `lam-kitting-rfq-writer.js` | Writes RFQ + VQ lines for items without on-order |
| `lam-kitting-customer-offer.js` | Refreshes the customer-facing BI dashboard offer (type 1000025) |
| `lam-kitting-dashboard.js` | Dashboard generator |
| `output/LAM_Reorder_Alerts_*.csv` | Generated reorder alerts |
| `output/LAM_Reorder_Alerts_<date>_RFQ<N>_sourced.xlsx` | Sourced alerts + RFQ Line # column. RFQ search key baked into filename so the buyer can grep their inbox / Downloads folder by RFQ number. |
| `output/LAM_Reorder_Alerts_<date>_rfq_mapping.json` | MPN → RFQ line number map + auto-approved R_Request document numbers |
| `output/LAM_Reorder_Alerts_<date>_sourced_franchise_data.json` | Raw franchise API responses per MPN (used for auto-escalation margin checks against `chuboe_pricing_api_result`) |
| `output/LAM_Reorder_Alerts_<date>_escalations_context.json` | Sidecar: per-MPN inventory + POV state for every manual-escalation entry, used to synthesize stock-arrived rows |
| `output/LAM_Customer_Offer_<date>.json` | Customer-offer run metadata (offer ID, search key, line counts) |
| `lam-escalations.json` | Manual escalation entries — `{mpn, reason, date}`. Buyer-curated; auto-resolved only when MPN is off the reorder list AND zero stock |
| `Lam_Kitting_DB_*.xlsx` | Source Excel with thresholds and buyer data |
| `SIPOC FOR BUYER ADDITION.xlsx` | Original buyer reference (data now in Kitting DB Column J) |

---

## TODO

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
- [ ] Auto-load RFQ for reorder lines (via shared/rfq-writer.js)
- [ ] Add Mouser API to shared/franchise-api.js distributor list (module exists, needs BP verification)
- [x] Customer-facing LAM Kitting Inventory offer auto-refresh (Step 4c — replaces manual weekly update)
- [ ] **Phase 2 — Roster-wide lead-time refresher.** Customer offer currently only refreshes lead times for parts on this week's reorder list (~14 of 945). Above-threshold parts keep whatever was in the Kitting DB. Build a separate refresher that hits cached franchise API data (or scheduled API calls — monthly default, more frequent for short-lead, less for long-lead) for the full roster. Preserve manual override codes (LTB, Obsolete, EOL, NRND, TBD, etc.) — only refresh weeks-form values
- [ ] **Phase 3 — LAM EPG (round-2 wins) customer offer.** EPG is a separate award round under the same program. Build a parallel customer-facing offer with its own offer type (TBD — request from Chuck) so the BI dashboard can show kitting and EPG separately. Source data and pipeline to be defined

---

*Created: 2026-03-16*
*Updated: 2026-03-24* — Major overhaul: LAM-filtered ERP data, correct RFQ join path, 8 franchise APIs, cron automation, column reorganization, single buildAlert() architecture
*Updated: 2026-05-05* — Step 4c: customer-facing LAM Kitting Inventory offer auto-refresh (replaces manual weekly update). Roster-driven from Kitting DB; deactivate-prior + write-new pattern matches `inventory_cleanup.js`. Phase 2 (roster-wide lead-time refresh) and Phase 3 (LAM EPG separate offer) queued.
*Updated: 2026-05-05* — Priority overhaul + Escalations tab plumbing. (1) `PENDING RECEIPT` split into `PENDING ORDER PLACEMENT` (no Infor POV stamp yet) + `PENDING RECEIPT` (POV stamped). (2) `loadRecentPOVs` SQL recency filter — keep open POs only when cut ≤90d ago OR promise date still ≥ today; stale 2024–2025 POVs no longer leak (951→178 rows LAM-wide). (3) Escalations tab now sources from three places: manual entries (`lam-escalations.json`), stock-arrived synthesis (manual MPN above threshold but stock on hand → "Action with seller — new LAM resale still pending"), and auto entries for restricted-MFR margin compression (franchise <18% margin vs current LAM resale → Josh: push new resale based on franchise ref). (4) Escalations sidecar (`_escalations_context.json`) drives `persistResolvedEscalations` — manual entries only auto-resolve when off list AND zero stock; never on stock presence alone (operator removes from JSON when LAM approves new pricing).
