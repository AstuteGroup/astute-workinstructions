# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-05 (VQ Cleanup)**: Cleaned up repo - split outputs into `vq-upload-ready.csv` (231 records) and `needs-vendor.csv` (33 records). Added .gitignore for intermediate files. Removed 12 session-specific JSONs from git.
- **2026-03-05 (VQ Extraction - FINAL)**: Fixed vendor matching (domain-based, 61%→87%). Added NeedsVendor folder workflow. Final: 267 records, 92% RFQ, 87% vendor.
- **2026-03-05 (PDF Extraction)**: Extracted 33 records from 19 PDF attachments (multi-line quotes from ComS.I.T., Elcom Components).
- **2026-03-05 (Batch Extraction)**: Added 43 remaining quotes + 13 no-bids/target-price. Target price requests go to NoBid folder.
