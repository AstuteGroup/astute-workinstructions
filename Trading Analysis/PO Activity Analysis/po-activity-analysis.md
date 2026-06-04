# PO Activity Analysis (date range)

Comprehensive PO-activity workbook + management deck for any date range: PO + SO economics, OTIN inspection lifecycle, delivery performance vs promise date, tracking visibility, 4-stage cycle benchmarks, cumulative MFR breakdown, and per-CPC VQ→PO+SO conversion.

**First built:** 2026-05-13 (January 2026 snapshot). **Expanded 2026-05-25** to accept arbitrary date ranges, add MFR breakdown + conversion analysis + management-meeting PowerPoint deck.

## Quick start

```bash
node 'Trading Analysis/PO Activity Analysis/build-po-activity.js' \
  --start 2026-01-01 --end 2026-05-01 --label 2026-Jan-Apr
```

`--end` is **exclusive** — use the first day of the month AFTER the last month you want. For "Jan through Apr 2026", end = `2026-05-01`. For just January, end = `2026-02-01`.

Outputs land in `output/<label>/`:
- `<label>_POs.csv` — line-level fact table (~35 cols)
- `<label>_MFR_breakdown.csv` — cumulative top-50 MFR aggregation
- `<label>_CPC_conversion.csv` — per-CPC VQ→PO+SO conversion detail
- `<label>_POs_Analysis.xlsx` — 11-tab Excel workbook (the operational deliverable)
- `<label>_POs_Slides.pptx` — 3-slide management deck (headline + operational + concentration)

## What the Excel produces (11 tabs)

| # | Tab | Purpose |
|---|---|---|
| 1 | **Summary** | Headline volume, $-economics, conversion, OTIN, delivery, cycle benchmarks |
| 2 | **Open Past-Due** | NOT_RECEIVED lines sorted by days-late — buyer follow-up worklist |
| 3 | **Buyer Status Matrix** | OTIN status counts per buyer (Validated / Lot Open / Received-No-Lot / Not Received / Past-Due) |
| 4 | **By Buyer** | Spend, revenue, validation %, past-due %, avg-days-late |
| 5 | **By Supplier** | On-time / validation rates by supplier |
| 6 | **By Customer** | GP $, open exposure, revenue-at-risk |
| 7 | **MFR Breakdown** | *(NEW)* Top 50 manufacturers — PO lines, supplier reach, customer reach, spend, attributed revenue, booked GP, margin, validation %, past-due % |
| 8 | **Conversion** | *(NEW)* Per-CPC VQ→PO+sold-CQ conversion. One row per CPC that had a VQ in the period; flagged for PO Placed / Sold CQ / Converted (both) |
| 9 | **Cycle Benchmarks** | 4-stage cycle table (median / P75 / P90 / max) |
| 10 | **Cycle Times** | Per-line breakdown of all 4 stages |
| 11 | **All Lines** | Full dataset with ~40 columns |

## What the PowerPoint produces (2 slides — purchasing lens)

1. **Purchasing Activity — Headline** — POVs, PO lines, suppliers, manufacturers, total PO spend, customers served, CPCs sourced, **VQ→PO conversion** (pure sourcing-execution rate, no SO dependence; auto-match VQs from CalcuQuote/StockCQ bpartners excluded). KPI tile grid.
2. **Spend Concentration** — Top 10 manufacturers + top 10 suppliers by PO spend (with % of total). Bottom-of-slide narrative includes a one-line shoutout to the top buyer for the period (memory-bulk-buy concentration angle).

**Sales Mix data is computed and dropped into the xlsx 'Sales Mix' tab**, but intentionally NOT on the deck — most of the line volume is sales-side activity (Shortage, PPV, EOL) owned by other reporters, so including it on a purchasing operator's deck creates scope confusion. The Stock segment specifically is ~2% of iDempiere-tracked SO lines, and the iDempiere number undercounts (pure-stock sales handled entirely in Infor aren't captured). For Stock-segment reporting use the dedicated Stock workflows + an Infor extract, not this deck.

**Intentionally excluded from the deck:**
- **Buyer counts and By-Buyer leaderboard** — the raw `distinct_buyers` figure (e.g., 42 for Jan-Apr) counts every ad_user assigned to any PO line including coverage / one-off assignments, so it overstates the actual buying team. The full buyer roster lives in the `By Buyer` xlsx tab; the deck only acknowledges the single top buyer in the slide 2 narrative.
- **Finance metrics** — attributed revenue, booked margin, GP, SO at risk. Live in the Summary / By Customer / MFR Breakdown tabs for finance/sales audiences.
- **Operational health** — validation %, past-due %, cycle benchmarks. Live in Summary / Cycle Benchmarks / Open Past-Due tabs. The commented-out operational-health block in `build-po-activity.js` can be re-enabled for a different audience.

## 4-stage cycle definition

| Stage | Start → End | Source |
|---|---|---|
| 1. PO placed → first receipt | `c_order.dateordered` → `MIN(m_inout.movementdate)` | Vendor lead time + transit |
| 2. Receipt → inspection opened | `MIN(m_inout.movementdate)` → `chuboe_insp_lot_lnk.created` | Warehouse staging |
| 3. Inspection opened → validated | `chuboe_insp_lot_lnk.created` → `chuboe_insp_lot_lnk.updated` *(where isvalidate='Y')* | Inspection work + queue |
| Total | `c_order.dateordered` → `chuboe_insp_lot_lnk.updated` | End-to-end PO→Valid |

## OTIN status enum

