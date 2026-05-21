# Heilind — Operational Notes

Empirical observations about heilind.com's pricing data, captured across two adapters: the **BOM tool bulk upload** (Quick Quote tool — xlsx export, ≥30-MPN batches) and the **per-MPN line-by-line search** (≤30-MPN batches, more autonomous, richer fields). Both feed the same server-side mapper at `mappers/heilind.js`, which auto-detects shape by extension + headers.

| Path | When | Result file shape | Per-MPN row count | Field richness |
|---|---|---|---|---|
| BOM tool xlsx | Daily list > 30 MPNs | `<key>-results.xlsx` | 1 row | MPN, MFR, qty, single-tier price, HTS-Classification (parsed), LeadTime, NCNR, ROHS, DAC PN |
| Line-by-line CSV | Daily list ≤ 30 MPNs | `<key>-results.csv` | 1 row per manufacturing variant | All of above + 8-tier price ladder, raw HTS, COO, Tariff/Surcharge text, DetailLead, Status (EOL flag), HeilindSKU, MatchedMfr |

The line-by-line path is preferred for small batches because (a) per-MPN page hits stay under the ~20 actions/30min Imperva WAF budget at proper pacing, (b) it surfaces multi-variant data the BOM tool collapses into a single row, and (c) the operator can leave it running unattended once authentication is established (no upload-and-wait step). See operator memory `[[feedback_browser_scraping_pacing]]` for pacing context.

---

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

---

## Line-by-line CSV format (per-MPN search path)

When the operator scrapes per-MPN (instead of bulk-uploading to the BOM tool), the desktop ships a `.csv` to `inbox/heilind/` with one row per (MPN × manufacturing variant). The same heilind mapper picks it up — header detection routes it to `buildEnvelopeEntryLineByLine`.

**Column order (verified 2026-05-21 against 27-MPN canary):**

```
MPN, Manufacturer, Qty,
AvailStock,
Qty1, Price1, Qty2, Price2, …, Qty8, Price8,    ← 8 price-break tiers; blank-out unused
LeadTime, Min, Mult, NCNR, ROHS,
HeilindSKU,                                       ← Heilind's internal SKU (was "DAC PN" in xlsx)
COO,                                              ← ISO-2 country code (CN, PH, TW, MY, …); blank if Heilind didn't surface
HTS,                                              ← Raw digit string (was embedded in "HTS Classification" in xlsx)
TariffSurcharge,                                  ← Free-text note ("Sect 122 Tariff/Surc at 9%", "CHN Tariff/Surcharge at 33.7%", etc.)
DetailLead,                                       ← Granular lead time ("365 Days", "30 Days") — finer than the LeadTime "53 Weeks" / "7 Weeks" bucket
Status,                                           ← Lifecycle ("", "End of Life YYYY-MM-DD", possibly other)
QuoteNumber,
MatchedMfr                                        ← Heilind's resolved MFR canonical (was "Manufacturer_1" in xlsx)
```

**Multi-variant rows.** When Heilind has multiple manufacturing origins for a single MPN (e.g., 1888247-1 made in PH at one supplier, in CN at another), the CSV emits one row per variant with different `HeilindSKU` suffixes (`AMP1888247-1` vs `AMP1888247-1.P`). Each variant has its own COO + Tariff + LeadTime. The mapper writes a separate VQ envelope per variant; the VQ writer's natural key `(RFQ_Line, MPN, BPartner, Cost, Currency, DateCode)` deduplicates only when costs match across variants (rare since different origins typically have different tariff-included pricing).

**EOL signal.** A non-blank `Status` field starting with `End of Life` flags a part scheduled for discontinuation. The mapper captures the full status string in `vqVendorNotes` (e.g., `Status: End of Life 2024-07-01`) so buyers see it on the VQ line.

**Field mapping summary** (line-by-line CSV → chuboe_vq_line + chuboe_pricing_api_result):

| CSV column | VQ field | Cache (json envelope) | Notes |
|---|---|---|---|
| HTS | `chuboe_hts` | `vqHts` | Raw digits, truncated to 25 chars |
| COO | `c_country_id` (via `c_country.countrycode` lookup) | `vqCooCountryId` | Defaults to `PD` (PENDING, id 1000001) when blank/unrecognized |
| TariffSurcharge | `vqVendorNotes` (pipe-separated) | inline | Verbatim string from Heilind |
| DetailLead | `vqVendorNotes` | inline | Only appended when it differs from LeadTime |
| Status | `vqVendorNotes` | inline | Only when non-blank |
| HeilindSKU | `vqVendorNotes` (`Heilind PN: <sku>`) | inline | |
| MatchedMfr | `vqVendorNotes` (`Heilind MFR: <name>`) | inline | Only when different from RFQ-side MFR text |
| Qty1/Price1 … Qty8/Price8 | one VQ row at the tier matching RFQ qty | full ladder in `priceBreaks` array | Writer picks via `priceAtQty(rfqQty)` |

**Known limitations (today, surfaced 2026-05-21 canary):**

1. **VQ writer dedup: no PATCH on natural-key match.** If a prior BOM-tool VQ already exists at the same cost tier, the line-by-line write returns the existing vqLineId without updating COO/HTS/notes. Workaround for now: don't run BOM tool for batches the line-by-line path will cover. Long-term: writer should PATCH attribute fields on natural-key match. Roadmap item.
2. **`api-result-writer.js` envelope→Flux converter doesn't surface `vqHts`/`vqCooCountryId`** in the cached pricing envelope (they land as `HTSCode: null` / `CountryOfOrigin: null`). The VQ row itself gets these fields correctly; only the cache representation loses them. Pre-existing — affects the xlsx path too. Fix is a one-line addition to the converter; deferred.
3. **`writeCache` overwrites by `mpn+date`** — when an MPN has multi-variant rows, only the last variant's cache file survives. Per-variant cache differentiation is a separate fix.
