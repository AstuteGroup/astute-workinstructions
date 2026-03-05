# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-05 (MPN Handling & Refresh)**: Clarified MPN field = customer's requested MPN, alternate goes in Vendor Notes as "Quoted MPN: xxx". Confirmed templates never implemented (100% manual extraction). Refreshed output: 231 records in vq-upload-ready.csv.
- **2026-03-05 (VQ Upload Ready)**: Finalized VQ Mass Upload Template format. Defaults: Lead Time="stock" (blank for no-bids), Currency=blank (USD implied). No-bids: qty=0, price=0, blank lead time, reason in Vendor Notes. Uploaded 231 records via iDempiere UI. API script coming in ~2 weeks.
- **2026-03-05 (VQ Template Format)**: Fixed output to match VQ Mass Upload Template with friendly column names. Documented all extraction fields (required vs optional) in vq-loading.md.
- **2026-03-05 (VQ Extraction - FINAL)**: Fixed vendor matching (domain-based, 61%→87%). Added NeedsVendor folder workflow. Final: 267 records, 92% RFQ, 87% vendor.
