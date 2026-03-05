# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-05 (VQ Upload Ready)**: Finalized VQ Mass Upload Template format. Defaults: Lead Time="stock" (blank for no-bids), Currency=blank (USD implied). No-bids: qty=0, price=0, blank lead time, reason in Vendor Notes. Uploaded 231 records via iDempiere UI. API script coming in ~2 weeks.
- **2026-03-05 (VQ Template Format)**: Fixed output to match VQ Mass Upload Template with friendly column names. Documented all extraction fields (required vs optional) in vq-loading.md.
- **2026-03-05 (VQ Extraction - FINAL)**: Fixed vendor matching (domain-based, 61%→87%). Added NeedsVendor folder workflow. Final: 267 records, 92% RFQ, 87% vendor.
- **2026-03-05 (PDF Extraction)**: Extracted 33 records from 19 PDF attachments (multi-line quotes from ComS.I.T., Elcom Components).
