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

**Usage:**

```bash
node scripts/create-po-from-pdf.js "path/to/PO.pdf"
node scripts/create-po-from-pdf.js "path/to/extracted.json"
```

**Fields populated:**

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
| Warehouse | `warehouse_code` → WAREHOUSE_MAP |
| Warehouse Group | `deliver_to.company` (Brownsville detection) |
| Domestic Shipping | Vendor + delivery address country comparison |
| Infor PO | `order_number` |
| MFR | `line_items[].manufacturer` → API lookup |

**Vendor/MFR Mapping:**

New vendors must be added to `VENDOR_MAP` in the script. MFR is looked up dynamically via the OT API.

## Known Limitations

### MFR in TEST Environment

> **TODO: Test MFR population when moving to PROD**
>
> The TEST environment rejects system-level MFR records (ad_client_id=0) as foreign keys. The script skips MFR population in TEST. When deploying to PROD, verify that:
> 1. MFR lookup returns valid IDs
> 2. MFR is correctly set on PO lines
> 3. Common manufacturers (Vishay, Molex, etc.) resolve correctly
