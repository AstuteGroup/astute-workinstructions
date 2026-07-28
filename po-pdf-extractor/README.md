# Astute Purchase Order PDF Extractor

Extracts structured data from Astute Electronics Purchase Order PDFs and outputs JSON.

## What It Does

This tool parses Astute PO PDFs and extracts:

- **Order Header**: Order number, warehouse code, date, vendor code, currency
- **Vendor Info**: Contact name, company, address, phone
- **Delivery Address**: Company name, full address
- **Terms**: Ship via, payment terms, delivery terms, 3PL/factored flags
- **People**: Buyer and salesperson names and emails
- **Line Items** (supports multiple per PO):
  - Part number and description
  - Quantity, unit price, extended price
  - Due date and promised date
  - Manufacturer
  - Item revision, drawing number/revision
  - RoHS status
  - **Line notes** (freeform text at bottom of each line)
- **Total**: Order total amount

## Installation

Requires Node.js v18+.

```bash
cd po-pdf-extractor
npm install
```

## Usage

### Single PDF
```bash
node extractor.js "path/to/PO.pdf"
```

### Directory of PDFs
```bash
node extractor.js "path/to/folder/"
```

### Save to File
```bash
node extractor.js "path/to/PO.pdf" --output results.json
```

## Example Output

```json
{
  "source_file": "POV0077469.pdf",
  "order_number": "POV0077469",
  "warehouse_code": "W111",
  "vendor": {
    "contact_name": "Glenn Fajfer",
    "company": "Avnet EM",
    "address": "102 Motor Parkway, Suite 420, Hauppauge NY 11788, United States",
    "phone": "+1 (631) 582 7742"
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
    "name": "Jake Harris",
    "email": "jake.harris@astutegroup.com"
  },
  "salesperson": {
    "name": "Josh Syre",
    "email": "josh.syre@astutegroup.com"
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
      "line_notes": "LAM kitting reorder - franchise sourcing"
    }
  ],
  "total": 1351.4
}
```

## Output Fields Reference

| Field | Type | Description |
|-------|------|-------------|
| `source_file` | string | Original PDF filename |
| `order_number` | string | PO number (e.g., "POV0077469") |
| `warehouse_code` | string\|null | Warehouse code if present (e.g., "W111") |
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
| `line_items[].line_number` | number | Line number (1, 2, 3...) |
| `line_items[].item_number` | string | Part/item number |
| `line_items[].description` | string\|null | Item description |
| `line_items[].due_date` | string | Due date |
| `line_items[].unit_of_measure` | string | Unit (EA, PC, etc.) |
| `line_items[].quantity_ordered` | number | Quantity |
| `line_items[].unit_price` | number | Unit price |
| `line_items[].extended_price` | number | Extended price (qty × unit) |
| `line_items[].promised_date` | string\|null | Vendor promised date |
| `line_items[].manufacturer` | string\|null | Manufacturer name |
| `line_items[].item_revision` | string\|null | Item revision |
| `line_items[].drawing_number` | string\|null | Drawing number |
| `line_items[].drawing_revision` | string\|null | Drawing revision |
| `line_items[].rohs` | string\|null | RoHS status ("Yes"/"No") |
| `line_items[].line_notes` | string\|null | Freeform notes on line |
| `total` | number | Order total |

## Supported PO Formats

This extractor is designed for Astute Electronics Purchase Order PDFs with the standard template. It handles:

- Single and multi-line POs
- Various shipping methods (FedEx, Courier, etc.)
- Different payment terms (Net 30, Net 45, Pro Forma, etc.)
- Optional fields (drawing info, RoHS, promised dates)
- Line notes/comments

## License

Internal use - Astute Electronics
