# coilcraft — Desktop Scrape Adapter Cheat Sheet

**Slug:** `coilcraft`
**Pattern:** A (per-MPN canonical envelope, no server mapper)
**Site:** https://www.coilcraft.com
**Server-side reference:** `Trading Analysis/Distributor Scrape Loading/coilcraft-direct-notes.md` (envelope mapping, packaging-suffix rules, demand sizing, up-tick anomaly). Read that first.

## Auth model

- **No login required.** Coilcraft publishes pricing anonymously and the same price ladder is shown to everyone.
- Edge: **Cloudflare Managed Challenge** (`cf-mitigated: challenge` on a raw HTTP request). The operator's authenticated Chrome session passes the challenge transparently — the `cf_clearance` cookie is set on first interactive visit and lasts ~30 minutes.
- **Do not** drive Playwright in isolation here — it will bounce the challenge. Connect to the operator's Chrome session via the official Claude-in-Chrome extension / `--connect-cdp`, the same way other adapters do.

## Navigation playbook

For each MPN:

1. Land on https://www.coilcraft.com (homepage). Don't deep-link to `/products/<MPN>` 50 times in a row — that reads as scripted.
2. Find and use the **site search bar**. Type the MPN (preserving any trailing `*` wildcard the operator passed).
3. From results, navigate to the canonical **product detail page (PDP)**.
4. On the PDP, capture (see envelope mapping in `coilcraft-direct-notes.md`):
   - All price-break tiers (qty + unit price) — **all** of them, not just the RFQ qty
   - Stock on hand
   - "More available on MM/DD/YYYY" future-availability line (if present)
   - High-volume lead-time prose
   - Date code (if surfaced)
   - RoHS / REACH compliance
   - Packaging variant label
   - Description
5. If the MPN has a `*` wildcard: scrape **every** packaging variant Coilcraft lists, one envelope item per variant.
6. Build one canonical envelope item per (MPN, packaging) pair. Emit via the scp dance documented in `desktop-scraper-contract.md`.

Between MPNs: randomized 3–15 s sleep, scroll/hover for passive activity.

## Selectors and DOM details — TBD

**These must be populated on the first operator-attended session.** Do not invent them from memory.

| Element | Selector | Notes |
|---|---|---|
| Site search input | `TBD` | Capture from homepage on first session |
| Search submit | `TBD` | Likely button or Enter key |
| Search results → first matching part link | `TBD` | |
| PDP price-break table | `TBD` | Header row + rows |
| PDP stock-on-hand element | `TBD` | "X in stock, ready to ship today" |
| PDP future-availability line | `TBD` | "Y more available on MM/DD/YYYY" |
| PDP high-volume LT line | `TBD` | "Up to: N weeks lead time for high volume orders" |
| PDP date code | `TBD` | |
| PDP RoHS badge | `TBD` | |
| PDP packaging selector / table | `TBD` | Coilcraft offers multiple reel sizes / cut tape per part |
| "No matches" / 404 signature | `TBD` | Used to set `found: false` cleanly |

## Stop conditions

- A captcha appears mid-session → STOP. Tell the operator. Do not retry — that pattern is what causes account/IP graylisting.
- The Cloudflare interstitial re-fires → STOP for the same reason.
- A site element you expected (search bar, PDP price table) is missing or changed shape → STOP and tell the operator. Do NOT guess at fallback selectors.

## Out of scope

- **Ordering / cart / checkout.** Pricing capture only. The buy-direct flow is operator-hand-driven on Chrome; if/when it gets automated it gets its own adapter file.
- **Bulk BOM upload.** Coilcraft has no usable BOM tool on the public site — Pattern A is the only path.

## Open items (carry forward to first session)

- [ ] Populate the selector table above.
- [ ] Confirm whether Coilcraft surfaces ECCN on PDP (most manufacturers don't).
- [ ] Capture an empirical per-family packaging-code table (which suffix → which packaging label) — log into `coilcraft-direct-notes.md` after ≥20 MPNs of evidence.
- [ ] Note any per-family PDP layout differences (chip inductors vs. molded power inductors vs. transformers may have distinct templates).
