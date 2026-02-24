# VQ Loading Workflow

Process for loading supplier quotes from emails into the VQ Mass Upload Template.

---

## Overview

When suppliers respond to RFQs, their quotes arrive via email. This workflow covers extracting quote data and loading it into OT (Orange Tsunami) using the VQ Mass Upload Template.

---

## Steps

### 1. Retrieve Supplier Quote Emails

- Check inbox for supplier quote responses
- Quotes may arrive as:
  - Email body text/tables
  - Attached spreadsheets (Excel, CSV)
  - PDF attachments

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
- Note the **Business Partner ID** if needed for the upload

### 4. Open the VQ Mass Upload Template

- Template location: `Trading Analysis/VQ Mass Upload Template.csv`
- Open in Excel or your preferred spreadsheet application

### 5. Map Quote Data to Template Columns

- Extract data from the supplier quote and enter into template columns:
  - **MPN** (Manufacturer Part Number)
  - **Manufacturer**
  - **Quantity**
  - **Unit Price**
  - **Lead Time**
  - **Date Code** (if provided)
  - **Condition** (New, Refurbished, etc.)
  - **Notes/Comments**

### 6. Save and Upload

- Save the completed template as: `VQ {RFQ#} {DATE}.csv`
- Upload to OT via the VQ Mass Upload function
- Verify the upload completed successfully

---

## Tips

- Double-check MPN formatting (spaces, dashes, suffixes)
- Confirm manufacturer names match OT's master list
- Flag any unusual conditions or date codes for review

---

## Related

- [Market Offer Matching for RFQs](../Market%20Offer%20Matching%20for%20RFQs/README.md)
- [Quick Quote](../Quick%20Quote/)
