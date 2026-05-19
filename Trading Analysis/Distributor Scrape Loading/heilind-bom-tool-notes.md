# Heilind BOM Tool — Operational Notes

Empirical observations about heilind.com's Quick Quote BOM tool behavior, collected during desktop-scraper rollout. The mapper at `mappers/heilind.js` parses what this tool emits; these notes explain quirks the mapper has to live with.

## Row capacity

250 MPNs in a single upload processed without error. Hard limit is at least 250 — not yet bracketed from above. Don't assume higher caps without re-testing.

## Settings used by the producer

- **Source columns:** A=MPN, C=Qty
- **Return columns:** D=AvailStock, E=Price1, F=Price2, G=Price3, H=LeadTime, I=Min, J=Mult, K=NCNR, L=ROHS (Heilind PN deliberately skipped — we don't need their internal SKU)
- **Multi MFG/Package:** `EXPORT ALL AVAILABLE MFG/PACKAGE VARIATIONS ON MY QUOTES` — surfaces all manufacturer variations the tool can resolve

## The "matched but no price" signature (2026-05-18 baseline)

On a 250-MPN test run:

| Outcome | Count |
|---|---|
| Matched a Heilind catalog part (got a DAC PN) | 77 |
| Matched **and** got real pricing | 39 |
| Matched but `Price1 = 0` | 38 |
| Did not match at all | 178 |
| Total result rows | 255 (5 extra from variation expansion) |

The 38 `matched-but-no-price` rows have a stable signature:

| Field | Priced rows | Unpriced rows |
|---|---|---|
| Min | real values (10, 1000, 2000, 25, 160…) | almost all `1` (default) |
| Mult | real values (10, 1000, 2000, 60…) | almost all `1` (default) |
| Factory stock | varies | `0` |
| Future availability | varies | `0` |

The `Min=1, Mult=1, Stock=0, Future=0` signature looks like: quote engine identified the part in the catalog but had no live stock/pricing to attach.

**Likely causes** (any combination):
1. No customer-contract pricing on file for that Heilind PN under the Astute account.
2. Non-stocked / factory-order parts the quote engine skips for pricing.
3. Variation routing — 4 MPNs were exported to 2–3 rows each; priced data may have landed on a sibling variant row.

## False-negative rate (manual spot check)

Manually checked a handful of the 38 unpriced rows on heilind.com directly:
- 1 returned pricing manually that the BOM tool reported as `Price1=0` (`SMFLP3.0` / Bivar).
- All others correctly showed no pricing on the site.

Conclusion: low false-negative rate (~1 in a small handful). Probably edge-case behavior in the pricing-lookup path for certain MFRs (Bivar here), not a systemic gap. Not worth a re-scrape pass at current volumes.

## What the mapper does with these classes

| Class | What the mapper writes |
|---|---|
| Matched + priced (`DAC PN` set, `Price1 > 0`) | VQ row via `writeVQBatch`, negative-cache `state='priced'` |
| Matched + no price (`DAC PN` set, `Price1 = 0`) | No VQ. Negative-cache `state='matched_no_price'` |
| Not matched (`DAC PN` blank) | No VQ. Negative-cache `state='not_carried'` |

The negative cache prevents the next day's producer from re-scraping the same MPN at a comparable qty (±25% window).
