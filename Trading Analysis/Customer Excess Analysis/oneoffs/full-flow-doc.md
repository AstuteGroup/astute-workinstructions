# Customer Excess — Full Pipeline Work Instructions

**Generated 2026-05-07.** Covers every branch from inbox arrival to operator action and back. 8 cogs, 4 folders, 5 routing outcomes, 3 analysis intents.

---

## High-level architecture

```
┌────────────────┐
│  excess@ inbox │ ← seller forwards "FW: ..." emails here every 30 min
└────────┬───────┘
         │
         ▼
┌────────────────────────────────┐
│  Cog 1: shared/offer-poller.js │  Lockfile-guarded; runs from cron
└────────┬───────────────────────┘
         │
         ▼  (every UNSEEN message)
   ┌─────────────┐
   │ junk-class. │ ← Cog 2
   └──┬───────┬──┘
      │       │
   high-conf  low-conf / likely-offer
      │           │
      ▼           ▼
  /NotOffer   partner resolution + line extraction
                  │
                  ▼
            writeOffer() → chuboe_offer + lines + line_mpn
                  │
                  ▼
   ┌──────────────────────────────────┐
   │  Cog 3: shared/offer-router.js   │
   └──┬─────┬─────────┬───────────────┘
      │     │         │
   1000000 1000001 1000002          (offer type)
   1000003
      │     │         │
      ▼     ▼         ▼
   Cog 4 Cog 5     Cog 6
   excess broker   franchise
   analysis  capture  capture (both = breadcrumb only)
      │
      ▼
   breadcrumbs.jsonl
      │
      ▼
   ┌─────────────────────────┐
   │ Cog 7: digest-builder   │ runs 11/16/20 UTC; emails Jake
   └────────┬────────────────┘
            │
            ▼
        operator
            │
            ▼  (reply with directives)
   ┌─────────────────────────┐
   │ Cog 8: reply-parser     │ feeds back into pipeline
   └─────────────────────────┘
```

---

## Cog 1 — `shared/offer-poller.js` (intake)

**Cron:** every 30 min, lockfile at `/tmp/offer-poller-excess.lock` prevents overlap. **Inbox:** `excess@orangetsunami.com`. Iterates UNSEEN messages.

For **each message**, the poller follows this branch tree. Numbered branches are mutually exclusive within a level.

### 1.1 Operator-override check (if any)

The poller first asks `feedback-overrides.json` whether this UID has an active operator directive (set by reply-parser):

| Override type | Effect |
|---|---|
| `forceProcess(uid)` | Skip the junk-classifier — operator said this *is* an offer |
| `partner(uid, bpId)` | Skip partner resolution — use this BP directly |
| `lines(uid, lines[])` | Skip line extraction — use these operator-pasted lines |

Each consumed override writes a breadcrumb (`forceProcess-applied`, `partner-override-applied`, `lines-override-applied`).

### 1.2 Junk classification (`shared/junk-classifier.js`) — Cog 2

Skipped if `forceProcess` override is active. Otherwise three outcomes:

| Tier | Condition | Action |
|---|---|---|
| **high-confidence-junk** | Subject matches an HIGH_CONF pattern: out-of-office, auto-reply, undeliverable, delivery-status, mail-failure, read-receipt, newsletter, unsubscribe, **Upload MO_*** ; OR body effectively empty (<30 chars stripped) AND no parseable attachment ; OR body contains SMTP bounce headers (`Reporting-MTA:` / `Final-Recipient:` / `Diagnostic-Code:`) | Move to `/NotOffer`, no operator email, breadcrumb `not-offer` |
| **low-confidence-junk** | No attachment, no MPN-shaped tokens in body, body short (<400 chars after strip-quote) ; OR other ambiguous signals | Move to `/NeedsReview`, send operator a **single yes/no email** ("Junk check — UID N: ..."), wait for `YES`/`NO` reply via reply-parser |
| **likely-offer** | Default | Continue to partner resolution |

### 1.3 Partner resolution

Driven by `resolvePartnerForMessage({ outerFrom, body, subject })`. Resolution order:

#### 1.3.1 Subject hint (highest priority — added 2026-05-07)

