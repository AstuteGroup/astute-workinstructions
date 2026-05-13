# PO Activity Analysis (per-month)

Comprehensive PO-activity workbook for a calendar month: PO + SO economics, OTIN inspection lifecycle, delivery performance vs promise date, tracking visibility, and 4-stage cycle benchmarks.

**First built:** 2026-05-13 (January 2026 snapshot). Output sits in `output/` for replay.

## What it produces

Excel workbook with 8 tabs (parts only — services / testing / fees / freight excluded via MPN regex + MFR='Charge' filter):

1. **Summary** — volume, $-economics, OTIN lifecycle, delivery performance, cycle benchmarks (median / P75 / P90 / max)
2. **Open Past-Due** — NOT_RECEIVED lines sorted by days-late, ready for buyer follow-up
3. **Buyer Status Matrix** — OTIN status counts per buyer (VALIDATED / LOT_OPEN / RECEIVED_NO_LOT / NOT_RECEIVED + past-due)
4. **By Buyer** — spend, revenue, validation %, past-due %, avg-days-late
5. **By Supplier** — on-time / validation rates by supplier
6. **By Customer** — GP $, open exposure, revenue-at-risk
7. **Cycle Benchmarks** — 4-stage cycle table (median / P75 / P90 / max)
8. **Cycle Times** — per-line breakdown of all 4 stages
9. **All Lines** — full dataset with 37 columns

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

See memory `project_ot_inspection_data_path.md` for the join chain (chuboe_po_receiving → m_attributeinstance → chuboe_insp_lot_lnk).

## SO revenue attribution — important gotcha

Multiple Jan POs can feed one customer-side RFQ line. Aggregating SO revenue by `chuboe_rfq_line_id` and assigning the full total to every PO triple-counts. We attribute revenue per-PO as:

```
attributed_so_revenue = po_qty × so_price_weighted_avg
```

This is bounded by what this specific PO supplied. Still over-attributes slightly when the customer order is also fulfilled by non-month POs — exact attribution would require shipment-level matching from `m_inout` to specific sales orderlines (not done here).

See memory `feedback_so_revenue_per_po_attribution.md`.

## How to re-run for a different month

1. Edit the date range in `po-activity-by-month.sql` (two lines, `tmp_jan_po` filter):
   ```sql
   AND o.dateordered >= 'YYYY-MM-01'
   AND o.dateordered <  'YYYY-MM+1-01'
   ```
2. Run the SQL: `psql -o ~/workspace/tmp/run.log -f po-activity-by-month.sql`. It COPYs the CSV to `/home/analytics_user/workspace/January_2026_POs.csv` — rename the output path in the SQL if you don't want to overwrite.
3. Run the Excel builder: `node build-po-activity-excel.js`. It reads the CSV from the hardcoded path and writes `January_2026_POs_Analysis.xlsx`. Update the file paths in the Node script for the new month.
4. (Optional) Email: `node send-po-activity-email.js` — sends from `stockRFQ@orangetsunami.com` to Jake with HTML summary + xlsx attachment.

## Caveats baked into this workbook

- **Services / testing / fees excluded** at the SQL level via regex + MFR='Charge'. 30 lines dropped from the January raw 570 → 541 parts.
- **`po_qty` falls back to `qtyentered`** when `qtyordered=0` (draft orders).
- **Promise date** is the OT field (`c_orderline.datepromised`) set at PO time — it doesn't auto-reflect vendor reschedules.
- **Inspection-validated timestamp** is `lot_lnk.updated` filtered to `isvalidate='Y'` (not `processedon` — that field is `0` for every January row, legacy). Vulnerable to later edits of the lnk row shifting the timestamp.
- **Tracking column** is `c_orderline.chuboe_trackingnumbers` — free-text, ~half real carrier numbers, half operator notes (`"sent 1.2/26"`). The standard iDempiere `m_inout.trackingno` is **not used** in this org.
- **Carrier site tracking lookups don't work from this environment** — both FedEx (Akamai) and UPS block headless browsers. Confirmed via Playwright with multiple stealth approaches on 2026-05-13. See `reference_carrier_sites_block_scraping.md`.

## Source data summary (January 2026 baseline)

- 427 distinct POVs / 570 lines raw → 413 POVs / 541 lines after parts filter
- 28 buyers, 189 suppliers, 83 customers
- 73% validated, 24% not received, ~1.5% in inspection, ~1.5% received-no-lot
- Median PO → first receipt: 11 days (P90 = 59)
- Median Inspection opened → validated: 5 days (P90 = 38)
- Median total PO → validated: 32 days (P90 = 81)
- Booked margin (qty-weighted): 61.9%
- 48% of lines have tracking on PO line; the other 52% have none

## Files in this folder

- `po-activity-analysis.md` — this doc
- `po-activity-by-month.sql` — the multi-pass SQL (5 passes + final assembly + summary)
- `build-po-activity-excel.js` — Node script consuming the CSV → xlsx workbook
- `send-po-activity-email.js` — Email sender wrapping `shared/notifier.js`
- `output/January_2026_POs.csv` — flat data for Jan 2026
- `output/January_2026_POs_Analysis.xlsx` — full Excel workbook for Jan 2026
