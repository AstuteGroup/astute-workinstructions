# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-05 (VQ Automation & Notifications)**: Added email notifications after each cron fetch (via nodemailer to jake.harris@astutegroup.com). Fixed "folder already exists" error. Changed cron from 15 min to hourly. Clarified architecture: cron has full data access (DB, email, files) but can't do inference/interpretation—that requires Claude session or API. Templates run automatically; non-templated vendors need manual extraction.
- **2026-03-05 (MPN Fixes)**: Fixed RFQ matching for MPNs with commas/hyphens. Fixed CSV escaping. Added active vendor filter (`isactive='Y'`). Added vendor templates to workflow. Created template-candidates.csv. RFQ match: 248/267.
- **2026-03-05 (VQ Upload Ready)**: Finalized VQ Mass Upload Template format. Defaults: Lead Time="stock" (blank for no-bids), Currency=blank (USD implied). No-bids: qty=0, price=0, blank lead time, reason in Vendor Notes. Uploaded 231 records via iDempiere UI. API script coming in ~2 weeks.
- **2026-03-05 (VQ Template Format)**: Fixed output to match VQ Mass Upload Template with friendly column names. Documented all extraction fields (required vs optional) in vq-loading.md.