`extractBpHintFromSubject(subject)` matches three patterns case-insensitively:

| Pattern | Example | Captures |
|---|---|---|
| `Search\s*Key\s*[#:=\s]\s*(\d{6,8})` | `FW: Matrix comsec - Search key#1009991` | 1009991 |
| `MO[_\s-]+(\d{6,8})` | `FW: Upload MO_1002733`, `FW: Upload MO_Search Key 1008289` | 1002733 / 1008289 |
| `\[#\s*(\d{6,8})\s*\]` | `FW: <whatever> [#1234567]` | 1234567 |

If matched → `lookupById(searchKey)` → if BP exists & not employee → **DONE** (partner.tier=0 `bp_hint`).

#### 1.3.2 Body hint

`extractBpHintFromBody(body)` matches `(BP|Partner|Vendor|BPartner ID|BP ID)\s*[:#=]\s*(\d{6,8})` → `lookupById` same path.

#### 1.3.3 Forward-chain From-line resolution

If `outerFrom` is `@astutegroup.com` (internal forward): `parseForwardedHeaders(body)` walks **every** `From:` line in the body and prefers the **deepest non-`@astutegroup.com`** sender. This avoids latching onto the prior internal hop on multi-hop chains (the bug from 2026-05-07).

The deepest non-Astute sender's email is fed into `resolvePartner()` — see 1.3.5.

If no non-Astute From: line found, falls through to company-name match (also from `parseForwardedHeaders`).

#### 1.3.4 Outer-sender resolution (external direct send)

If `outerFrom` is NOT internal (a real customer emails `excess@` directly), `resolvePartner({ email: outerFrom })`.

#### 1.3.5 `resolvePartner()` 4-tier resolver in `shared/partner-lookup.js`

All 4 tiers exclude `IsEmployee='Y'` BPs (added 2026-05-07 to fix Edgar Santana / Aaron Mendoza misattribution):

| Tier | Method | What it does |
|---|---|---|
| **1.0** | `lookupByEmail` | Exact email match in `ad_user.email`. Handles `USE NNNN` redirect names. |
| **1.5** | `lookupByEmailDomain` | Same domain. Multi-BP tiebreaker: prefer BP whose name contains domain stem; then BP with most contacts at that domain; then most recent. |
| **2.0** | `lookupByDomainHint` | Strip generic prefixes (sales-, info-, rfq-, purchasing-, etc.); iteratively peel suffixes (-electronics, -corp, -ltd, etc.); LIKE search on BP name. Primary hints use contains, derived hints use starts-with. |
| **3.0** | `lookupByName` | Name-based fuzzy match from email signature `companyName`. Rejects generic role words (sales, info, support, etc.). |

Returns `{ matched, c_bpartner_id, name, search_key, iscustomer, isvendor, tier, tierName, source }`.

#### 1.3.6 Resolution outcomes

| Outcome | Action |
|---|---|
| Match found at any tier | Continue to line extraction |
| `matched: false` | Move to `/NeedsPartner` folder, send operator email "NeedsPartner: <subject>" with `Reply with PARTNER: <uid> = <BP id or company name>`. Breadcrumb `needs-partner`. STOP for this message. |

### 1.4 Line extraction (`extractFromAttachmentsOrBody`)

Skipped if `lines` override active. Otherwise tries each path in order; first non-empty wins:

| Order | Method | When |
|---|---|---|
| 1 | `extractLinesFromXlsx` | Any `.xlsx` / `.xls` / `.xlsm` attachment. Walks first 10 header rows of every sheet looking for an MPN column. |
| 2 | `extractLinesFromCsv` | `.csv` attachment via `shared/csv-utils.js` (no naive `split(',')`). |
| 3 | `extractLinesFromPdf` | `.pdf` attachment via `shared/pdf-extract.js`. Confidence-gated; throws below threshold → tries next path. |
| 4 | `extractLinesFromHtml` | If `parsed.html` present. Stack-based parser walks `<table>` blocks (handles nested Outlook signature tables). For each table runs `matchHeaders` against the first row; uses tables that have an MPN column. |
| 5 | `extractLinesFromBody` | Plaintext fallback. Tab- or pipe-delimited rows. |

