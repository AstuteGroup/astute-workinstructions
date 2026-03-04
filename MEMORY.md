# MEMORY

## Terminology

- **OT (Orange Tsunami)** — Internal name for our system built on top of iDempiere

## Recent Sessions

- **2026-03-04 (Two-Agent VQ Extraction Process)**: Discovered 22% fabrication rate in manual extraction (8/37 records had non-existent email IDs, plus data errors). Implemented two-agent extract+verify workflow: Agent A extracts with source quotes, Agent B independently verifies against actual emails. Ran on 40 emails: 25 verified records (100% accuracy), 6 skipped (no-bids/dupes), 9 needs review (PDFs). Zero discrepancies, zero fabrications. Output: `verified-extractions-batch1.json/csv`. Vendor matching improved: email → vendor name → isvendor=Y filter.
- **2026-03-04 (VQ Manual Extraction + Workflow Update)**: Abandoned rigid parser entirely - produces garbage data. New workflow: templates only + manual extraction in Claude session. Extracted 38 records manually from 241 body-only emails (~45 unique, many duplicates). Fixed Akira template to recognize `TOTAL QTY:` pattern. Created `vendor-formats.json` to track observed quote formats for future template development. Updated CLAUDE.md with "NO SCRIPTS" philosophy - extraction must be templates or manual Claude, never regex scripts. RFQ window updated to 30-day primary / 60-day fallback.
- **2026-03-04 (Quick Quote Documentation)**: Created `quick-quote.md` documenting the pricing workflow: floor price (15% min margin or $250 GP), suggested resale hierarchy (same-cust PPV → shortage → losing CQ → other-cust midpoint → target/30% margin), confidence tiers, date code filtering, and output format.
- **2026-03-04 (PDF Review Queue + Template Engine)**: Built hybrid VQ parsing system: template engine for known vendors (chip1, velocity, j2-sourcing, semitech, akira-global), rigid parser fallback, PDF review queue for manual extraction. No-bid detection added to ALL emails (qty=0, price=0, reason in notes). PDF workflow: regex tries first, low-confidence (<0.7) PDFs queued for manual Claude session extraction.
