# CRMA Form Filling Workflow

Fills the customer-RMA xlsx (`CRMA Request Form 2023.06.xlsx`) from a sales-order number when Jake forwards a blank form to **stockRFQ@orangetsunami.com** and gives the order details in chat.

OT supplies most fields. The four Infor-only fields (Customer Code, Astute Invoice Number, Infor Item Number, Lot Number) are left blank for the buyer.

---

## End-to-End Workflow

### Step 1 — Pull the blank form from the stockRFQ inbox

```bash
node fetch-form.js
```

Looks for the most recent message with subject containing `CRMA Form` and downloads the `CRMA Request Form *.xlsx` attachment to `tmp/crma-<timestamp>/`.

**Output:** local copy of the blank form.

**Do not skip:** the form is revved periodically (current rev = `2023.06`). When the rev changes, re-run `inspect-form.js` (Step 6 of "Re-deriving for new revs" below).

---

### Step 2 — Look up the order in OT

Inputs from buyer: SO# (e.g. `SO506499`), RMA quantity, reason text.

Run the lookup query:

```sql
SELECT
  o.c_order_id, o.documentno, o.poreference, o.dateordered,
  bp.value AS bp_search_key, bp.name AS customer_name, bp.referenceno AS infor_c_code,
  ol.line, ol.qtyentered, ol.priceentered,
  ol.chuboe_co_string,                             -- Infor COV
  ol.chuboe_mpn, mfr.name AS mfr,
  ol.chuboe_trackingnumbers,
  ol.chuboe_vq_line_id, ol.chuboe_cq_line_id, ol.chuboe_rfq_line_id,
  u.name AS salesperson
FROM adempiere.c_order o
JOIN adempiere.c_orderline ol  ON ol.c_order_id = o.c_order_id
JOIN adempiere.c_bpartner bp   ON bp.c_bpartner_id = o.c_bpartner_id
LEFT JOIN adempiere.chuboe_mfr mfr ON mfr.chuboe_mfr_id = ol.chuboe_mfr_id
LEFT JOIN adempiere.ad_user u  ON u.ad_user_id = o.salesrep_id
WHERE o.documentno = :SO_NUMBER
  AND o.issotrx = 'Y' AND o.isactive = 'Y' AND ol.isactive = 'Y'
ORDER BY ol.line;
```

Then resolve the **lot unit cost** via the winning VQ on the same RFQ line:

```sql
SELECT cost
FROM adempiere.chuboe_vq_line
WHERE chuboe_rfq_line_id = :rfq_line_id
  AND ispurchased = 'Y'
  AND isactive = 'Y'
LIMIT 1;
```

And the customer contact:

```sql
SELECT name, email, phone
FROM adempiere.ad_user
WHERE c_bpartner_id = :bp_id AND isactive = 'Y'
ORDER BY name;
```

---

### Step 3 — Confirm the dropdown picks with the buyer

The buyer almost always wants you to make the call, but two picks are recurring judgment calls — confirm if ambiguous:

- **Root Cause** (`Carrier` for in-transit damage; `Supplier`, `Astute`, `Customer`, `Product` otherwise)
- **Disposition** — there is no combined "scrap + replace" option. Default convention: pick **`Credit and Replace`** (customer-facing action) and call out scrap-in-place in the Explanation. Switch to `Credit and Scrap` if the buyer prefers.

---

### Step 4 — Fill the form

```bash
node fill-form.js --so SO506499 --qty 8 --src tmp/crma-<ts>/CRMA*.xlsx --out tmp/CRMA_<so>_<customer>_<mpn>_<qty>pc.xlsx
```

Cell map (form rev 2023.06 — see "Cell map" section below for the full table). Only first cell of each merge needs to be set.

**Do not skip:** when writing values, drop `cell.w` (cached display) so Excel re-formats numbers/dates per the cell's `z` format. Otherwise Excel shows the old cached string.

---

### Step 5 — Email the filled form back to the buyer

```bash
node email-form.js --to jake.harris@Astutegroup.com --file tmp/CRMA_<so>_*.xlsx
```

Send via stockRFQ@ notifier. Subject pattern: `CRMA Draft - <SO> / <COV> - <Customer> <MPN> (<qty> pc <reason>)`. Body should list:
- What was filled (with the dropdown picks called out)
- What was left blank for the buyer (lot, invoice, customer code, Infor item)
- Any judgment calls (e.g. disposition pick) so the buyer can override

---

## Naming Gotchas (DO NOT GUESS)

| Form label | Actual source | Wrong source (common mistake) |
|---|---|---|
| **"Astute COV"** | `c_orderline.chuboe_co_string` (e.g. `COV0021316`) | OT `c_order.documentno` (e.g. `SO506499`) |
| **"Customer Code"** | `c_bpartner.referenceno` — Infor C-format (e.g. `C002971`); often blank → leave blank for buyer | OT `c_bpartner.value` (numeric search key) |
| **"Infor Item Number"** | Infor product code (buyer provides) | OT `m_product.value` (usually `GenSalesProd` for trading lines) |
| **"Lot Number(s)"** | Buyer provides (consignment lots are allocated by Infor at ship time, not in OT replica). For stock warehouses, look up via the inventory report. | Anything in OT — there is no lot column on the orderline |
| **"QTY" (R12 area)** | The **RMA** qty (broken/affected pieces) | Order qty / shipped qty |

---

## Cell Map (form rev 2023.06)

Answer cells (write to the **first cell** of each merge):