Header detection: `matchHeaders()` recognizes synonyms for **mpn** (mpn / part number / mfr part / aml / p/n …), **qty**, **price**, **mfr**, **dateCode**, **description**, **cpc**. In-order resolution prevents double-claims (e.g., "mfr part" claimed by mpn only, not also by mfr).

#### 1.4.1 `filterRealMpns()` post-filter (added 2026-05-07)

After every extraction path, `looksLikeMpn(s)` rejects:

- Empty / 1-char strings; >100 chars
- URL fragments: `<HTTPS://...>`, `^HTTPS?://`, `^WWW\.`
- Anchor-tag fragments: `<\s*\/?\s*A\s+`
- Strings with no alphanumerics

If 0 lines survive, the result is treated as no-lines-found.

#### 1.4.2 Outcomes

| Outcome | Action |
|---|---|
| ≥1 line extracted | Continue to offer-type determination |
| 0 lines | Move to `/NeedsReview`, send operator email "NeedsReview — no lines: <subject>", breadcrumb `needs-review`/`no-lines`. STOP. |

### 1.5 Offer-type determination

| Step | Logic |
|---|---|
| 1 | `extractOfferTypeHint(body)` — explicit body hint `Type: Customer Excess` / `Type: Broker Stock Offer` / etc. takes priority |
| 2 | Otherwise `config.defaultOfferType` (for `excess@` = `Customer Excess`) |
| 3 | **Heuristic flip (added 2026-05-07):** if type is Customer Excess AND `partner.iscustomer === 'N'` AND `partner.isvendor === 'Y'` → flip to **Broker Stock Offer**. Breadcrumb `offer-type-flipped`. |

Resolves to one of: `Customer Excess` (1000000), `Broker Stock Offer` (1000001), `Franchise Offers` (1000002), `Customer Lead Time Buy` (1000003).

### 1.6 Cross-forward dedup (added 2026-05-07)

Pre-write check via psql:

```sql
SELECT value, chuboe_offer_id FROM adempiere.chuboe_offer
WHERE isactive='Y'
  AND c_bpartner_id = <resolved BP>
  AND chuboe_offer_type_id = <resolved type id>
  AND created >= NOW() - INTERVAL '6 hours'
  AND (count active lines on this offer) = <extracted line count>
  AND EXISTS (line with chuboe_mpn = <sorted first MPN>)
  AND EXISTS (line with chuboe_mpn = <sorted last MPN>)
LIMIT 1
```

If a match is found, the poller treats the new email as a duplicate forward (e.g., Aaron forwarded then Gopalakrishnan re-forwarded the same source). Action:

- Breadcrumb `dup-skipped` with `existingOfferSearchKey`
- Move email to `/Processed` (it was processed correctly the first time)
- STOP — do NOT writeOffer

### 1.7 writeOffer

Calls `shared/offer-writeback.js` `writeOffer()`:

```javascript
{
  bpartnerId:  partner.c_bpartner_id,
  offerTypeId: <resolved type>,
  description: '<YYYY.MM.DD>-<partnerSlug>-<account>Poller',
  writeMpnRecords: true,
  lines: extracted.lines,
}
```

Internally:
1. POST `chuboe_offer` header → server assigns ID + searchKey
2. For each line: resolve MFR via `shared/mfr-lookup.js` (alias → cache → DB → fuzzy → passthrough), POST `chuboe_offer_line` (line numbers 10, 20, 30...)
3. If `writeMpnRecords=true`: POST `chuboe_offer_line_mpn` per line (AVL alternates substrate)

Returns `{ offerId, searchKey, linesWritten, mpnsWritten, errors }`.

#### iDempiere constraints (silent destroyers — see `Market Offer Loading/market-offer-loading.md` for full reference)

- **CPC bean-callout collapse** — POSTing 2 lines with same `(offer_id, chuboe_cpc)` comma-merges MPN onto survivor + deactivates duplicate. POST returns 200, callout fires after. Loader uses per-CPC anchor pattern OR sub-row alternates.
- **`Chuboe_CPC` non-updateable** on PATCH — must set at POST time only.
- **System-level MFRs** (`AD_Client_ID=0`) reject `Chuboe_MFR_ID` writes → loader sets only `Chuboe_MFR_Text` for those.
- **`C_BPartner_ID` non-updateable** on `chuboe_offer` (discovered 2026-05-07 during cleanup) — to fix wrong BP, must deactivate + write fresh.

