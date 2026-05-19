# Coilcraft Direct — Operational Notes

Per-part-page scrape against coilcraft.com. The desktop visits one product page per MPN and emits canonical envelope entries directly to `~/workspace/inbox/coilcraft/` — Pattern A, no server-side mapper required.

This file is the per-site companion to `desktop-scraper-contract.md`. Read the contract first for envelope shape, scp handoff, and pacing rules; this file covers only the Coilcraft-specific quirks.

## Channel summary

| Field | Value |
|---|---|
| Slug | `coilcraft` |
| Pattern | **A** — per-MPN canonical JSON, no mapper |
| Supplier BP | `c_bpartner.value=1002400`, `c_bpartner_id=1000396` |
| MFR | Coilcraft Inc, `chuboe_mfr_id=1000050` |
| Traceability | Authorized Distribution Certs (`chuboe_traceability_id=1000001`) — Coilcraft IS the manufacturer |
| Edge protection | Cloudflare Managed Challenge (verified 2026-05-19, `cf-mitigated: challenge`) — passes transparently in operator's real Chrome session |
| Login | none required — pricing is published anonymously and is the same for everyone |
| Currency | USD (`currencyId: null`) |
| Restricted MFR gate | `applyRestrictedMfrGate: false` — broker/manual flow |
| Why this channel exists | Coilcraft restricts broker access through their franchise distributors (DigiKey / Mouser / TTI / Future). Buying direct from coilcraft.com is the only viable channel. |

## Scope of this notes file

**In scope:** pricing + stock + lead-time + DC + RoHS + packaging capture for in-flight RFQs and ad-hoc lookups. Read-only.

**Out of scope:** actually placing orders on coilcraft.com. The buy-direct (cart + checkout + shipping + payment) flow is operator-attended on Chrome, not automated. The scraper pre-stages pricing data so the operator can decide quickly; the order itself is hand-driven. If/when we automate ordering, that gets its own notes file and its own workflow.

## Demand sizing (60d baseline, 2026-03-19 → 2026-05-18)

| Metric | Value |
|---|---|
| Distinct RFQs touching Coilcraft demand | 30 |
| Already had a Coilcraft-direct VQ | 4 (13%) |
| Gap — zero Coilcraft-direct sourcing attempt | **26 (87%)** |
| Distinct MPNs quoted | 134 (~2.2/day) |
| Distinct customers | 14 (concentration: Sanmina, JCI, Celestica, Honeywell, GE Aero ≈ 80%) |

At ~2 MPNs/day average and ~5 RFQs/week, a typical day's lookup is comfortably inside one 30-minute pacing window.

## MPN packaging suffix

**Coilcraft MPNs encode the packaging variant in a trailing 1–2 character suffix.** The electrical/value part of the MPN is the same across packaging variants; only the suffix changes.

Examples from production VQs (60d sample):

| MPN as received | Likely electrical base | Suffix |
|---|---|---|
| `0402DC-6N8XGRW` | `0402DC-6N8XGR` | `W` |
| `0402HP-6N8XGRW` | `0402HP-6N8XGR` | `W` |
| `0402DC-3N4XGRW` | `0402DC-3N4XGR` | `W` |
| `MSS5131-682MLC` | `MSS5131-682M` | `LC` |
| `MSS1278T-223MLD` | `MSS1278T-223M` | `LD` |
| `A9967-ALD` | `A9967-A` | `LD` |
| `AGP2923-223KL` | `AGP2923-223K` | `L` |
| `GA3136-BL` | `GA3136-B` | `L` |
| `DO3316P-474ML*` | `DO3316P-474M` | `L` + `*` wildcard |

### Rules for the scraper

1. **`*` is a customer-side wildcard** — it means "any packaging." When an input MPN ends in `*`, search Coilcraft on the electrical base, then capture **every packaging variant** Coilcraft returns. Emit one envelope item per (MPN, packaging) pair — `searchedMpn` retains the `*`, `vqMpn` is the canonical variant Coilcraft returned (no `*`), `vqPackaging` carries the variant label.

2. **Non-`*` suffixed MPNs are specific** — search the exact MPN. If Coilcraft's site canonicalizes (e.g., redirects `…ML` to `…MLC`), capture both: `searchedMpn` = operator input, `vqMpn` = canonical returned. The cross-ref check on the server is what flags genuine mismatches; preserving both is required for that.

3. **Do NOT maintain a static suffix → packaging table.** The encoding varies across product families (chip inductors vs. molded power inductors vs. transformers) and Coilcraft changes it over time. Always read packaging from the site, never infer from the suffix.

4. **Capture the electrical base separately** as `vqVendorNotes` annotation (e.g., `"base: DO3316P-474M"`) when it differs from `vqMpn` — helps the downstream MFR-equivalence + alt-MPN linkage path later.

## Data Coilcraft publishes per product page

