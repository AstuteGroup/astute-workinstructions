# VQ Loading Workflow

Process for loading supplier quotes from emails into the VQ Mass Upload Template.

---

## Overview

When suppliers respond to RFQs, their quotes arrive via email to `vq@orangetsunami.com`. This workflow covers extracting quote data and loading it into OT (Orange Tsunami) using the VQ Mass Upload Template.

---

## Automated VQ Parser

The `vq-parser` tool automatically processes supplier quote emails **directly from the VQ inbox** via Himalaya CLI.

> **Process Change**: Previously, quote emails were manually downloaded as .msg files to a GitHub folder for parsing. The new process connects directly to `vq@orangetsunami.com` via IMAP - no manual download required.

### Location

```
~/workspace/vq-parser/
```

### Features

- **Direct Inbox Access**: Reads emails directly from VQ inbox via Himalaya CLI (no .msg download needed)
- **Multi-Source Extraction**: Parses quotes from:
  - Email body text/tables
  - PDF attachments
  - Excel/CSV attachments
  - Hyperlinks to quote portals (GREENCHIPS, etc.)
- **Field Mapping**: Automatically maps to VQ template columns
- **Vendor Lookup**: Matches suppliers to Business Partner records in DB
- **RFQ Resolution**: Extracts RFQ number from subject/body

### Commands

```bash
# Process new emails from inbox
node ~/workspace/vq-parser/src/index.js fetch

# Dry run (parse without generating CSV)
node ~/workspace/vq-parser/src/index.js fetch --dry-run --verbose

# Process specific email
node ~/workspace/vq-parser/src/index.js reprocess <email_id> --verbose

# Test connection
node ~/workspace/vq-parser/src/index.js test-connection

# Check status
node ~/workspace/vq-parser/src/index.js status
```

### Output

CSVs are written to `~/workspace/vq-parser/output/` with naming:
```
VQ_{RFQ#}_{Sender}_{Timestamp}.csv
```

---

## Manual Steps (when automation fails)

### 1. Retrieve Supplier Quote Emails

- Check inbox for supplier quote responses
- Quotes may arrive as:
  - Email body text/tables
  - Attached spreadsheets (Excel, CSV)
  - PDF attachments
  - Hyperlinks to quote portals

### 2. Identify the Supplier

- Determine the supplier from:
  - Email sender domain
  - Email signature
  - Company name in the quote header
- Note the supplier name exactly as it appears

### 3. Look Up Supplier in OT

- Open OT (Orange Tsunami / iDempiere)
- Search for the supplier in the Business Partner window
- Verify you have the correct supplier record
- Note the **Business Partner Search Key** for the upload

### 4. Open the VQ Mass Upload Template

- Template location: `Trading Analysis/VQ Mass Upload Template.csv`
- Open in Excel or your preferred spreadsheet application

### 5. Map Quote Data to Template Columns

Extract data from the supplier quote and enter into template columns:

| Column | Description | Valid Values |
|--------|-------------|--------------|
| `chuboe_rfq_id` | RFQ Search Key | Numeric ID from system |
| `chuboe_buyer_id` | Buyer name | e.g., "Jake Harris" |
| `c_bpartner_id` | Business Partner Search Key | Numeric ID from OT |
| `ad_user_id` | Contact name | Supplier contact |
| `chuboe_mpn` | Manufacturer Part Number | Exact MPN |
| `chuboe_mfr_text` | Manufacturer name | e.g., "Texas Instruments" |
| `qty` | Quoted Quantity | Numeric |
| `cost` | Unit Price | Decimal (e.g., 0.320) |
| `c_currency_id` | Currency | `USD`, `EUR`, `GBP`, `CNY`, etc. (ISO codes) |
| `chuboe_date_code` | Date Code | e.g., "2024+", "06" |
| `chuboe_moq` | Minimum Order Quantity | Numeric |
| `chuboe_spq` | Standard Pack Quantity | Numeric |
| `chuboe_packaging_id` | Packaging type | `AMMO`, `BOX`, `BULK`, `CUT TAPE`, `F-REEL`, `F-TRAY`, `F-TUBE`, `OTHER`, `REEL`, `TRAY` |
| `chuboe_lead_time` | Lead Time | e.g., "Stock", "2-3 weeks" |
| `c_country_id` | Country of Origin | 2-letter ISO codes: `US`, `CN`, `TW`, `MY`, `JP`, etc. |
| `chuboe_rohs` | RoHS Compliant | `Y`, `N`, or empty |
| `chuboe_note_public` | Vendor Notes | Free text |

### 6. Save and Upload

- Save the completed template as: `VQ {RFQ#} {DATE}.csv`
- Upload to OT via the VQ Mass Upload function
- Verify the upload completed successfully

---

## Tips

- Double-check MPN formatting (spaces, dashes, suffixes)
- Confirm manufacturer names match OT's master list
- Flag any unusual conditions or date codes for review
- Currency must be ISO code (USD, not $)
- Packaging must match exactly from the valid list
- COO must be 2-letter ISO country code

---

## Related

- [Market Offer Matching for RFQs](../Market%20Offer%20Matching%20for%20RFQs/README.md)
- [Quick Quote](../Quick%20Quote/)