### 1.8 Outcomes after writeOffer

| Outcome | Action |
|---|---|
| `errors.length === 0` AND `linesWritten === lines.length` | Move email to `/Processed`, breadcrumb `loaded`, dispatch to offer-router (Cog 3) |
| Partial write or any errors | Move email to `/NeedsReview`, breadcrumb `loaded-with-errors`, dispatch anyway (offer is in OT, just incomplete) |
| writeOffer threw | Move to `/NeedsReview`, breadcrumb `write-failed`, send operator email |

---

## Cog 3 — `shared/offer-router.js` (type dispatch)

Invoked synchronously by Cog 1 after a successful write. Routes by `chuboe_offer_type_id`:

| Type ID | Type Name | Handler |
|---|---|---|
| 1000000 | Customer Excess | Cog 4 — `customer-excess-analysis` |
| 1000001 | Broker Stock Offer | Cog 5 — `broker-data-capture` (breadcrumb only) |
| 1000002 | Franchise Offers | Cog 6 — `franchise-data-capture` (breadcrumb only) |
| 1000003 | Customer Lead Time Buy | Cog 4 — `customer-excess-analysis` |
| anything else | — | breadcrumb `unrouted` (warning); no handler |

Always writes a `routed` breadcrumb first so the digest shows the routing decision even if the downstream cog throws. If downstream throws, breadcrumb `downstream-failed` + re-throw.

---

## Cog 4 — `analyze-offer.js` (Customer Excess Analysis)

**Status:** V1 stub. Currently writes a `queued` breadcrumb only; the real intent classifier + scoring engine + renderers haven't shipped.

**Manual replay path:**
```bash
node analyze-offer.js --offer-id 9000123
node analyze-offer.js --offer-search-key 1024645
```

**Planned (per `customer-excess-analysis.md`):**

### Step 2: Intent classifier (rules-based)

| Rule (first match wins) | Signal | → Intent |
|---|---|---|
| 1 | `--intent` override | use override |
| 2 | Offer type = LAM Kitting Inventory (1000025) | Consignment |
| 3 | Description contains "rev share" / "E&O" / "buyback" | Consignment |
| 4 | Existing OEM/EMS customer + 50+ lines + ≥30% null prices | Consignment |
| 5 | Known broker BP + 5+ lines | Spec Buy |
| 6 | Default | Reactive |

### Step 3a: Supply enrichment (franchise APIs)

`searchAllDistributors(mpn, qty)` across all 7 franchise APIs. Three-state coverage model:

| State | Condition | Meaning |
|---|---|---|
| **IN_STOCK** | distributorsWithStock > 0 | Standard "available" line |
| **FRANCHISE_OUT_OF_STOCK** | carrying > 0, with-stock = 0 | Real scarcity opportunity |
| **NO_LISTING_INTERNAL** | No franchise listing AND MPN looks customer-internal (REV markers, parens, CPC populated) | Push back — customer should resolve their own internal codes |
| **NO_LISTING_MILSPEC** | No franchise listing AND mil-spec pattern (5962-, JANTX, M-prefix) | Obscure but legitimate; needs broker channel |
| **NO_LISTING_UNKNOWN** | No franchise listing, no clear sub-pattern | Catch-all; research case-by-case |

14-day cache freshness via `extractPriceAtQty()`. Always `writePricingResult()` after live API call.

### Step 3b: Demand enrichment (OT history)

Always uses bulk `getBulkMarketData(mpns[])` from `shared/market-data.js` — ~1000× faster than per-MPN. Returns `{ vqCount, brokerSaleCount, customerSaleCount, activeRfqCount, historicalRfqCount, demandStrength, topBuyers }` per MPN. Broker sales count separately from customer sales (per `feedback_suggested_resale.md`).

### Step 4: Scoring