| Field | Cell | Type | Source |
|---|---|---|---|
| Astute Salesperson | `C3` | text | `ad_user.name` via `c_order.salesrep_id` |
| Customer Name | `H3` | text | `c_bpartner.name` |
| Astute COV | `C5` | text | `c_orderline.chuboe_co_string` |
| Customer Code | `H5` | text | `c_bpartner.referenceno` (often blank → leave) |
| Astute COV Line | `C6` | number | `c_orderline.line` |
| RMA Request Date | `C8` | date `mm/dd/yyyy` | today |
| Astute Invoice Number | `H8` | text | buyer provides |
| Infor Item Number | `C10` | text | buyer provides |
| Lot Number(s) | `C13` | text | buyer provides (or inventory report for stock warehouses) |
| QTY | `E13` | number `#,##0` | RMA qty |
| Selling Unit Price | `F13` | currency `$#,##0.00` | `c_orderline.priceentered` |
| Lot Unit Cost | `G13` | currency `$#,##0.00` | winning VQ `cost` |
| **Reason Code for Return** | `C17` | **dropdown** — see below | |
| **Root Cause / Fault** | `H17` | **dropdown** — see below | |
| **Return Disposition** | `C19` | **dropdown** — see below | |
| **Return Via** | `H19` | **dropdown** — see below; blank if no physical return | |
| Explanation for Return | `C21` (merged C21:I25) | text | free text |
| Customer Contact Name | `C28` | text | `ad_user.name` |
| Customer Contact Email | `C29` | text | `ad_user.email` |
| Customer Contact Phone | `C30` | text | `ad_user.phone` |
| Package Type | `H28` | dropdown | blank if no return |
| Package Quantity | `H29` | number | blank if no return |

VRMA section (rows 37+) — only when returning physical pieces to an external supplier. Internal consignment (Taxan, Eaton, GE, LAM, etc.) = SKIP.

---

## Dropdown Source Ranges (must match exactly — these are data-validation lists)

> **Trap:** the visible label "Reason Code for Return" pulls from the **fault** list `Q9:Q21`, NOT the reason list `P6:P11`. The `P6:P11` list is only used by the VRMA-section "Reason for Return" field.

| Field | Source range | Values |
|---|---|---|
| **Reason Code for Return** (`C17`) | `$Q$9:$Q$21` | `DMG - Damaged item(s)` · `FAI - Missing/incomplete FAI sent with item(s)` · `FAU - Faulty item(s)` · `IDC - Incorrect Date Code of item(s)` · `IDE - Item(s) delivered early to customer` · `IIA - Incorrect Item(s) delivered by Astute` · `IIC - Incorrect Item(s) ordered by Customer` · `IIV - Incorrect Item(s) delivered by vendor` · `IP - Incorrect paperwork sent with item(s)` · `OCC - Order cancelled by Customer` · `PKG - Incorrect packaging of Item(s)` · `PQ - Poor Quality` · `QTY - Incorrect quantity delivered by Astute` |
| **Root Cause / Fault** (`H17`) | `$Q$3:$Q$7` | `Supplier` · `Astute` · `Customer` · `Carrier` · `Product` |
| **Return Disposition** (`C19`) | `$Q$23:$Q$29` | `Credit Only` · `Credit and Replace` · `Credit and Scrap` · `Credit and RTV` · `Credit and Move to Stock` · `Credit and More Investigation` · `No Credit and More Investigation` |
| **Return Via** (`H19`) | `$Q$36:$Q$37` | `Astute to Collect` · `Customer Carrier` |
| **Package Type** (`H28`) | `$Q$44:$Q$46` | `Box` · `Pallet` · `Other` |
| VRMA Disposition (`C46`) | `$Q$39:$Q$42` | `Refund + Return` · `Refund + Scrap` · `Credit + Return` · `Credit + Scrap` |
| VRMA Method of Return (`C51`) | `$P$25:$P$29` | `DHL` · `UPS` · `FedEx` · `Local Courier` · `Other` |
| VRMA Ship Destruct? (`C44`) | `$P$40:$P$41` | `Yes` · `No` |
| VRMA Reason for Return (`C48` / `H49`) | `$P$6:$P$11` | `INCORRECT PACKAGING` · `INCORRECT QTY RECEIVED` · `INCORRECT DATE CODE` · `PARTS DELIVERED EARLY` · `INCORRECT PART ORDERED` · `DAMAGED/FAULTY` |

Any string written to a dropdown cell that doesn't match the source list verbatim will be flagged as invalid by Excel when the buyer opens the file.

---

## Disposition Convention for "Scrap + Replace"

Dropdown has no combined option. Convention (validated 2026-04-24 on SO506499):

- Pick **`Credit and Replace`** in the Disposition cell
- Call out "customer scrapping in place — no physical return required" in the Explanation
- Leave **Return Via** blank
- Leave Package Type / Quantity blank

---

## Re-deriving for New Form Revs

When the buyer forwards a new rev (e.g. `CRMA Request Form 2024.XX.xlsx`), the cell map and dropdown source ranges may have shifted. Re-derive:

1. `node inspect-form.js --src <new-form>.xlsx` — dumps merge ranges and the `<dataValidations>` block from `xl/worksheets/sheet1.xml`
2. Compare merge layout vs the table above; update cell coords if they shifted
3. Compare each `<dataValidation type="list">` `formula1` ref vs the dropdown table; update if ranges shifted
4. Update the rev number in this doc and in the script defaults

---

## Reference Scripts

Located in this folder:

| Script | Purpose |
|---|---|
| `fetch-form.js` | Pull the blank form from stockRFQ inbox |
| `inspect-form.js` | Dump merges + dataValidation XML (re-run when form revs) |
| `fill-form.js` | Fill cells, preserve styles |
| `email-form.js` | Email filled draft back to buyer via stockRFQ notifier |

All four use `xlsx` with `cellStyles: true` and the shared `email-fetcher` / `notifier` modules.