Inventoried from manual operator captures + their public PDP layout:

| Field | Source on page | Envelope field |
|---|---|---|
| Full price-break ladder | Pricing table, ascending qty | `priceBreaks[]` — **capture ALL breaks**, not just the one matching RFQ qty |
| Stock on hand | "X in stock, ready to ship today" line | `franchiseQty` (numeric — strip "X" out of the prose) |
| Future availability | "Y more available on MM/DD/YYYY" line | `vqVendorNotes` (free text, prefix `"Future: "`) |
| High-volume lead time | "Up to: N weeks lead time for high volume orders" | `vqLeadTime` (free text, verbatim) |
| Date code / lot | "Current date code" / batch number if shown | `vqDateCode` (verbatim) |
| RoHS / REACH | Compliance badges on PDP | `vqRohs` — `'Y'` if RoHS compliant, `'N'` otherwise |
| Packaging | Reel-size selector / packaging selector | `vqPackaging` (free text — server normalizes via `shared/packaging-lookup`) |
| Description | Part subtitle / page H1 | `vqDescription` |

### Up-tick at the top break (verified)

Coilcraft sometimes prices the largest break **higher** than the second-largest (likely a packaging-cost or factory-order step). Example from JCI RFQ 1132586 (4/28):

```
MSS1278T-223MLD:  $0.73  → $0.72  → $0.5829 → $0.52  → $0.57
                  (2013)  (4163)   (12896)   (24100)  (49900)
```

Capture verbatim. The server's `priceAtQty()` picks the highest break ≤ buy qty, so the up-tick gets applied correctly. Do not "fix" or smooth it.

## Manual-capture baseline (what we're improving on)

Of the 4 RFQs that had Coilcraft-direct VQs in the 60d window (1132204, 1132586, 1133137, 1134822):

| Capture quality | RFQs | Notes |
|---|---|---|
| Single-break, qty = RFQ qty only | 3 of 4 | Lead-time + stock blob shoved into the `chuboe_lead_time` text field |
| Full price ladder (2–5 breaks per MPN) | 1 of 4 | JCI 1132586 — captured deliberately for the CalcuQuote comparison |
| Placeholder MPN ("MPN 123") | 1 of 4 | Flock Safety 1133137 — operator entered test data, not a real Coilcraft quote |

**What the scraper improves:**
- All breaks per MPN (not just one)
- Stock and lead-time as separately-typed fields (not a single blob)
- Date code + RoHS + packaging captured (today: blank everywhere)
- No placeholder noise — every emitted item is a real PDP read

## Pacing

Standard `desktop-scraper-contract.md` § Pacing Rules apply. Coilcraft-specific notes:

- Cloudflare Managed Challenge is **session-based**, not per-request. Once the operator's Chrome has a `cf_clearance` cookie (typical TTL ~30 min), in-session navigation is unblocked.
- If the challenge re-fires mid-run (interstitial reappears, captcha demanded), STOP. Tell the operator. Do not retry through it — that pattern is what gets the IP/account graylisted.
- Navigation chain: home → search bar → results → PDP. Don't jump directly to `/products/<mpn>` URLs.

## Trigger phrases (operator → desktop)

| Operator says | Behavior |
|---|---|
| `lookup MPN <part> on coilcraft` | Single-MPN PDP read. Envelope has no `rfqSearchKey` → market-intel capture only. |
| `lookup MPNs for RFQ <searchKey> on coilcraft` | Operator provides the MPN list (or file). Envelope has `rfqSearchKey` set → server writes VQs against the RFQ. |
| `lookup MPNs for RFQ <searchKey> using coilcraft` (and other slugs) | Multi-adapter run — coilcraft is one channel among several. |

## Server-side path

Pattern A means there is **no `mappers/coilcraft.js`**. The watcher path:

1. `inbox-watcher.js` validates the canonical envelope schema.
2. If `rfqSearchKey` is set → `writeVQBatch(rfqSearchKey, items)` writes VQ lines.
3. If absent → `writePricingResult(...)` per result for market-intel.
4. Writes `done/<date>/coilcraft/<filename>.result.json` and deletes the inbox envelope.

No new server-side code is needed for this channel to go live. The only deliverable is this notes file + (later) a `scrape-adapters/coilcraft.md` cheat sheet on the desktop side covering the search-page selectors.

## Open items

- [ ] Per-family packaging-suffix table — populated empirically from scraper runs, not assumed up-front. Live in this file once we have ≥20 MPNs of evidence.
- [ ] Confirm whether Coilcraft shows ECCN on PDP (most manufacturers don't surface it; if they do, add to envelope mapping).
- [ ] Decide whether high-volume LT prose ("Up to: N weeks") should be parsed into a numeric `vqLeadTime` or kept as the original blob. Default for now: keep as blob.
- [ ] Buy-direct flow — separate notes file when we get to it.