| Category | Weight | Range |
|---|---|---|
| Supply Scarcity | 40% | 0-40 |
| Price Advantage | 35% | 0-35 |
| Demand Signal | 25% | 0-25 |

**Tier:** HOT (70+) / WARM (40-69) / COOL (20-39) / SKIP (<20). Lines in `NO_LISTING_*` get supplyScore=null (sort to bottom) — don't score insufficient-data lines.

### Step 5: Render output (3 shapes)

| Intent | Output shape |
|---|---|
| **Reactive** | Per-line scored list + matching open RFQs/CQs + viability filter (suppress SKIP). Annotate `PROACTIVE PUSH` for SO history without open RFQ. |
| **Spec Buy** | Ranked buy list, `Close First?` flag (existing RFQ/CQ), Est. Resale (20-30% of franchise best), Est. Margin. |
| **Consignment** | Lot-level portfolio summary (% HOT, % scarce, % commodity, top 10) + per-line drill-down. Pursuit signal: 40%+ scarce → aggressive, 20-40% → cherry-pick, <20% → pass. |

### Flags

`FRANCHISE_OUT_OF_STOCK`, `NO_LISTING_INTERNAL`, `NO_LISTING_MILSPEC`, `NO_LISTING_UNKNOWN`, `VERIFY` (offer < 5% of franchise), `NEEDS PRICING DATA`, `NO OFFER PRICE`, `PROACTIVE PUSH`, `CLOSE FIRST`, `EXPIRED`, `PRICE CHECK?`.

---

## Cogs 5 & 6 — Broker / Franchise data-capture (V1)

Both are inline in `offer-router.js` — they write a `captured` breadcrumb noting "data-capture only; no analysis or downstream action" and return. The offer sits in OT under the right type for future analysis or manual review; no automated enrichment.

This is intentional — broker stock and franchise offers are reference data, not actionable opportunities for our trading flow.

---

## Cog 7 — `digest-builder.js` (operator digest)

**Cron schedule:** 11:00 / 16:00 / 20:00 UTC = 7am / 12pm / 4pm EDT (DST drift acceptable).

**Empty-window behavior:** Still sends a one-line "no activity" digest so silence is never ambiguous.

**Window:** Configurable via `--since-hours`; defaults to "since last digest" tracked at `~/workspace/.offer-pipeline/last-digest.json`.

**Email structure (4 sections):**

| Section | Content |
|---|---|
| 1. **What got written** | Every offer loaded since last digest — partner, type, line count, search key, source |
| 2. **Which path + why** | offer-router decisions — type → route + the rule that fired |
| 3. **Drill-down candidates** | V1 placeholder; fills when Cog 4 ships scoring (HOT/WARM lines) |
| 4. **Exceptions** | NeedsReview, NeedsPartner, write-failed, partial, unrouted, dup-skipped |

**Sender:** `excess@orangetsunami.com` with fallback to `stockRFQ@orangetsunami.com` (per `shared/verified-send.js`) — accommodates the 2026-04-18 sender-block on vortex@.

**Recipient:** Defaults to `jake.harris@astutegroup.com`; override via `OPERATOR_EMAIL` env var.

---

## Cog 8 — `reply-parser.js` (operator → pipeline feedback)

**Cron:** every 5-15 min (registered separately from poller). **Inbox:** scans `excess@` for UNSEEN messages from `@astutegroup.com` only.

### Directive grammar (one per line, case-insensitive)

| Directive | Pattern | Effect |
|---|---|---|
| `PARTNER: <uid> = <BP id (6-8 digits) OR company name>` | `^PARTNER:\s*(\d+)\s*=\s*(.+)$` | Resolves NeedsPartner — moves UID back to INBOX as Unseen so poller re-attempts with `partner` override |
| `INTENT: <searchKey> = <spec-buy\|proactive\|reactive>` | `^INTENT:\s*(\S+)\s*=\s*...` | Notes for Cog 4 (V1: breadcrumb only) |
| `SKIP: <searchKey>` | `^SKIP:\s*(\S+)$` | Excludes offer from drill-down (V1: breadcrumb only) |
| `IGNORE: <uid>` / `JUNK: <uid>` | `^(?:IGNORE\|JUNK):\s*(\d+)$` | Hard-junks a UID — moves to NotOffer |
| `YES` / `YES: <uid>` | `^YES(?::\s*(\d+))?$` | Confirms a junk-check question (UID from subject if not in body) |
| `NO` / `NO: <uid>` | `^NO(?::\s*(\d+))?$` | Rejects junk-check — sets `forceProcess` override; poller re-attempts |
| `LINES: <uid>` followed by table data | `^LINES:\s*(\d+)$` then tabular block | Operator-pasted lines; sets `lines` override |