| Status | Definition |
|---|---|
| `NOT_RECEIVED` | No m_inout receipt linked to the PO line |
| `RECEIVED_NO_LOT` | Receipt exists, no `m_attributesetinstance` (OTIN lot) allocated yet |
| `LOT_OPEN` | Lot exists with lnk records, but no `isvalidate='Y'` flip |
| `VALIDATED` | At least one `chuboe_insp_lot_lnk.isvalidate='Y'` for the lot |
| `PROCESSED` | Validated AND `processed='Y'` (final state) |

See memory `project_ot_inspection_data_path.md` for the join chain (chuboe_po_receiving → m_attributeinstance → chuboe_insp_lot_lnk).

## VQ→PO+SO conversion definition

**Universe (denominator):** distinct CPCs (`chuboe_rfq_line.chuboe_cpc`) where at least one `chuboe_vq_line` was created during the period.

**Conversion (numerator):** subset of those CPCs that ALSO have, in the same period:
- a sold customer quote (`chuboe_cq_line.issold='Y'`), AND
- a PO placed (`c_orderline` joined via `chuboe_vq_line_id` to a VQ on the same RFQ line, with `chuboe_po_string LIKE 'POV%'`).

**Why this definition:** It's the full cycle — we sourced AND won AND placed the buy. Catches stripped-out cases like "we quoted but never won" or "we won but bought from inventory without a fresh PO".

**Caveat:** A CPC can appear on multiple customers' RFQs over a period. The conversion flag is per-CPC across all of them, not per-(CPC × customer). The CSV `Customer(s)` column shows the comma-separated list. Set memory if a deeper per-customer cut is needed.

## SO revenue attribution — important gotcha

Multiple POs in the period can feed one customer-side RFQ line. Aggregating SO revenue by `chuboe_rfq_line_id` and assigning the full total to every PO triple-counts. We attribute revenue per-PO as:

```
attributed_so_revenue = po_qty × so_price_weighted_avg
```

This is bounded by what this specific PO supplied. Still over-attributes slightly when the customer order is also fulfilled by non-period POs — exact attribution would require shipment-level matching from `m_inout` to specific sales orderlines (not done here).

## How to re-run for a different range

```bash
# Just January 2026
node build-po-activity.js --start 2026-01-01 --end 2026-02-01 --label 2026-Jan

# Full Q1 2026
node build-po-activity.js --start 2026-01-01 --end 2026-04-01 --label 2026-Q1

# Jan through May (when May closes)
node build-po-activity.js --start 2026-01-01 --end 2026-06-01 --label 2026-Jan-May

# Custom out-dir (defaults to ./output/<label>/)
node build-po-activity.js --start 2026-01-01 --end 2026-05-01 --label 2026-Jan-Apr \
  --out-dir /home/analytics_user/workspace/po-activity-2026-Q1
```

The script substitutes the date range + output paths into `po-activity-by-range.sql`, runs psql, then reads the three CSVs to build the Excel + pptx. Roughly 5-10 seconds end-to-end for a 4-month range.

## Caveats baked into this analysis

- **Services / testing / fees / freight excluded** at the SQL level via MPN regex + `MFR='Charge'` filter.
- **`po_qty` falls back to `qtyentered`** when `qtyordered=0` (draft orders).
- **Promise date** is the OT field (`c_orderline.datepromised`) set at PO time — does not auto-reflect vendor reschedules.
- **Inspection-validated timestamp** is `lot_lnk.updated` filtered to `isvalidate='Y'` (not `processedon` — that field is `0` for most rows in this org, legacy). Vulnerable to later edits of the lnk row shifting the timestamp.
- **Tracking column** is `c_orderline.chuboe_trackingnumbers` — free-text, ~half real carrier numbers, half operator notes (`"sent 1.2/26"`). The standard iDempiere `m_inout.trackingno` is **not used** in this org.
- **MFR-as-commodity proxy.** This org has no native commodity field on `m_product` (the iDempiere category is just "Standard"). MFR serves as a workable commodity grouping for top-line memory / passives / analog / digital tendencies, but is lossy for broad-line MFRs (TI, ST, ON, NXP). Inferred-commodity heuristics are not in scope of this workflow.
- **`days_late` is measured from the script-run date**, not the end of the period. Re-running the same period on a later date will inflate the "worst days late" figure.
- **Carrier site tracking lookups don't work from this environment** — both FedEx (Akamai) and UPS block headless browsers. See `reference_carrier_sites_block_scraping.md`.

## Snapshots in `output/`

Each run lands in `output/<label>/`. Past artifacts:

| Label | Range | Notes |
|---|---|---|
| `2026-Jan-Apr/` | 2026-01-01 → 2026-05-01 | Spring 2026 management-meeting deck |

Plus the original Jan-only Excel + CSV at the workspace root (`January_2026_POs.csv` and `…_Analysis.xlsx`) — kept as the historical artifact from the 2026-05-13 first build.

## Files in this folder

| File | Role |
|---|---|
| `po-activity-analysis.md` | this doc |
| `po-activity-by-range.sql` | **template SQL** — driver substitutes `@START_DATE@ / @END_DATE@ / @OUT_*@` placeholders. Do not invoke directly without manual substitution. |
| `build-po-activity.js` | **driver** — fills the template, runs psql, builds xlsx + pptx. The thing you run. |
| `send-po-activity-email.js` | Optional: email the workbook to Jake via `shared/notifier.js` |
| `legacy/po-activity-by-month.sql` | Original hardcoded-Jan SQL (superseded by the range template) |
| `legacy/build-po-activity-excel.js` | Original Jan-only Excel builder (superseded by the unified driver) |
| `output/<label>/` | Per-run outputs (CSV + xlsx + pptx) |
