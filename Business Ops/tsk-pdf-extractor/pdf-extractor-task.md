---
name: po-pdf-extractor
description: Extract structured data from Astute Purchase Order PDFs — use when processing POV documents for data entry, reconciliation, or integration with other systems
compatibility: opencode
metadata:
  type: task
  original_file: tsk-pdf-extractor/pdf-extractor-task.md
  category: data-extraction
  scope: business-ops
---

# PO PDF Extractor

## TOC

- [Purpose](#purpose)
- [Quick Start](#quick-start)
- [Output Fields](#output-fields)
- [Supported PO Formats](#supported-po-formats)
- [Create PO in OT](#create-po-in-ot)
  - [End-to-End Workflow](#end-to-end-workflow)
  - [Duplicate Check](#duplicate-check)
  - [Field Mapping](#field-mapping)
  - [Buyer Mapping](#buyer-mapping)
- [Known Limitations](#known-limitations)
  - [PDFs With No Warehouse Code](#pdfs-with-no-warehouse-code)
  - [MFR in TEST Environment](#mfr-in-test-environment)

## Purpose

The purpose of this task is to extract structured data from Astute Electronics Purchase Order PDFs and output JSON.

This is important because manual data entry from PO PDFs is error-prone and time-consuming. Automated extraction enables downstream workflows like reconciliation, ERP integration, and audit trails.

## Quick Start

**Installation:**

```bash
cd "Business Ops/tsk-pdf-extractor"
npm install
```

**Single PDF:**

```bash
node scripts/extractor.js "path/to/PO.pdf"
```

**Directory of PDFs:**

```bash
node scripts/extractor.js "path/to/folder/"
```

**Save to file:**

```bash
node scripts/extractor.js "path/to/PO.pdf" --output results.json
```

## Output Fields

The extractor produces JSON with these fields:

| Field | Type | Description |
|-------|------|-------------|
| `source_file` | string | Original PDF filename |
| `order_number` | string | PO number (e.g., "POV0077469") |
| `warehouse_code` | string\|null | Warehouse code (e.g., "W111") |
| `vendor.contact_name` | string | Vendor contact person |
| `vendor.company` | string | Vendor company name |
| `vendor.address` | string | Vendor address |
| `vendor.phone` | string | Vendor phone number |
| `deliver_to.company` | string | Delivery location name |
| `deliver_to.address` | string | Delivery address |
| `date` | string | Order date (e.g., "28 Jul 2026") |
| `vendor_code` | string | Internal vendor code (e.g., "V000031") |
| `currency` | string | Currency code (e.g., "USD") |
| `ship_via` | string | Shipping method |
| `is_3pl_order` | boolean | 3PL order flag |
| `is_factored_order` | boolean | Factored order flag |
| `terms` | string | Payment terms (e.g., "Net 30 Days") |
| `delivery_terms` | string | Delivery terms (e.g., "Ex-Works") |
| `buyer.name` | string | Buyer name |
| `buyer.email` | string | Buyer email |
| `salesperson.name` | string\|null | Salesperson name |
| `salesperson.email` | string\|null | Salesperson email |
| `line_items` | array | Array of line item objects |
| `total` | number | Order total |

**Line item fields:**

| Field | Type | Description |
|-------|------|-------------|
| `line_number` | number | Line number (1, 2, 3...) |
| `item_number` | string | Part/item number |
| `description` | string\|null | Item description |
| `due_date` | string | Due date |
| `unit_of_measure` | string | Unit (EA, PC, etc.) |
| `quantity_ordered` | number | Quantity |
| `unit_price` | number | Unit price |
| `extended_price` | number | Extended price (qty × unit) |
| `promised_date` | string\|null | Vendor promised date |
| `manufacturer` | string\|null | Manufacturer name |
| `item_revision` | string\|null | Item revision |
| `drawing_number` | string\|null | Drawing number |
| `drawing_revision` | string\|null | Drawing revision |
| `rohs` | string\|null | RoHS status ("Yes"/"No") |
| `line_notes` | string\|null | Freeform notes on line |

**Example output:**

```json
{
  "source_file": "POV0077469.pdf",
  "order_number": "POV0077469",
  "warehouse_code": "W111",
  "vendor": {
    "contact_name": "Jane Smith",
    "company": "ACME Electronics",
    "address": "123 Main Street, Suite 100, Anytown NY 12345, United States",
    "phone": "+1 (555) 123-4567"
  },
  "deliver_to": {
    "company": "Astute Electronics Inc - Brownsville",
    "address": "2450 Courage Street, Suite 108, Brownsville TX 78521, United States"
  },
  "date": "28 Jul 2026",
  "vendor_code": "V000031",
  "currency": "USD",
  "ship_via": "FedEx Ground",
  "is_3pl_order": false,
  "is_factored_order": false,
  "terms": "Net 30 Days",
  "delivery_terms": "Ex-Works",
  "buyer": {
    "name": "Jane Buyer",
    "email": "buyer@example.com"
  },
  "salesperson": {
    "name": "John Sales",
    "email": "sales@example.com"
  },
  "line_items": [
    {
      "line_number": 1,
      "item_number": "WFCP0603R0170FE66",
      "description": "Vishay WFCP0603 .017 1% E66 e3",
      "due_date": "28 Jul 2026",
      "unit_of_measure": "EA",
      "quantity_ordered": 10000,
      "unit_price": 0.13514,
      "extended_price": 1351.4,
      "promised_date": null,
      "manufacturer": "Vishay Intertechnology, Inc.",
      "item_revision": null,
      "drawing_number": null,
      "drawing_revision": null,
      "rohs": null,
      "line_notes": "Kitting reorder - franchise sourcing"
    }
  ],
  "total": 1351.4
}
```

## Supported PO Formats

This extractor handles Astute Electronics Purchase Order PDFs with the standard template:

- Single and multi-line POs
- Various shipping methods (FedEx, Courier, etc.)
- Different payment terms (Net 30, Net 45, Pro Forma, etc.)
- Optional fields (drawing info, RoHS, promised dates)
- Line notes/comments

> **Note** - The extractor is designed for Astute's specific PO template. Other PO formats may require modifications to the parsing logic.

## Create PO in OT

The `create-po-from-pdf.js` script creates a Purchase Order in OT from extracted PDF data.

```bash
node scripts/create-po-from-pdf.js "path/to/PO.pdf"
node scripts/create-po-from-pdf.js "path/to/extracted.json"

# When the PDF carries no warehouse code — see PDFs With No Warehouse Code:
node scripts/create-po-from-pdf.js "path/to/PO.pdf" --warehouse W111
node scripts/create-po-from-pdf.js "path/to/PO.pdf" --warehouse W111 --warehouse-group BROWNSVILLE

# When the Infor PO is already on an OT order — see Duplicate Check:
node scripts/create-po-from-pdf.js "path/to/PO.pdf" --allow-duplicate
```

### End-to-End Workflow

Steps 1-4 all run **before** anything is written. Any of them can stop the load, and nothing exists
in OT until step 5 — do not skip them.

1. [ ] **Extract** the PDF (or read pre-extracted JSON). Output: `poData` with buyer, warehouse code,
   delivery address, and line items.
1. [ ] **Resolve the vendor** from `vendor.company` via `VENDOR_MAP`. An unknown vendor stops the run
   — add it to the map, do not guess a Business Partner.
1. [ ] **Resolve warehouse and warehouse group.** Both are required on every line. Unresolved stops
   the run; supply `--warehouse` / `--warehouse-group` when the PDF carries neither.
1. [ ] **Run the duplicate check** — see [Duplicate Check](#duplicate-check). An already-loaded Infor
   PO stops the run unless `--allow-duplicate` is passed.
1. [ ] **Create the header** (`c_order`), then **create each line** (`c_orderline`).
1. [ ] **Confirm the result** — document number, line count, and buyer are printed on completion.
   A blank buyer is reported explicitly and needs a human to fill it in.

### Duplicate Check

The purpose of this check is to stop a re-run from silently creating a second copy of an order.

This is important because the Infor PO number is written to **`c_orderline.Chuboe_PO_String`** — on
the line, not the header — and nothing in the database enforces uniqueness on it. Before this check
existed, three copies of the same PO accumulated on TEST from repeat runs.

The script pages `c_orderline` for the PO's Infor number, collects the distinct parent orders, and
**stops before creating the header** if any exist, listing each one (document number, line count,
doc status, created date). Roughly 16 API calls and under a second for a 700-line PO.

> ⚠️ **Warning** - One Infor PO can legitimately map to several OT orders, usually one per vendor.
> In PROD the busiest example sits on 19 orders across two franchise distributors, and `STOCK` is
> used as a sentinel on 311. This is a stop-and-look guard, not a uniqueness constraint: pass
> `--allow-duplicate` when the split is genuine and the run proceeds after logging what exists.

Stopping suits a CLI run, where the person typing the command is present to decide. For email
intake the decision belongs to the submitter instead — the duplicate becomes a question emailed
back to them rather than a stop.

### Field Mapping

| OT Field | Source |
|----------|--------|
| Vendor (BP + Location) | `vendor.company` → VENDOR_MAP lookup |
| Order Date | `date` |
| Due Date | `line_items[].due_date` |
| Incoterm | `delivery_terms` → INCOTERM_MAP |
| Shipper | `ship_via` → SHIPPER_MAP |
| MPN | `line_items[].item_number` |
| Description | `line_items[].description` |
| Internal Notes | `line_items[].line_notes` |
| Warehouse | `warehouse_code` → WAREHOUSE_MAP (or `--warehouse`) |
| Warehouse Group | `deliver_to` address → WAREHOUSE_GROUP_MAP (or `--warehouse-group`) |
| Domestic Shipping | Vendor + delivery address country comparison |
| Infor PO | `order_number` |
| MFR | `line_items[].manufacturer` → API lookup |
| Buyer (`SalesRep_ID`) | `buyer.email` → `ad_user` lookup, `buyer.name` fallback |

New vendors must be added to `VENDOR_MAP` in the script. MFR is looked up dynamically via the OT API.

### Buyer Mapping

The PO's Buyer (`SalesRep_ID`) is resolved from the buyer named on the PDF — it is **not** hardcoded.
`lookupBuyer()` tries two things in order, caching the result per email/name:

1. `ad_user` filtered on `EMail eq '<buyer.email>'` — the reliable key
2. `ad_user` filtered on `Name eq '<buyer.name>'`

**There is no default buyer.** If neither lookup matches, `SalesRep_ID` is omitted from the header
and the PO is created with **Buyer blank** for a human to fill in — the load is not blocked, and the
order is never attributed to someone who did not raise it. The run prints
`Buyer: BLANK - "<name>" did not match an ad_user` so the gap is visible in the log.

**One email can match several `ad_user` rows.** A person gets one employee record plus a contact row
on every vendor or customer BP they are attached to — one buyer's address returns **6** active rows
in TEST, and the row the API returns first is a vendor-contact row, not the employee record.
`pickEmployeeUser()` disambiguates: the employee row is the one whose Business Partner is the person
themselves (`C_BPartner_ID.identifier === Name`); contact rows carry a company BP. Ties or no match
fall back to the lowest `id`.

`IsSalesRep` is **not** returned by the REST API for `ad_user`, so it cannot be used as the filter.

> ⚠️ **Warning** - Verify on PROD before first use. Duplicate-row counts in PROD are unknown, and
> the `C_BPartner_ID.identifier === Name` test has only been validated against TEST.

## Known Limitations

### PDFs With No Warehouse Code

Not every PO PDF carries a warehouse code — some headers are just `Order No: <POV number>`, and the
extractor returns `warehouse_code: null`.

Both `Chuboe_Warehouse_ID` and `Chuboe_Warehouse_Group_ID` are **required** on `c_orderline`; a null
fails the POST with `500 Could not convert value null for Chuboe_Warehouse[_Group]`. The header is
POSTed first, so before this was fixed such a PDF left an empty PO behind every time.

The script resolves and validates **both** before the header POST and stops with a usable message if
either is unresolved. Supply them on the command line when the PDF cannot:

```bash
node scripts/create-po-from-pdf.js "path/to/PO.pdf" --warehouse W111
node scripts/create-po-from-pdf.js "path/to/PO.pdf" --warehouse W111 --warehouse-group BROWNSVILLE
```

`WAREHOUSE_MAP` covers the 16 Infor codes that resolve to a `chuboe_warehouse` row.

> 📝 **Note** - The warehouse group is the receiving **region** and is independent of the warehouse:
> `c_orderline` pairs the LAM kitting warehouse with four different groups. It is detected from the
> delivery address, never derived from the warehouse.

### MFR in TEST Environment

> ⚠️ **Warning** - MFR population is unverified in PROD.
>
> The TEST environment rejects system-level MFR records (`ad_client_id=0`) as foreign keys, so the
> script skips MFR population there. Before the first PROD load, verify that:
>
> 1. [ ] MFR lookup returns valid IDs
> 1. [ ] MFR is set correctly on PO lines
> 1. [ ] Common manufacturers resolve to the right record
