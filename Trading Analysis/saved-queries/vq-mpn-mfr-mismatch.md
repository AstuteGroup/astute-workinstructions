# VQ vs RFQ AVL mismatch scan

Find VQs (`chuboe_vq_line`) whose MPN or MFR doesn't match any AVL entry on
the linked RFQ line (`chuboe_rfq_line_mpn`). Triage tool for operator
concerns like "we're seeing VQs loaded for parts that aren't on the RFQ."

## Usage

```bash
psql -f Trading\ Analysis/saved-queries/vq-mpn-mfr-mismatch.sql

# Scope to a specific RFQ
psql -f vq-mpn-mfr-mismatch.sql -v rfq_value=1132320

# Narrow time window
psql -f vq-mpn-mfr-mismatch.sql -v since='2026-04-01'
```

## Output flags (most suspicious first)

| Flag | Meaning |
|---|---|
| `BOTH_MISMATCH` | Neither MPN nor MFR match. High suspicion — investigate first. |
| `MPN_MISMATCH` | MPN not in AVL (even as prefix variant). Usually: broker cross-reference alternate, speed/temp grade variant, or RFQ-side data issue. |
| `MFR_MISMATCH` | MPN matches but MFR doesn't. Usually: alias needs resolving (e.g., `Murata` vs `Murata Electronics NA Inc`), or RFQ has a distributor name in its MFR column instead of the real MFR. |
| `MPN_VARIANT` | MPN is a packaging-suffix variant of an AVL MPN (`LM358N` ↔ `LM358N/NOPB`). Typically legit. |

## Known noise (explains why counts are high)

**MFR_MISMATCH is noisy at the SQL layer** because:
1. **Alias resolution isn't applied.** `shared/mfr-equivalence.js` handles `TI`/`Texas Instruments`, `Murata`/`Murata Electronics NA Inc`, acquisitions like `Linear`→`ADI`, etc. The SQL only does alphanumeric normalization. To get a true MFR-mismatch count, export the flagged rows and run each through `computeMfrMatch(rfqMfr, vqMfr)` in Node.
2. **Dirty RFQ data.** Some RFQs were loaded with distributor names in the `chuboe_mfr_text` field (`MOUSER ELECTRONICS INC`, `FUTURE ELECTRONICS CORP`, etc.) where the real manufacturer should be. The VQ then "mismatches" against the distributor name even though the VQ has the correct MFR.

**MPN_MISMATCH is mostly legit alternates:**
- Stock RFQs get cross-reference alternates from brokers (`LL4148` RFQ → brokers quote `PMLL4148`, `FDLL4148`)
- Speed/temp grade substitutions (`EP2AGX95EF35C4N` → `EP2AGX95EF35C5N`)
- Vendor lot-prefix decoration (`DMP2021UFDF-7` → `EONGDMP2021UFDF-7`)

**BOTH_MISMATCH is the rare, high-signal bucket** — worth triaging every one.

## Historical context

Pre-2026-04-14, all 10 distributor parsers had a wrong-match fallback that
surfaced "you might also like" recommendations as if they were the searched
part (see `shared/mpn-match.js` docstring and the roadmap RESOLVED entry).
That bug couldn't leak to `Chuboe_MPN` on the VQ (`vq-writer.js:595` writes
`opts.searchedMpn || mpn` — the RFQ MPN, not the distributor's returned MPN)
but it COULD leak to `Chuboe_MFR_Text` (`vq-writer.js:596` uses the
distributor's returned MFR). Any MFR-mismatch flags from pre-2026-04-14 VQs
may be parser-bug residue — but the aliases + dirty-RFQ noise dominates, so
SQL results alone aren't diagnostic.

## Recommended workflow

1. Run scoped to a specific RFQ the buyer flagged
2. Focus on `BOTH_MISMATCH` rows first — these are the highest-signal
3. For `MFR_MISMATCH` rows: export, pipe through `shared/mfr-equivalence.js`
   in Node to dedupe alias/acquisition noise, review what's left
4. For `MPN_MISMATCH` rows: most are legit broker alternates on Stock RFQs;
   eyeball the `avl_mpns` column to confirm the VQ MPN is a known alternate
