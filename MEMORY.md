# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-02-28**: Fixed VQ Parser batch reprocess and vendor matching. Key fixes: (1) batch-reprocess.js now uses current folder IDs instead of stored IDs (IMAP IDs change when emails move), (2) added domain-based vendor lookup (e.g., velocityelec.com → Velocity Electronics), (3) added name-based fallback. Results: 88% email read success, 79% vendor match rate (up from 54%). 266 records in final upload. Files: `vq_parser/scripts/batch-reprocess.js`, `vq_parser/src/mapper/vendor-lookup.js`.
- **2026-02-27 (PM)**: Completed VQ Loading enhancements. Added: Himalaya email integration, multi-source extraction (PDF/Excel/hyperlinks), RFQ resolution by MPN database lookup (not supplier references), fuzzy MPN matching with progressive trimming, partial data flagging `[PARTIAL - needs: price, qty]`, MPN mismatch notes when quoted MPN differs from RFQ MPN.
- **2026-02-27**: Designed RFQ Sourcing min order value filter. Uses franchise bulk pricing (last column/lowest price) from FindChips. Logic: `est_value = franchise_bulk_price × supplier_qty × multiplier`. Multiplier = 0.2 if franchise_qty >= customer_rfq_qty (abundant), 0.7 if scarce.
- **2026-02-26**: Completed Franchise Screening workflow (`rfq_sourcing/franchise_check/`). Scrapes FindChips for franchise distributor stock/pricing. Filters low-value opportunities before broker sourcing.