### Handling junk-check replies

The junk-classifier sends questions with subject `Junk check — UID <n>: ...`. When the operator replies `Re: Junk check — UID <n>: ...`, the parser extracts the UID from the subject so the operator can just type `YES`/`NO` without re-entering it.

### Unparseable replies

Anything from `@astutegroup.com` that contains content but matches no directive grammar gets a clarification reply: "I couldn't parse your reply. Did you mean X or Y?" with the directive grammar inline.

---

## Folder routing summary

| Folder | When messages land here | Recovery path |
|---|---|---|
| `INBOX` | New unread messages | Poller picks up next tick |
| `Processed` | Successful writeOffer + dispatch | Terminal — kept for audit |
| `NotOffer` | High-conf junk OR explicit `IGNORE:` directive OR confirmed junk-check | Terminal — operator can manually move back if wrong |
| `NeedsPartner` | Partner unresolved | Operator replies `PARTNER: <uid> = <BP>` → reply-parser moves UID back to INBOX |
| `NeedsReview` | 0 lines extracted, partial write, write-failed, low-conf junk awaiting confirm, missing/ambiguous data | Operator replies with `LINES:`, `YES`/`NO`, or manually corrects + re-forwards |

---

## Seller forwarding contract (READ THIS — critical)

**For sellers forwarding customer excess to `excess@orangetsunami.com`:**

### Use the subject line to specify the BP

The poller reads the subject for the OT search key. Recognized patterns:

| Subject contains | Resolves to |
|---|---|
| `MO_<NNNNN>` | BP search key NNNNN |
| `Search Key <NNNNN>` | BP search key NNNNN |
| `Search key#<NNNNN>` | BP search key NNNNN |
| `[#<NNNNN>]` | BP search key NNNNN |

**This means you do NOT need to clean up the email body or remove your own signature** — the subject hint takes precedence over forward-chain From-line walking.

### If you don't include a subject hint

The poller walks the body for `From:` headers and prefers the deepest **non-`@astutegroup.com`** sender as the customer. This works on most multi-hop forwards (customer → emp1 → emp2 → excess@) but if your chain is unusual, the poller may end up at NeedsPartner — you'll get an operator email, reply `PARTNER: <uid> = <BP id>` to fix.

### Don't forward "Upload MO_*" confirmation emails to excess@

These are seller upload notifications — they have no offer data. The junk-classifier auto-routes them to `/NotOffer`. If you actually need to load a real offer with a similar subject, change the prefix.

### Vendor-only BPs flip to Broker Stock Offer

If your forwarded "excess" email resolves to a vendor-only BP (e.g., Future Electronics' "Daily Liquidation List"), the poller **automatically flips** the offer type from Customer Excess to Broker Stock Offer. Override with body hint `Type: Broker` or `Type: Customer Excess`.

### Same email forwarded twice = silent skip

If two employees forward the same email within 6 hours (matched by BP + offer-type + line count + first/last MPN), the second one is auto-skipped with a breadcrumb. No duplicate offer in OT.

---

## Failure modes and recovery

| Failure | Symptom | Recovery |
|---|---|---|
| Poller crashed mid-run | Lockfile stale, next cron silently skips | Investigate logs; remove stale lockfile if process truly dead |
| `IsEmployee='Y'` BP misattribution (pre-2026-05-07) | Offer landed on Aaron Mendoza / Edgar Santana / etc. | **Fixed** — `partner-lookup.js:111` now filters employees on all 4 tiers |
| Multi-hop forward grabbed prior internal hop (pre-2026-05-07) | Same as above | **Fixed** — `parseForwardedHeaders` walks all From: lines, prefers deepest non-Astute |
| Subject search-key ignored (pre-2026-05-07) | Forwarded with `Upload MO_NNNNN` subject still landed on forwarding employee | **Fixed** — `extractBpHintFromSubject` recognizes the patterns |
| Footer-link extracted as MPN (pre-2026-05-07) | Email signature parsed → `FRANCHISED BRANDS<HTTPS://...>` written as MPN | **Fixed** — `looksLikeMpn` rejects URL fragments |
| Cross-forward dup written (pre-2026-05-07) | Same source email forwarded twice → 2 identical offers | **Fixed** — pre-write dedup query |
| Broker liquidation typed as Customer Excess (pre-2026-05-07) | Future Electronics offer wrong type | **Fixed** — vendor-only BP → Broker Stock Offer flip |
| 0 lines extracted | Move to /NeedsReview, operator email | Operator replies with `LINES: <uid>` + paste rows |
| Partner unresolved | Move to /NeedsPartner, operator email | Operator replies `PARTNER: <uid> = <BP id>` |
| writeOffer 500 error | Move to /NeedsReview | Investigate (CPC collapse? system MFR? bean callout?) |
| Wrong BP in OT (already written) | Active offer under wrong customer | `C_BPartner_ID` is non-updateable — must deactivate via PATCH `IsActive='N'` and rewrite fresh with correct BP. Use the cleanup script template at `Trading Analysis/Customer Excess Analysis/oneoffs/cleanup-wrong-bp-offers.js` + `rewrite-correct-bp.js` |

---

## Schedule (from `cron-jobs.js`)

| Job | Cadence | Cron | Notes |
|---|---|---|---|
| `offer-poller-excess` | every 30 min | `*/30 * * * *` | Lockfile-guarded |
| `customer-excess-digest` | 3× per day | `0 11,16,20 * * *` | UTC; = 7am/12pm/4pm EDT |
| `customer-excess-reply-parser` | every 10-15 min | varies | Scans for operator directives |

---

## Data model touchpoints

| Table | Role | Key constraints |
|---|---|---|
| `chuboe_offer` | Header — one per source email | C_BPartner_ID **non-updateable** post-POST; chuboe_offer_type_id updateable; IsActive PATCHable |
| `chuboe_offer_line` | One per offer line | CPC bean-callout collapse on `(offer_id, chuboe_cpc)`; `Chuboe_CPC` non-updateable post-POST; MFR resolution mandatory |
| `chuboe_offer_line_mpn` | AVL alternates / cross-references | Not subject to CPC callout — used for multi-MPN-per-CPC patterns |

Search keys (`value`) and primary keys (`chuboe_offer_id`) are **independent** serial sequences — don't confuse them in queries (lesson from 2026-05-07 cleanup).

---

## File map

| File | Role |
|---|---|
| `shared/offer-poller.js` | Cog 1 — intake |
| `shared/junk-classifier.js` | Cog 2 — junk filter |
| `shared/offer-router.js` | Cog 3 — type dispatch |
| `Trading Analysis/Customer Excess Analysis/analyze-offer.js` | Cog 4 — analysis (V1 stub) |
| `Trading Analysis/Customer Excess Analysis/digest-builder.js` | Cog 7 — operator digest |
| `Trading Analysis/Customer Excess Analysis/reply-parser.js` | Cog 8 — feedback loop |
| `shared/partner-lookup.js` | 4-tier BP resolver (used by Cogs 1 + 8) |
| `shared/offer-writeback.js` | `writeOffer()` |
| `shared/feedback-overrides.js` | Per-UID overrides storage |
| `shared/breadcrumbs.js` | JSONL event log at `~/workspace/.offer-pipeline/breadcrumbs.jsonl` |
| `shared/email-fetcher.js` | IMAP / WorkMail wrapper |
| `shared/verified-send.js` | SMTP sender with fallback |
| `Trading Analysis/Customer Excess Analysis/customer-excess-analysis.md` | Authoritative workflow doc |
| `Trading Analysis/Market Offer Loading/market-offer-loading.md` | Companion loading workflow doc |
| `shared/data-model.md` | Schema reference for chuboe_offer chain |
| `shared/api-writeback.md` | REST payload reference |
