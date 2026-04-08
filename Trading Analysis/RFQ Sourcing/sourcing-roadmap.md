# Sourcing Automation Roadmap

Consolidated roadmap for RFQ Sourcing and VQ Processing workflows, organized by process flow.

---

## Process Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SOURCING WORKFLOW                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌───────────┐ │
│  │  Franchise   │───▶│    RFQ       │───▶│     VQ       │───▶│   ERP     │ │
│  │  Screening   │    │   Sourcing   │    │   Processing │    │  Upload   │ │
│  └──────────────┘    └──────────────┘    └──────────────┘    └───────────┘ │
│                                                                              │
│  FindChips check     NetComponents       Email parsing      iDempiere VQ    │
│  Filter low-value    Submit RFQs         Extract quotes     Mass upload     │
│                                                                              │
│     Section A           Section B           Section C         Section D     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Repos:**
- `Trading Analysis/RFQ Sourcing/` — Franchise screening + NetComponents RFQ submission + VQ Loading
- `vq-parser/` (code at ~/workspace/vq-parser/, docs at Trading Analysis/RFQ Sourcing/vq_loading/)

---

## Current State (2026-03-03)

| Metric | Value | Stage |
|--------|-------|-------|
| Franchise screening | Operational | A |
| NetComponents RFQ submission | Operational | B |
| VQ Parse rate | 87% | C |
| VQ Vendor match rate | 96% | C |
| VQ NoBid recovery rate | 83% | C |

---

# Section A: Franchise Screening

| # | Feature | Priority | Status |
|---|---------|----------|--------|
| A1 | Franchise Pricing via API | Later | Planned |
| A2 | Non-API Account Scraping | Later | Planned |

---

## A1. Franchise Pricing via API

**Status:** Planned | **Priority:** Later

**Problem:** Currently scraping FindChips — fragile, rate-limited.

**Solution:**
- Replace with direct API feeds (Octopart, DigiKey, Mouser, Arrow)
- Capture full pricing and availability
- Store for Quick Quote and negotiation

**Target APIs:**
- Octopart API — Aggregated pricing
- DigiKey API — Direct pricing and stock
- Mouser API — Direct pricing and stock
- Arrow API — Direct pricing and stock

---

## A2. Non-API Account Scraping

**Status:** Planned | **Priority:** Later

**Problem:** Some franchise manufacturers where Astute has direct accounts offer web-based price & availability tools but no programmatic API. Currently these require manual lookups.

**Solution:**
- Use Playwright to automate web-based P&A tools
- Submit part numbers + quantities, scrape pricing and availability
- Feed results into franchise screening and Quick Quote workflows

**Target Accounts:**
- **Coilcraft** — `coilcraft.com/en-us/partupload/` (bulk part upload form, returns pricing + availability from US warehouse)

**Implementation Approach:**
1. Build per-manufacturer Playwright scripts in `shared/` or `Trading Analysis/RFQ Sourcing/franchise_check/`
2. Handle auth/session management per account
3. Parse response tables into standardized format (MPN, price breaks, stock qty, lead time)
4. Integrate with `shared/franchise-api.js` as additional data source

**Notes:**
- Fragile by nature — manufacturer site changes can break scrapers
- Rate-limit requests to avoid account issues
- Add new manufacturers here as direct accounts are identified

---

# Section B: RFQ Sourcing / Supplier Selection

| # | Feature | Priority | Status |
|---|---------|----------|--------|
| B1 | Same Part / Same Supplier Cooldown (60 days) | **Now** | ✅ Done |
| B2 | No-Bid Filtering | **Now** | Planned |
| B3 | Supplier Fatigue Tracking | **Next** | Planned |
| B4 | LLM Description Scanning | Later | Planned |
| B5 | Cross-Region Duplicate Detection | Later | Planned |
| B6 | MPN Variant Prioritization | **Now** | ✅ Done |
| B7 | Memory Product Handling | Later | Planned |
| B8 | BrokerBin RFQ Automation | Later | Planned |
| B9 | PartsBase RFQ Automation | Later | Planned |
| B10 | NetComponents Email Update | **High** | Planned |

---

## B1. Supplier Selection Deduplication (Same Part / Same Supplier Cooldown)

**Status:** ✅ Done | **Priority:** Now

**Implementation (2026-03-10):**
- `rfq_history.py` module: `check_cooldown()`, `record_rfq()`, `update_response()`, `get_supplier_rankings()`
- `rfq_history.json` persistent store with supplier stats
- Integrated into `submit_rfqs.py` via `--check-cooldown` flag

**Rule:** Don't request the same MPN from the same supplier within 60 days.

Before sending RFQ to supplier, check:
```
IF (Supplier + MPN) requested within last 60 days → SKIP
```

**Cooldown Windows:**
| Scenario | Window |
|----------|--------|
| Default | 60 days |
| Memory products (DRAM, Flash, SRAM) | 14 days (prices change frequently) |
| Supplier said no-bid | 90 days (longer cooldown) |
| Urgent/override flag | 0 (always send) |

**Secondary Purpose: Template Prioritization**
- `get_supplier_rankings()` returns suppliers sorted by RFQ volume
- Use to identify which suppliers need VQ parser templates
- `supplierStats` tracks: totalRfqs, lastRfqDate, uniqueMpns

**Files:**
- `Trading Analysis/RFQ Sourcing/netcomponents/python/rfq_history.py` - Core module
- `Trading Analysis/RFQ Sourcing/netcomponents/rfq_history.json` - Persistent store

**Integration:**
- NetComponents RFQ submission: `--check-cooldown` flag checks before sending, records after
- VQ Parser: Call `update_response()` when quote/no-bid received
- CLI: `python rfq_history.py rankings` shows template prioritization

---

## B2. No-Bid Filtering

**Status:** Planned | **Priority:** Now

**Problem:** We repeatedly request quotes from suppliers who can't provide certain parts.

**Solution:**
- Before sending RFQ: check no-bid history
- If vendor said "no" to MPN within 90 days → skip or flag
- Quarterly cleanup: expire old no-bids (suppliers restock)

**Depends on:** No-Bid Database (Section D)

---

## B3. Supplier Fatigue Tracking

**Status:** Planned | **Priority:** Next

**Problem:** Some suppliers get frustrated when bombarded with RFQs:
- High RFQ volume, low conversion rate
- Repeated RFQs for parts they rarely quote
- Multiple RFQs for same parts in short timeframe

**Fatigue Scoring — Track per supplier:**
- Total RFQs sent (30/60/90 day windows)
- Response rate (quotes received / RFQs sent)
- Conversion rate (orders / quotes)
- Average response time

**Fatigue Actions:**
| Fatigue Level | Action |
|---------------|--------|
| Low (healthy) | Normal RFQ flow |
| Medium | Reduce frequency, prioritize high-value |
| High | Skip or flag for manual review |
| Blocked | Supplier requested no more RFQs |

**Supplier Preferences:**
- "Chip 1 Exchange" — picky, send only high-value
- "Commodity Components" — limit to 5/week
- "OEM-only suppliers" — skip for resale RFQs

**Cooldown Periods:**
- After no-response: 7-day cooldown
- After no-bid: 14-day cooldown for same MPN
- After complaint: Manual review required

**Data Sources:**
- NetComponents RFQ submission log
- Email responses (via VQ Parser)
- iDempiere PO/SO records

---

## B4. LLM Description Scanning

**Status:** Planned | **Priority:** Later

**Problem:** Some NetComponents suppliers include restrictions in listing descriptions:
- "RFQs for OEM & EMS only. NO Resellers!"
- "Factory sealed only"
- "Min order $500"

**Solution:**
- Quick scan of description field before supplier selection
- LLM-based classification: `restricted`, `warning`, `ok`
- Auto-skip restricted suppliers; flag warnings for review
- Track patterns to build keyword blocklist

**Restrictions to Detect:**
- OEM/EMS only
- No resellers/brokers
- Export restrictions (ITAR, EAR)
- Minimum order requirements
- Payment terms requirements

---

## B5. Cross-Region Duplicate Detection

**Status:** Planned | **Priority:** Later

**Problem:** Same supplier inventory appears in multiple regions (e.g., Silicon Solutions Americas + Silicon Solutions Europe), leading to duplicate RFQs.

**Solution:**
- Detect supplier name patterns across regions
- Match by company name + regional suffix
- When duplicates found: select one region (prefer closest)

**Detection Patterns:**
- `CompanyName` + `Americas` / `Europe` / `Asia`
- `CompanyName Inc` / `CompanyName GmbH` / `CompanyName Ltd`
- Same contact email across regions

---

## B6. MPN Variant Prioritization

**Status:** ✅ Done | **Priority:** Now

**Problem:** NetComponents returns MPN variants that may not be acceptable substitutes:
- Customer requests `NUP2105L`, system sources `NUP2105LT1G`
- The `T1` (tape & reel) is usually fine
- The `G` (RoHS/green) is a **specification change** — may NOT be acceptable

**Current behavior:** All variants treated equally. No prioritization or flagging.

### Suffix Classification

| Category | Suffixes | Risk Level | Notes |
|----------|----------|------------|-------|
| **Packaging** | T&R, TR, T1, TUBE, TRAY, REEL, BULK | Context-dependent | See packaging logic below |
| **RoHS/Compliance** | G, G4, PBF, LF, NOPB, -Z | **Risky** | Lead-free vs leaded — customer may require either |
| **Temperature** | E, I, M, C, -40, -55 | **Risky** | Different operating range |
| **Automotive** | Q, Q1, AEC | **Risky** | AEC-Q100 qualification |
| **Military** | M, /883, JAN | **Risky** | MIL-spec qualification |

### Packaging Logic (Bidirectional)

Packaging acceptability depends on what the customer requested:

| Customer Requests | Supplier Offers | Match Type | Action |
|-------------------|-----------------|------------|--------|
| Base part (no packaging) | T&R variant | SAFE | Accept — T&R almost always OK |
| Base part (no packaging) | Tube/Tray | SAFE | Accept |
| **T&R explicitly** | Tube/Tray | **PACKAGING_MISMATCH** | Flag — harder sell |
| Tube/Tray explicitly | T&R | PACKAGING_REVIEW | May work, but cost/handling different |

### Prioritization Order

When selecting suppliers, rank by MPN match quality:

| Priority | Match Type | Example | Action |
|----------|------------|---------|--------|
| 1 | EXACT | Request `NUP2105L`, offer `NUP2105L` | Always select |
| 2 | PACKAGING_SAFE | Request `NUP2105L`, offer `NUP2105LT1` | Select (T&R OK when not specified) |
| 3 | PACKAGING_MISMATCH | Request `NUP2105LT1`, offer `NUP2105L` | Flag, may skip |
| 4 | COMPLIANCE_VARIANT | Request `NUP2105L`, offer `NUP2105LG` | **Flag for review** — RoHS change |
| 5 | SPEC_VARIANT | Temp range, qualification changes | **Flag for review** |

### Output Columns

Add to batch results Excel:

| Column | Values | Color |
|--------|--------|-------|
| `MPN Match Type` | EXACT, PACKAGING_SAFE, PACKAGING_MISMATCH, COMPLIANCE, SPEC | — |
| `Offered MPN` | What supplier is actually listing | — |
| `Variant Flags` | G=RoHS, T1=T&R, Q=Auto, etc. | Yellow if risky |

### Implementation Steps

1. **Parse customer MPN** — extract base part + packaging indicator (if any)
2. **Parse supplier MPN** — extract base part + all suffixes
3. **Classify suffixes** — packaging vs compliance vs spec
4. **Determine match type** — apply bidirectional packaging logic
5. **Prioritize suppliers** — exact matches first, then packaging-safe, flag others
6. **Output flags** — add columns to results Excel

### Detection Patterns

```javascript
// Packaging suffixes (generally safe when not specified)
const PACKAGING_SUFFIXES = /[-#]?(T&?R|TR\d*|T1|TUBE|TRAY|REEL|BULK|CUT)$/i;

// RoHS/Compliance suffixes (risky - spec change)
const COMPLIANCE_SUFFIXES = /[-#]?(G|G4|PBF|LF|NOPB|ROHS|-Z)$/i;

// Temperature grade suffixes (risky - different spec)
const TEMP_SUFFIXES = /[-#]?(E|I|M|C)$/i;  // Extended, Industrial, Military, Commercial

// Automotive qualification (risky - different qualification)
const AUTO_SUFFIXES = /[-#]?(Q|Q1|AEC)$/i;
```

### Example: NUP2105L

| Offered MPN | Suffix Parse | Match Type | Action |
|-------------|--------------|------------|--------|
| NUP2105L | (none) | EXACT | ✓ Select |
| NUP2105LT1 | T1 = T&R | PACKAGING_SAFE | ✓ Select |
| NUP2105LT1G | T1 = T&R, G = RoHS | COMPLIANCE | ⚠ Flag |
| NUP2105LG | G = RoHS | COMPLIANCE | ⚠ Flag |

**Why this matters:** If customer needs leaded parts (military/aerospace, legacy manufacturing), RoHS alternatives are not viable. Current automation doesn't catch this.

---

## B7. Memory Product Handling

**Status:** Planned | **Priority:** Later

**Problem:** Memory ICs (DRAM, Flash, SRAM) have unique market dynamics:
- Higher price volatility
- Spot market pricing
- Specialized broker networks
- Shorter product lifecycles

**Solution:**
- Detect memory MPNs by prefix (MT, K4, K9, H5, W25, IS42, NT)
- Check memory spot pricing sources (DRAMeXchange)
- Query memory-specific broker networks
- Different scoring (date code less critical)

---

## B8. BrokerBin RFQ Automation

**Status:** Planned | **Priority:** Later

**Problem:** Currently only sourcing from NetComponents. BrokerBin has different supplier networks.

**Solution:**
- Extend RFQ automation to BrokerBin platform
- Adapt supplier selection logic for BrokerBin listings
- Integrate responses into VQ Parser workflow

---

## B9. PartsBase RFQ Automation

**Status:** Planned | **Priority:** Later

**Problem:** PartsBase has unique supplier coverage not available on NetComponents or BrokerBin.

**Solution:**
- Extend RFQ automation to PartsBase platform
- Adapt supplier selection logic for PartsBase listings
- Integrate responses into VQ Parser workflow

---

## B10. NetComponents Email Update

**Status:** Planned | **Priority:** High

**Task:** Change the contact/reply-to email address on the NetComponents account to `astutesourcing@astutegroup.com`.

**Why:** Supplier quote responses will route directly to the Astute group email instead of requiring manual forwarding or tracking. Keeps responses in the official domain.

**Steps:**
1. Log into NetComponents account settings
2. Update email address to `astutesourcing@astutegroup.com`
3. Send a test RFQ batch and confirm supplier responses arrive at the new address

---

# Section C: VQ Processing

| # | Feature | Priority | Status |
|---|---------|----------|--------|
| C1 | RFQ Matching Window | — | ✅ Done |
| C2 | No-Bid Detection | — | ✅ Done |
| C3 | Parser Bug Fixes | Later | In Progress |
| C4 | Vendor-Specific Templates | Later | Planned |
| C5 | Attachment Handling | Later | Planned |
| C6 | Retry Tracking | Later | Planned |
| C7 | LLM Fallback | Later | Planned |
| C8 | MFR Text Validation | **Now** | ✅ Done |
| C9 | Distributor `vqPackaging` Extraction + shared packaging cog + factory policy | **Now** | ✅ Done (cog + 2 distributors wired; 5 distributors confirmed have no usable field) |
| C10 | VQ Loader Date Code & Packaging Auto-Capture | **Now** | ✅ Done |
| C11 | Shared Field Resolver Layer (refactor 4 writers) | **Next** | Planned |
| C12 | Universal Record Writer (config-driven) | Later | Planned |
| C13 | Mismatched-MPN Capture for Analytics Visibility | Later | Planned |
| C14 | HTS / ECCN Auto-Population at VQ Write Time | **Now** | ✅ Done |
| C15 | MPN → MFR Inference + Resolver Facade | **Now** | ✅ Done (cog shipped, writer migration deferred) |

---

## C1. RFQ Matching Window

**Status:** ✅ Done | **Priority:** —

**Problem:** Old RFQs with thousands of parts were catching unrelated quotes. A quote for MPN "ABC123" might match an RFQ from 6 months ago instead of the recent one.

**Solution Implemented (2026-03-03):**
- 14-day date window for RFQ matching
- Exact MPN match → fuzzy match → flag as `[NEEDS_RFQ]`
- Output uses RFQ's MPN (not vendor's quoted MPN)
- Differences noted in `chuboe_note_public`

---

## C2. No-Bid Detection

**Status:** ✅ Done | **Priority:** —

**Implementation:**
- Detects: "out of stock", "cannot quote", "not available"
- Creates CSV with NO-BID flag
- Moves to Processed folder

**Feeds into:** No-Bid Database (Section D)

---

## C3. Parser Bug Fixes

**Status:** In Progress | **Priority:** Later

**Known Issues:**
- [ ] Multi-row table header extraction bug (Galco, OzDizan)
- [ ] MPN bleeding into price field (NUP2105 → $2105)

**Solutions:**
- Add table header detection in html-table-parser.js
- Filter rows where MPN = "MPN" or "Part Number"
- Add MPN format validation before using as price

---

## C4. Vendor-Specific Templates

**Status:** Planned | **Priority:** Later

**Target Vendors (high failure rates):**
- OzDizan
- Inelco
- Galco
- ECOMAL (CID image references in emails)

**Approach:**
- Create vendor-specific parsing templates
- Add to `src/parser/vendor-templates/` directory
- Route by sender email domain

---

## C5. Attachment Handling

**Status:** Planned | **Priority:** Later

**Issues:**
- 15-second PDF timeout causes failures
- Some vendors only send quotes in PDF attachments

**Solutions:**
- [ ] Increase PDF timeout (15s → 30s)
- [ ] Detect "see attachment" and skip body parsing
- [ ] Better pdf.js-extract for complex tables
- [ ] Retry logic for large attachments

---

## C6. Retry Tracking

**Status:** Planned | **Priority:** Later

**Problem:** No tracking of how many times an email has been attempted.

**Solution:**
- Track parse attempts per email
- Skip if already tried with current parser version
- Move to ParseFailed after 3 failures

**Data Structure:**
```json
{
  "emailId": "1823",
  "parseAttempts": [
    {
      "attemptedAt": "2026-03-02T14:40:19Z",
      "parserVersion": "1.2.0",
      "result": "failed",
      "confidence": 0.3
    }
  ],
  "status": "pending" | "max_retries_reached" | "succeeded"
}
```

---

## C7. LLM Fallback

**Status:** Planned | **Priority:** Later

**Use Cases:**
- Low-confidence parses (< 0.6)
- Informal prose quotes
- Multi-line quote analysis

**Cost-Benefit:**
- API cost: ~$0.01-0.05 per email
- Benefit: 10-15% additional parse rate
- Decision: Enable for high-value RFQs or after 2 failed attempts

---

## C8. MFR Text Validation

**Status:** ✅ Done (2026-04-08) | **Priority:** Now

**Resolution:** This was already addressed at a higher level than the original roadmap entry assumed.

The canonical resolver (`shared/mfr-lookup.js`) was built with a 5-tier strategy (alias → cache → DB strict → DB fuzzy inference → passthrough) and 165+ curated aliases in `mfr-aliases.json`. All four steady-state writers — `rfq-writer.js`, `vq-writer.js`, `offer-writeback.js`, `cq-writer.js` — call it via `lookupMfr()` and surface confidence flags (`MFR_NO_MATCH`, `MFR_LOW_CONFIDENCE`, `MFR_SYSTEM_ONLY`) for review. The "100% match rate" target documented in `feedback_mfr_resolution_mandatory.md` is achievable through the canonical cog.

The only remaining gap was the **email-driven CSV emergency path** (`vq-parser` repo): `vq-parser/src/mapper/mfr-lookup.js` had its own ~30-entry hardcoded alias map and its own DB query, separate from the canonical 165-entry shared module. CSVs uploaded through the iDempiere UI bypass `vq-writer.js` validation, so the parser-stage normalization was the only MFR check that path got — and it was using the wrong (smaller, drift-prone) alias list.

**What shipped 2026-04-08:** `vq-parser/src/mapper/mfr-lookup.js` is now a thin shim that imports `normalizeMfr` from the shared resolver. The 120 lines of inline alias map + DB query are gone. `field-mapper.js` is unchanged — it still calls `normalizeMfr(text)` with the same signature, and now gets the full 5-tier resolution and 165-alias list automatically.

**Open follow-ups (not blocking C8 closure):**

1. **Acquisition policy.** The OLD vq-parser hardcoded a "map to parent company" policy (LINEAR → ADI, XILINX → AMD, MAXIM → ADI, ALTERA → Intel, IR → Infineon). The shared `mfr-aliases.json` has an inconsistent policy — most stay as the original brand (XILINX → "Xilinx Inc"), but AVAGO → Broadcom is the one acquisition mapping. The redirect inherits the shared policy by default, which means brands like LINEAR TECH no longer get consolidated under ADI. iDempiere has both records for each acquisition pair (`Linear Technology Corp` 1000037 AND `Analog Devices Inc` 1000006), so either policy is mechanically possible. Needs a strategic call: brand-level traceability vs parent consolidation. Track in a separate workstream — does not block C8.
2. **Fuzzy matcher tiebreaker bug.** `LINEAR TECH` resolves to `Lineartech` (id 1003539, a different company entirely) instead of `Linear Technology Corp` (id 1000037), because the fuzzy matcher's tiebreaker is `LENGTH(name) ASC` and the shorter name wins even when the longer name has better word-boundary matching. Workaround: add an explicit `"LINEAR TECH": "..."` alias (whichever target the acquisition policy decides). Long-term fix: improve tiebreaker to prefer word-boundary matches over compound-word matches in `shared/mfr-lookup.js` `queryDBFuzzy()`.
3. **Orphaned cache file.** `vq-parser/data/mfr-cache.json` (848 bytes, last touched 2026-03-04) is now unused by the shim — the shared resolver manages its own cache at `astute-workinstructions/shared/data/mfr-cache.json`. Left in place to avoid masking any unexpected reader; safe to delete on a future cleanup pass.

---

## C9. Distributor `vqPackaging` Extraction + Shared Packaging Cog + Factory Policy

**Status:** ✅ Done (2026-04-08) | **Priority:** Now

Three sub-items shipped together:

### C9b — Promote packaging-lookup to shared cog ✅

`PACKAGING_MAP` and `normalizePackaging` lived inside `shared/vq-writer.js` until 2026-04-08. Now in `shared/packaging-lookup.js`. Both vq-writer and cq-writer import from there. ~310 lines including doc, helpers, and three exported functions (`normalizePackaging`, `hasExplicitFactoryMarker`, `isFullFactoryQty`).

**Three-path factory policy** (decided 2026-04-08):

F-REEL / F-TRAY / F-TUBE is correct when ANY of:

1. **Explicit factory marker in the input string** — "mfr", "factory", "sealed", "oem", or "f-reel" / "f-tray" / "f-tube". Works for ANY vendor type. A broker who clearly states "MFR Reel" is making a verifiable claim.
2. **Authorized vendor + full factory pack qty** — vendor is franchise / mfr-direct / catalog distributor / online distributor AND quoted qty matches the manufacturer's SPQ exactly OR is a clean integer multiple (5,000 from a 1,000 SPQ part = 5 sealed reels).
3. Otherwise → plain variant (REEL 1000004 / TRAY 1000005). For TUBE there is no plain variant in `chuboe_packaging` so non-qualifying tubes return null.

Conservative default (no context, no marker) is the plain variant. Under-claiming factory is much safer than over-claiming.

**Smoke test:** 45/45 (8 isFullFactoryQty + 12 hasExplicitFactoryMarker + 25 normalizePackaging integration covering all three paths).

### C9c — cq-writer populates Chuboe_Packaging_ID ✅

`cq-writer.js` previously wrote only `Chuboe_Packaging_Text` (the freetext field), leaving the ID column null. Now it ALSO writes `Chuboe_Packaging_ID` via the shared cog. Same shape as the C8/C15 MFR text-vs-ID gap fix.

CQ callers default to no `isAuthorized` context. To get the auto-upgrade math path, pass `line.isAuthorized: true` and `line.spq`. Otherwise the explicit factory marker path is the only route to F-* on a CQ line.

### C9a — Distributor wiring audit + extractions

| Distributor | Vol 90d | Field path | Status |
|---|---:|---|---|
| **DigiKey** | 927 | `selectBestPricing().packageType` (already in result, just propagated to `vqPackaging`) | ✅ wired 2026-04-08 |
| Mouser | 533 | `ProductAttributes[name='Packaging']` | ✅ already wired (C10, 2026-04-07) |
| **Master** | 282 | top-level `packageType` | ✅ wired 2026-04-08 |
| Arrow | 256 | `packageType` field exists but is **always empty** for every test MPN. `sourceParts[].packSize` is just a count, not a type | skip — no usable data |
| Future | 212 | `part_attributes[name=packageType]` returns generic `STDMFR` ("standard manufacturer pack") for every test MPN — no specific reel/tray/tube info | skip — no usable data |
| Newark | 192 | only `reeling: bool` and `packSize: int`; `reeling: false` even on MLCCs that ship on reels — unreliable | skip |
| TTI | 135 | (already wired) | ✅ already wired (C10) |
| Waldom | 27 | top-level keys include `StandardPackQuantity` (count) but no packaging type field at all | skip |
| Sager | 22 | (already wired) | ✅ already wired (C10) |
| Rutronik | 1 | API returns "nothing found" for every test MPN — likely account-restricted catalog | skip (negligible volume) |

**Aggregate coverage going forward:**
- Wired: DigiKey + Mouser + Master + TTI + Sager = **1,899 / 2,587 = ~73%** of franchise VQ volume
- Unwired by choice (no usable data): Arrow + Future + Newark + Waldom + Rutronik = ~27%

Same shape as the HTS/ECCN audit — the distributors that expose useful packaging type cover the bulk of volume.

### Root bug fixed along the way

The original `normalizePackaging` always mapped "reel" → 1000001 (F-REEL), "tray" → 1000002 (F-TRAY), "tube" → 1000003 (F-TUBE) regardless of partial vs full pack quantity. That over-claimed factory-sealed packaging on every partial-quantity row written via vq-writer since C10 (2026-04-07).

**The LAM EPG load (140 VQs, 2026-04-07)** likely has F-REEL attribution on partial-quantity rows that shouldn't have it. Packaging is Tier 2 (only required at PO conversion), so the incorrect IDs haven't broken anything yet — but they will produce wrong PO packaging selection if not corrected. **Backfill consideration:** could re-run packaging normalization on RFQ 1132040 VQ rows using the new policy + actual qty/spq context. Low priority; the operator can fix at PO time.

### Files shipped

| File | Change |
|---|---|
| `shared/packaging-lookup.js` | NEW — 310 lines |
| `shared/vq-writer.js` | Drops inline impl; imports from shared cog; passes qty/spq/isAuthorized to resolver |
| `shared/cq-writer.js` | Imports from shared cog; populates `Chuboe_Packaging_ID` alongside `Chuboe_Packaging_Text` |
| `Trading Analysis/RFQ Sourcing/franchise_check/digikey.js` | Adds `vqPackaging` to result init + propagates `pricingInfo.packageType` |
| `Trading Analysis/RFQ Sourcing/franchise_check/master.js` | Adds `vqPackaging` to result init + extracts top-level `packageType` |

### Open follow-ups

1. **LAM EPG packaging backfill** — RFQ 1132040 rows likely have wrong F-* attribution. Re-run normalization with the new policy + actual qty/spq from each row. Low priority.
2. **DigiKey rate limits during the audit** — DigiKey returned empty results during the C9a probing because of OAuth token / rate-limit issues from heavy use earlier in the day. The wiring is verified by code-reading, not end-to-end probe. Re-test on the next fresh DigiKey call.
3. **Future / Newark deeper probe** — both have packaging-adjacent fields (Future's `STDMFR` + `mpq`; Newark's `reeling` + `packSize`) that could potentially be combined into a packaging type with more inference logic. Low value given the unreliability.
4. **Arrow compliance endpoint** — Arrow's standard search returns empty `packageType`, but Arrow may have a separate parametric/compliance endpoint that returns packaging type. Same concerns as the Arrow HTS/ECCN endpoint (data quality, separate auth) — defer.

---

## C10. VQ Loader Date Code & Packaging Auto-Capture

**Status:** ✅ Done | **Priority:** Now

**Implementation (2026-04-07):**

Patched `shared/vq-writer.js` and `shared/franchise-api.js` so VQ loads no longer drop date code and packaging when the source provides them, and apply sensible defaults when it doesn't.

**`vq-writer.js` changes:**
1. Added `normalizePackaging(text)` helper + `PACKAGING_MAP` (verified against `chuboe_packaging` DB values)
2. Added `MFR_DIRECT_OR_FRANCHISE` constant (vendor types `1000001`, `1000002`, `1000007`) and `DEFAULT_DATE_CODE_AUTHORIZED = 'within 2 years'`
3. Payload assembly now sets:
   - `Chuboe_Packaging_ID = d.vqPackagingId || normalizePackaging(d.vqPackaging) || opts.packagingId || null`
   - `Chuboe_Date_Code = d.vqDateCode || (mfrDirectOrFranchise(vendorTypeId) ? "within 2 years" : null) || opts.dateCode || null`
4. Helper, map, and constants are exported for downstream loaders

**`franchise-api.js` change:**
- Added `vqPackaging: result.vqPackaging || ''` to the searchPart return shape (sits next to `vqDateCode`)

**Why this matters:** Buyers were manually filling in date code and packaging at PO time on every VQ. Now the system captures them automatically when the API knows them, and applies a sensible default ("within 2 years" — only for authorized-channel vendors) when the API doesn't.

**Open follow-up:** See **C9** — only Mouser, Sager, and TTI distributor modules currently populate `vqPackaging`. The other 7 need extraction added to fully realize the automation.

---

## C11. Shared Field Resolver Layer (refactor 4 writers)

**Status:** Planned | **Priority:** Next

**Problem:** We have four writer modules (`shared/rfq-writer.js`, `vq-writer.js`, `cq-writer.js`, `offer-writeback.js`) and each one duplicates the same cross-cutting field resolution logic. When we discover a new edge case (e.g., the system-only MFR ID handling on 2026-04-06, the date code/packaging auto-capture on 2026-04-07), we have to manually backport it to every writer. Today's incident: vq-writer was missing the SYSTEM_ONLY MFR fix and would have rejected ~85% of the LAM EPG load. The other three writers had it. Got lucky — next time we may not.

**What's actually duplicated across the 4 writers:**

| Concern | rfq | vq | cq | offer |
|---|---|---|---|---|
| RFQ resolution + line indexing by CPC/MPN | ✓ | ✓ | ✓ | (n/a) |
| BP resolution by search key + vendor type lookup | ✓ | ✓ | ✓ | ✓ |
| MFR resolution + system-only conditional ID | ✓ | ✓ (4/7) | ✓ | ✓ |
| Date code default for authorized channels | ✗ | ✓ (4/7) | ✗ | ✗ |
| Packaging string normalization | ✗ | ✓ (4/7) | ✗ | ✗ |
| Validation (TIER1_MANDATORY) | partial | ✓ | partial | partial |
| MPN cross-ref / fuzzy match | ✗ | ✓ | ✓ | ✗ |

**Solution:** Extract field resolvers into `shared/resolvers/` so each writer composes them rather than reimplementing. Each resolver owns exactly one concern. Fix once, applies to all.

**Proposed structure:**
```
shared/
  api-client.js                  ← exists
  mfr-lookup.js                  ← exists
  data-model.md                  ← exists

  resolvers/                     ← NEW
    mfr-resolver.js              // resolveMfrField(text) → {text, id|null}
    bp-resolver.js               // resolveBpField(searchKey, name) → {id, vendorTypeId, traceabilityId}
    date-code-resolver.js        // resolveDateCodeField(provided, vendorTypeId, opts) → string|null
    packaging-resolver.js        // resolvePackagingField(string|id, opts) → id|null
    rfq-line-resolver.js         // resolveRfqLine(rfqId, mpn, cpc, opts) → lineId|null
    validate-payload.js          // validatePayload(payload, table, tier) → {valid, missing}
    README.md                    // catalog of all resolvers + field type → resolver mapping

  writers/                       ← thin orchestrators
    rfq-writer.js                // composes resolvers + table-specific assembly
    vq-writer.js
    cq-writer.js
    offer-writeback.js
```

**Refactor approach (one writer at a time):**
1. **Extract resolvers from vq-writer first** (it has the richest logic — least re-design needed). Each becomes ~30-50 lines with a clear interface.
2. **Refactor vq-writer to use them** — should reduce from ~700 lines to ~300.
3. **Refactor rfq-writer next** (highest user volume). Picks up date code + packaging defaults for free.
4. **Refactor cq-writer and offer-writeback last** (lowest churn).

**Test gate per writer:** Real production load through each refactored writer before deploying. Equivalence test: same inputs → same payload as the pre-refactor version (modulo new defaults that we explicitly added).

**External interface unchanged.** Each writer's exported functions (`writeRFQ`, `writeVQBatch`, etc.) keep the same signature so callers don't need to update.

**Why this is higher leverage than C9:** C9 fixes one feature for one workflow. C11 fixes the structural problem that *caused* C9 (and C10, and the SYSTEM_ONLY backport) to need manual maintenance in the first place. After C11, every future field-level edge case is a one-file fix in `resolvers/` and all writers benefit.

---

## C12. Universal Record Writer (config-driven)

**Status:** Planned | **Priority:** Later (depends on C11)

**Problem:** Even after C11, every new chuboe table we want to write to requires its own writer module. POs, sales orders, payments, inventory adjustments, BPs, contacts, locations, projects, charges — every one of these will eventually need writeback support, and each one is currently a hand-written module.

**Vision:** A single `shared/writers/universal-writer.js` that can write to **any** chuboe table given a config:

```js
const { writeRecord } = require('../shared/writers/universal-writer');

// Future writes are this simple:
const result = await writeRecord('chuboe_vq_line', {
  rfqSearchKey: '1132040',
  cpc: '668-133934-120',
  mpn: 'FOLC-130-L4-L-Q-LC',
  mfrText: 'SAMTEC',           // mfr-resolver auto-applies
  vendorSearchKey: '1002339',  // bp-resolver auto-applies
  cost: 16.91,
  qty: 500,
  packaging: 'Cut Tape',       // packaging-resolver auto-applies
  // dateCode omitted → date-code-resolver applies vendor-type default
  // packagingId, buyerId can come from a workflow defaults config
});
```

**How it works:**
1. **Field registry** (`shared/resolvers/field-registry.js`): maps payload field names to the resolver that handles them. E.g., `Chuboe_MFR_ID` → mfr-resolver, `C_BPartner_ID` → bp-resolver, `Chuboe_Date_Code` → date-code-resolver. Generic fields (Cost, Qty, Description) pass through unchanged.
2. **Table mandatory registry**: maps each chuboe table to its mandatory field list. Driven from `data-model.md` (or a parsed version of it). Validates before POST.
3. **Parent-child orchestration**: for tables with hierarchies (RFQ → Line → Line MPN), the universal writer accepts nested structures and writes parents first, captures IDs, writes children. Defined by table relationships in the schema.
4. **Bean callout awareness**: for fields that the server will resolve (e.g., system-only MFR IDs), the writer KNOWS to omit them from the payload rather than passing nulls.

**Stages:**
- **Stage 1**: Build `field-registry.js` and refactor existing 4 writers to use it as a thin wrapper. They still exist as named exports for backward compatibility.
- **Stage 2**: Build the universal writer with table introspection + parent-child orchestration. New writes use it directly.
- **Stage 3**: Generate the table-mandatory registry automatically from `data-model.md`. Eliminates the manual sync.
- **Stage 4**: Optional: add a "schema watchdog" that runs against the live DB to detect when iDempiere tables change (new mandatory fields, dropped fields, type changes) so the registry stays in sync.

**What this unlocks for future workflows:**
- New writeback (PO, SO, payment, BP, contact, location, project, charge, etc.) → write a 5-line config, no new module
- New field type (e.g., a new lookup table) → add one resolver, update the registry, all writers benefit
- New data-validation rule → add to the registry, enforced everywhere automatically
- LLM-driven workflows that need to write structured data → call universal-writer with a JSON payload

**Discoverability:**
- `shared/resolvers/README.md` lists every available resolver with examples
- `shared/writers/README.md` lists every existing writer composition as a reference
- `data-model.md` cross-references which resolvers apply to which fields per table
- The session greeting / `CLAUDE.md` directs new workflows to read these before building anything

**Why this matters at the meta level:** Right now if we discover the system-only MFR pattern, we manually update 4 writers. With C12 we'd update one resolver. If a year from now we add 6 more writers (PO, SO, BP, contact, payment, inventory), we'd update zero writers when we discover edge case #N+1 — the resolver fix flows automatically. The maintenance cost of write-back support stays flat regardless of how many workflows or tables we add.

**Risk:** Over-engineering if it's too abstract. Mitigation: build C11 first (concrete refactor of 4 known writers, prove the resolver pattern works), then layer C12 on top once the resolvers are stable. Don't try to design for hypothetical future tables — design for what we know, accept that some refactoring will happen as new patterns emerge.

**Connection to data-model.md:** This is the "single source of truth for schema" promise made literal in code. Today data-model.md is documentation that humans read. C12 makes it the input to a code generator / runtime registry. That's the right destination for it.

---

## C13. Mismatched-MPN Capture for Analytics Visibility

**Status:** Planned (parked 2026-04-07) | **Priority:** Later

**Problem:** When a franchise distributor API returns an MPN that differs from what we asked for (packaging variant like `ADS1115ID` → `ADS1115IDR`, or genuine substitute), `vq-writer.js` today either writes the VQ with the returned MPN + a vendor note (`crossRef.suffix` case) or holds it for human review (`crossRef.mismatch` case). The note-only approach preserves data fidelity at the VQ level but creates a gap in **analytic visibility**: the consumers we use to find historical VQs don't see these records.

**Why this is broken for analytics:**

Vortex Matches and Quick Quote both look up VQ history by joining on cleaned MPN equality between `chuboe_rfq_line_mpn.chuboe_mpn_clean` and `chuboe_vq_line.chuboe_mpn_clean` (via `bi_vendor_quote_line_v`):

```sql
-- Quick Quote (qq_1130895.sql:110)
JOIN recent_vqs vq ON vq.vendor_quote_mpn_clean = rl.chuboe_mpn_clean

-- Vortex Matches (vortex-matches.js:158)
WHERE vql.vendor_quote_mpn_clean = ANY($1)
```

The join is **MPN-clean equality**, not a join via `chuboe_rfq_line_id`. So if we write a VQ for the variant `ADS1115IDR`, then:

| View | Visible? |
|---|---|
| Originating RFQ via Vortex/QQ MPN-history | ❌ — searches `ADS1115ID`, finds nothing |
| Other RFQs that ask for `ADS1115IDR` exactly | ✅ |
| Other RFQs that ask for `ADS1115ID` | ❌ |

The VQ "exists" in the database but is invisible to the consumers that drive the most valuable analyses, including on the very RFQ that triggered the API call. The vendor-note workaround surfaces the mismatch to humans reading the line in OT, but humans aren't the consumers we're optimizing for — Vortex / Quick Quote / future reports are.

**Proposed solution (parked):**

When `vq-writer.js` is about to write a VQ for a packaging variant (the `crossRef.suffix` branch), also POST a second `chuboe_rfq_line_mpn` row to the originating RFQ line carrying the variant MPN. Idempotent — check first whether a row with that `chuboe_mpn_clean` already exists on the line.

This uses the schema as designed: `chuboe_rfq_line_mpn` is a 1:N child of `chuboe_rfq_line` precisely to support multiple acceptable MPN variants per line. Effects:

- VQ row stays honest — records what the vendor actually quoted
- The line gets two MPN children: the customer's ask and the variant we found
- Future Vortex/QQ runs against this RFQ iterate both MPN children → find the VQ on the variant ✅
- Future Vortex/QQ runs against any other RFQ asking for the variant also find this VQ ✅
- Humans looking at the line in OT see the alt MPN explicitly

**Cross-cutting implications — this is NOT just a vq-writer change:**

Because the underlying problem is "the writeback shape doesn't match how analytics consume the data," the same question applies anywhere a record is written that may carry a mismatched MPN:

- **VQ writeback** (this item) — packaging variants and substitutions from franchise APIs
- **CQ writeback** (`shared/cq-writer.js`) — if we ever write CQs for variants we don't have a perfect ask for, same problem applies
- **RFQ writeback** (`shared/rfq-writer.js`) — already handles a single MPN per line; if a customer's source data references multiple acceptable MPNs, we need the same multi-row capture
- **Any output that surfaces VQs/CQs/RFQs to a user** (Vortex Matches, Quick Quote, Stock RFQ Loading reports, Market Offer Analysis) — these all do MPN-clean equality joins. They need to expect multiple MPN children per line and either:
  - (a) iterate per-line over all MPN children when looking up history, or
  - (b) flatten the line's MPN children into a `chuboe_mpn_clean IN (...)` set
  - Either way, when we change the writeback shape we have to verify each consuming workflow handles the multi-MPN case correctly. Some do (Vortex iterates `chuboe_rfq_line_mpn`), some need to be checked (Quick Quote SQL needs review).

**Why parked:** Current vendor-note approach is good enough for human-readable output today, and the writeback rate of mismatched MPNs is low. The right time to do this is when we either (a) start losing real money from invisible variant VQs in Vortex/QQ runs, or (b) tackle C11/C12 (resolver layer + universal writer) so the alt-MPN-row pattern can be implemented in one place rather than monkey-patched into every writer.

**Pre-work before unparking:**
1. Quantify the cost — query how many flagged/variant rows we've written in the last 90 days and estimate how many would have changed a Vortex/QQ outcome if visible.
2. Audit each consuming workflow (Vortex, QQ, Stock RFQ Loading, Market Offer Analysis, BOM Monitoring) to confirm it handles N>1 `chuboe_rfq_line_mpn` rows per line correctly. Some may need SQL changes when the writeback shape changes.
3. Decide whether genuine mismatches (not just packaging variants) get the same treatment, or stay in the `flagged[]` review queue.

---

## C14. HTS / ECCN Auto-Population at VQ Write Time

**Status:** ✅ Done (2026-04-08) | **Priority:** Now | **Dependency:** none

**Resolution:** `vq-writer.js` already had `Chuboe_HTS` / `Chuboe_ECCN` in the payload assembly (lines 528-530), sourced from `d.vqHts` / `d.vqEccn`. The reason historical loads (e.g., LAM EPG 2026-04-07) showed zero coverage was that the distributor modules weren't propagating those fields yet — `d.vqHts` was always null.

With the propagation patches shipped 2026-04-08 (DigiKey, Mouser, Master, Future, Newark already wired; TTI was already done), every new VQ load now auto-populates HTS/ECCN at write time. Validation via `shared/validators.js` (`isValidEccn`) was added so malformed values get dropped with a warning rather than written. The same `ECCN_REGEX` is shared between `vq-writer.js` and the backfill script.

**See the validation query and per-distributor expected coverage below for what to check on the next VQ load.**

---

**Problem:** `vq-writer.js` doesn't populate `Chuboe_HTS` / `Chuboe_ECCN` when writing new VQ rows, even though `franchise-api.js` now surfaces `vqHts` / `vqEccn` on the standardized result shape and 6 of 7 active distributors propagate at least one of the two fields (as of 2026-04-08).

Today the only path that gets HTS/ECCN onto VQ lines is the **HTS/ECCN Backfill** workflow (`Trading Analysis/HTS ECCN Backfill/hts-eccn-backfill.md`), which is an after-the-fact cleanup pass. Every new VQ load creates more cleanup debt.

**Why it matters:**
- Compliance / customs filing / customer requirements need HTS+ECCN populated
- The data is *already* in the API response when we write the VQ — we just throw it away
- Backfill works but is a band-aid; the steady-state fix is at write time
- LAM EPG load (140 lines) needed a backfill run that took 20 minutes of API calls. If we'd populated at write time, those 130 API calls had already happened during sourcing — zero incremental cost.

### Distributor Coverage Matrix (as of 2026-04-08)

Based on actual VQ writeback volume over the trailing 90 days:

| Rank | Distributor | Vol 90d | % | HTS field exposed? | ECCN field exposed? | Wiring status |
|---|---|---:|---:|---|---|---|
| 1 | **DigiKey** | 927 | 35.8% | ✅ `Classifications.HtsusCode` | ✅ `Classifications.ExportControlClassNumber` | ✅ wired 2026-04-08 |
| 2 | **Mouser** | 533 | 20.6% | ✅ `ProductCompliance[USHTS]` | ✅ `ProductCompliance[ECCN]` | ✅ wired 2026-04-08 (RestrictionMessage early-return bug fixed) |
| 3 | **Master** | 282 | 10.9% | ❌ no field | ✅ top-level `eccn` | ✅ wired 2026-04-08 |
| 4 | Arrow | 256 | 9.9% | ❌ standard search doesn't return | ❌ standard search doesn't return | 🅿️ **PARKED** — see below |
| 5 | **Future** | 212 | 8.2% | ❌ no field | ✅ `part_attributes[name=eccn]` (often null) | ✅ wired 2026-04-08 |
| 6 | **Newark / Farnell** | 192 | 7.4% | ❌ no field | ✅ `attributes[label=usEccn]` | ✅ wired 2026-04-08 |
| 7 | **TTI** | 135 | 5.2% | ✅ `hts` / `exportInformation.hts` | ✅ `exportInformation.eccn` | ✅ already extracted (catalog coverage spotty) |
| 8 | **Waldom** | 27 | 1.0% | ✅ top-level `HTSCode` | ✅ top-level `ExportControlClassificationNumber` | ✅ wired 2026-04-08 |
| 9 | Sager | 22 | 0.9% | ❌ none | ❌ none | confirmed — no classification fields exposed by `customer-price-availability/v1` endpoint |
| 10 | Rutronik | 1 | <0.1% | ❓ inconclusive | ❓ inconclusive | API returned "nothing found" for all test MPNs (350712-4, CRCW2512160KJNEG, 7443551280); not worth more digging at <0.1% volume |

**Aggregate coverage going forward (excluding Arrow):**
- HTS: DigiKey + Mouser + TTI + Waldom = 1,622 / 2,331 = **69.6%** of non-Arrow franchise volume
- ECCN: DK + Mouser + Master + Future + Newark + TTI + Waldom = 2,308 / 2,331 = **99.0%** of non-Arrow franchise volume

Waldom is small (1% volume) but it's the only non-DK/Mouser distributor that exposes BOTH HTS and ECCN, so it punches above its weight on the HTS coverage % since DK/Mouser/TTI are the only other HTS sources.

ECCN coverage is now near-complete for non-Arrow volume — only Sager (0.9%) and Rutronik (<0.1%) remain unwired, both for justified reasons (Sager has no field; Rutronik returns nothing for our test queries).

### Why Arrow is Parked

Arrow's `itemservice/v4/en/search/token` endpoint does **not** return HTS or ECCN at all. To get classification data from Arrow we'd need a separate compliance endpoint, but per ongoing experience:

- **Arrow's data quality on these fields is unreliable.** Even when classification data is available via separate endpoints, customers and operators have flagged repeated mismatches with manufacturer-published values.
- The cost of integrating Arrow's compliance endpoint (additional API calls per part, separate rate-limit profile, separate auth path) is not justified by the volume relative to the data quality risk.
- Arrow VQ rows can still get HTS/ECCN populated via the **backfill workflow**, which queries DigiKey + Mouser by (mpn, mfr) and applies values to *all* VQ rows for that part regardless of vendor — including Arrow's.

**Decision (2026-04-08):** Skip Arrow at the write-time path. Backfill is the sole channel for Arrow VQ classification data. Re-evaluate only if Arrow's data quality improves materially or volume changes significantly.

### Proposed change (one writer, ~10 lines)

In `shared/vq-writer.js`, when assembling the `chuboe_vq_line` POST payload, include:

```javascript
if (item.franchiseResult) {
  if (item.franchiseResult.vqHts)  payload.Chuboe_HTS  = item.franchiseResult.vqHts;
  if (item.franchiseResult.vqEccn) payload.Chuboe_ECCN = item.franchiseResult.vqEccn;
}
```

Where `item.franchiseResult` is the per-distributor result from `searchAllDistributors()` that already drives the rest of the write. Tier 1 mandatory list does NOT need to include these — they remain optional, and `vq-writer` already handles undefined fields correctly.

**Source priority at write time:** unlike the backfill (which queries multiple sources and resolves conflicts), at write time we already know which distributor we're writing the VQ for — DigiKey VQ row gets DigiKey's HTS, Mouser VQ row gets Mouser's HTS. No cross-source resolution needed. Disagreements are deferred to either the backfill workflow (which sees both sources for the same MPN) or to manual review.

**ECCN format validation:** Use the same loose regex from `hts-eccn-backfill.js` (`ECCN_REGEX`). Skip the value if it doesn't match — log a warning but don't fail the VQ write. HTS has no validator (codes too varied to regex).

### Effects

- Every new VQ load auto-populates HTS/ECCN where the source returned them
- Backfill workflow becomes a *secondary* tool — only needed for old data, parts whose original VQ source didn't return classification, multi-source disagreement consolidation, or Arrow rows
- Per-distributor: DigiKey/Mouser/TTI write with both fields; Master/Newark write with ECCN only; Future writes with ECCN where their catalog has it (low hit rate); Arrow writes neither (handled by backfill)

### What's NOT in scope

- Backfilling old VQ rows (use the backfill workflow)
- Wiring Waldom / Sager / Rutronik (low volume, audit deferred)
- Arrow compliance endpoint integration (see "Why Arrow is Parked")
- Running a "second pass" call against a different distributor when the source distributor returned null — that's the backfill's job, not the writer's

### Implementation Steps

1. Edit `shared/vq-writer.js` to copy `vqHts`/`vqEccn` from `item.franchiseResult` (or wherever `franchise-api` results land in the writer's input shape) into the POST payload
2. Add `ECCN_REGEX` validation with warn-and-skip on failure
3. Test on a small new RFQ load (5 lines), verify HTS/ECCN appear on the new VQ rows in OT
4. Document in `vq-loading.md` under "Auto-populated fields"

### Validation Query

```sql
-- After a new VQ load, check coverage
SELECT
  vl.c_bpartner_id,
  bp.name,
  COUNT(*) AS lines,
  ROUND(100.0 * COUNT(*) FILTER (WHERE chuboe_hts IS NOT NULL) / COUNT(*), 1) AS hts_pct,
  ROUND(100.0 * COUNT(*) FILTER (WHERE chuboe_eccn IS NOT NULL) / COUNT(*), 1) AS eccn_pct
FROM adempiere.chuboe_vq_line vl
JOIN adempiere.c_bpartner bp ON bp.c_bpartner_id = vl.c_bpartner_id
WHERE vl.chuboe_rfq_id = <rfq_id> AND vl.isactive = 'Y'
GROUP BY vl.c_bpartner_id, bp.name
ORDER BY lines DESC;
```

Expected per-distributor coverage on a new load:
- DigiKey / Mouser / TTI: ~95% on both HTS and ECCN
- Master / Newark: ~0% HTS, ~95% ECCN
- Future: ~0% HTS, variable ECCN (catalog dependent)
- Arrow: 0% / 0% (deferred to backfill)

### Pre-work / Risks

- Confirm `vq-writer` consumers are passing the franchise result through to where the payload is assembled. Spot-check the LAM EPG path and the franchise screening → VQ path.
- Decide whether the ECCN regex should match the one in `hts-eccn-backfill.js` or move to a shared validator. If 2+ writers need it → promote to `shared/`.

**Cross-cutting note:** This is a scoped change to one writer. It does NOT depend on C11 (resolver layer) or C12 (universal writer) — just bolt the field copy onto the existing `vq-writer.js` payload assembly. When C11/C12 land later, the field copy moves to the shared resolver/writer config.

---

## C15. MPN → MFR Inference + Resolver Facade

**Status:** ✅ Done (cog shipped 2026-04-08, writer migration deferred) | **Priority:** Now

**Problem:** Policy D #3 says: when a row has no MFR string, infer the original maker from the MPN and (if the maker has been acquired) attribute to the current owner. This requires a different lookup than the existing brand-string normalization in `shared/mfr-lookup.js`. Inputs differ (MPN vs string), data sources differ (prefix table vs alias file), match algorithms differ (longest-prefix-match vs dictionary lookup), and failure modes differ. Building this capability into `mfr-lookup.js` would tangle two distinct maintenance disciplines into one file.

**Architecture (decided 2026-04-08):**

```
shared/mfr-lookup.js          ← brand string → canonical record (existing)
shared/mpn-mfr-classifier.js  ← MPN → original maker (new — C15)
shared/mfr-resolver.js        ← facade combining both + acquisition policy (new — C15)
shared/mpn-classifier.js      ← no-franchise-hit bucketing (existing, unrelated)
```

**What shipped:**

1. **`shared/mpn-mfr-classifier.js`** — pattern-matching engine. Loads `shared/data/mpn-prefixes.json` (~75 hand-curated entries seeded from common semi prefixes + the OLD vq-parser stub's acquisition cases). Sorts prefixes longest-first so `LTC` wins over `LT` for `LTC1485`. Returns `{matched, mfr, prefix, source, confidence, notes}`. Confidence is `high` for prefixes ≥3 chars, `medium` for shorter (more collision-prone). Acquisitions are NOT applied here — that's the resolver's job.

2. **`shared/data/mpn-prefixes.json`** — seed prefix table. Format: `{ prefix: { mfr, notes } }`. Names match canonical `chuboe_mfr.name` values. Includes top semi prefixes for TI, Maxim, ADI, Microchip (Atmel), ST, NXP, ON Semi, Infineon, IR, Altera, Xilinx, Broadcom (Avago), Micron, Samsung, ISSI, Winbond, FTDI, Murata, Vishay, Panasonic. ~75 entries — NOT comprehensive. Expand as gaps surface.

3. **`shared/data/mfr-acquisitions.json`** — acquisition map. 12 entries covering well-known semi acquisitions (Linear→ADI, Maxim→ADI, Xilinx→AMD, Altera→Intel, Avago→Broadcom, IR→Infineon, Atmel→Microchip, Microsemi→Microchip, Cypress→Infineon, Freescale→NXP, Hittite→ADI, Fairchild→ON). Iterative chain resolution capped at 5 hops to guard against accidental cycles in the data file.

4. **`shared/mfr-resolver.js`** — single entry point facade. `resolveMfrForRow({mfrText, mpn, applyAcquisitionMap})` dispatches to the right path:
   - **Text path** (Policy D #1): if `mfrText` is provided, call `lookupMfr` directly. Source intent preserved — acquisition map NEVER applied. Returns the canonical iDempiere record for the brand the source named.
   - **MPN path** (Policy D #3): if no `mfrText` but `mpn` is provided, call `classifyMpnToMfr` to find the original maker, then optionally remap via the acquisition map (default true), then resolve the final name to its iDempiere ID via `lookupMfr`. Returns `{originalMfr, acquisitionApplied: true, prefix}` so the caller can audit what happened.
   - **Both paths**: text wins (Policy D #1).
   - **Neither**: returns `{matched: false, source: 'no-input'}`.

**Smoke test results (27/27 passing):**
- mpn-mfr-classifier unit: 11/11 (LTC1485, LM358N, MAX232, XCVU9P, ATMEGA328P, IRFP4668, EPM240, HFBR, CRCW, GE-INTERNAL, empty)
- applyAcquisition unit: 7/7 (Linear→ADI, Maxim→ADI, Xilinx→AMD, Altera→Intel, IR→Infineon, Avago→Broadcom, TI→TI no-change)
- resolveMfrForRow integration: 9/9 (text path, MPN+acquisition, MPN-no-acquisition, text wins over MPN, no-input fallback)

**What's NOT done (deferred to follow-up workstreams):**

1. **Writer migration.** The four steady-state writers (rfq-writer, vq-writer, offer-writeback, cq-writer) still call `lookupMfr()` directly. Migration is additive — replace `lookupMfr(mfrText)` with `resolveMfrForRow({mfrText, mpn})` and the writer gains MPN inference for free without losing the text-path behavior. ~10 lines per writer. Not blocking; the existing writers keep working unchanged.

2. **Prefix table expansion.** The seed list is ~75 entries. Real coverage needs 300-500+ for comprehensive semi/passive/connector coverage. Best path forward: mine `chuboe_vq_line` history for `(mpn_prefix, mfr_id)` pairs that co-occur >N times and surface candidate prefixes for review.
   ```sql
   -- Sketch: find candidate prefixes from VQ history
   WITH parts AS (
     SELECT
       SUBSTRING(chuboe_mpn_clean FROM 1 FOR 3) AS prefix3,
       chuboe_mfr_id,
       COUNT(*) AS cnt
     FROM adempiere.chuboe_vq_line
     WHERE chuboe_mpn_clean IS NOT NULL AND chuboe_mfr_id IS NOT NULL
     GROUP BY 1, 2
   )
   SELECT prefix3, mfr.name, cnt
   FROM parts p JOIN adempiere.chuboe_mfr mfr ON mfr.chuboe_mfr_id = p.chuboe_mfr_id
   WHERE cnt >= 20
   ORDER BY prefix3, cnt DESC;
   ```
   Then review for prefixes where one MFR clearly dominates (>80% of rows for that prefix) and add to `mpn-prefixes.json`.

3. **LLM/API fallback for unknown prefixes.** When the prefix table doesn't match, future enhancement could call an LLM with the MPN + a "what manufacturer is this?" prompt. Out of scope for v1 — adds latency, cost, and a different failure mode. Revisit only if prefix-table coverage proves inadequate.

4. **Confidence downgrade for short prefixes.** Currently 1-2 char prefixes return `confidence: medium`, ≥3 char prefixes return `confidence: high`. No caller checks confidence today. Could be wired into `mfr-resolver` to surface low-confidence inferences for human review at write time.

5. **Acquisition map maintenance.** As new acquisitions complete (semi industry consolidation continues), add entries to `mfr-acquisitions.json`. Operator alert when an MPN classifies to a freshly-acquired brand could trigger a manual review.

**Cross-cutting note:** This sits ABOVE `mfr-lookup.js` in the layering — `mfr-resolver.js` imports both `mfr-lookup.js` and `mpn-mfr-classifier.js`. It does NOT depend on C11 (resolver layer for write-time field assembly) or C12 (universal writer). Once C11/C12 land, the writers' field-resolution step would call `resolveMfrForRow` instead of `lookupMfr` and gain MPN inference automatically.

---

# Section D: Integration & Cross-Cutting

| # | Feature | Priority | Status |
|---|---------|----------|--------|
| D1 | No-Bid Database | **Now** | Planned |
| D2 | iDempiere Integration | Later | Planned |
| D3 | Scheduling & Automation | Backlog | Planned |
| D4 | Reporting & Analytics | Backlog | Planned |

---

## D1. No-Bid Database

**Status:** Planned | **Priority:** Now

**Purpose:** Central store linking VQ no-bid detection to RFQ supplier filtering.

**Data Structure:**
```json
{
  "noBids": [
    {
      "vendorSearchKey": "V12345",
      "vendorName": "Velocity Electronics",
      "mpn": "SPP11N80C3",
      "rfqId": "1130292",
      "noBidDate": "2026-03-02",
      "reason": "out of stock",
      "expiresAt": "2026-06-02"
    }
  ]
}
```

**Flow:**
- VQ Parser detects no-bid → writes to database
- RFQ Sourcing checks database → skips supplier+MPN combinations

---

## D2. iDempiere Integration

**Status:** Planned | **Priority:** Later

**Features:**
- Direct VQ upload via API
- Validate records before upload
- Error handling and rollback

---

## D3. Scheduling & Automation

**Status:** Planned | **Priority:** Backlog

**Schedule:**
- Daily: Fetch emails, parse, consolidate
- Weekly: Reprocess NeedsReview folder
- Monthly: Review ParseFailed, expire old no-bids

---

## D4. Reporting & Analytics

**Status:** Planned | **Priority:** Backlog

**Parse Rate Dashboard:**
- Daily/weekly trends
- Vendor-specific rates
- Strategy success (HTML vs regex vs PDF)

**Vendor Performance:**
- Response time
- Quote completeness
- No-bid rate
- Price competitiveness

**RFQ Efficiency:**
- RFQs sent vs quotes received
- Conversion to orders
- Supplier fatigue trends

---

# Completed Items

## Section A: Franchise Screening
*(No completed items yet)*

## Section B: RFQ Sourcing
- [x] Header row detection fix
- [x] Supplier link finding (table column 15)
- [x] "24+" date codes scored as fresh
- [x] Quantity tiebreaker only when below requested qty
- [x] Coverage-based selection
- [x] Cross-region balancing
- [x] Min order value filtering
- [x] Basic MPN packaging normalization
- [x] **MPN Variant Prioritization (B6)** — Suffix classification (packaging/compliance/spec), bidirectional packaging logic, match type in priority scoring, Excel output with color coding
- [x] **Same Part/Supplier Cooldown (B1)** — 60-day cooldown (14 for memory, 90 after no-bid), rfq_history.py module, supplier ranking for template prioritization

## Section C: VQ Processing
- [x] NoBid folder cleanup
- [x] Flag validation fix
- [x] Simple quote extraction
- [x] Domain-based vendor lookup
- [x] Fuzzy name matching
- [x] Automatic flag stripping in consolidate
- [x] 14-day RFQ matching window
- [x] Vendor ID correction (search_key vs c_bpartner_id)
- [x] **VQ Loader Date Code & Packaging Auto-Capture (C10)** — `vq-writer.js` now reads `vqPackaging` strings, normalizes via `PACKAGING_MAP`, and auto-defaults date code to "within 2 years" for franchise/mfr-direct vendors when API doesn't return one
- [x] **HTS / ECCN Auto-Population at VQ Write Time (C14)** — `vq-writer.js` payload assembly already wired; propagation completed across DigiKey, Mouser, Master, Future, Newark distributor modules; ECCN validation via `shared/validators.js`; backfill workflow now a secondary cleanup tool only
- [x] **MFR Text Validation (C8)** — canonical resolver in `shared/mfr-lookup.js` was already in use by all 4 steady-state writers (rfq, vq, offer, cq); only remaining gap was the email-driven CSV emergency path (`vq-parser/src/mapper/mfr-lookup.js`), now redirected to the shared cog via a thin shim. 165-alias list + 5-tier resolution now applies to both REST writes and CSV emergency uploads. Acquisition policy + LINEAR TECH alias gap surfaced as separate follow-ups.
- [x] **MPN → MFR Inference + Resolver Facade (C15)** — new shared cog (`shared/mpn-mfr-classifier.js` + `shared/mfr-resolver.js`) handles Policy D #3 (infer maker from MPN when source has no MFR; remap to current owner if acquired). 75-entry seed prefix table + 12-entry acquisition map. 27/27 smoke tests pass. **Writer migration completed 2026-04-08** — all four writers (rfq-writer, vq-writer, offer-writeback, cq-writer) now call `resolveMfrForRow({mfrText, mpn})` and gain MPN-inference fallback for missing-MFR rows.
- [x] **Packaging cog + factory policy + cq-writer Chuboe_Packaging_ID + distributor wiring (C9)** — promoted `normalizePackaging`/`PACKAGING_MAP` from vq-writer to new `shared/packaging-lookup.js`. Three-path factory policy fixed root bug (was always claiming F-* even on partials). cq-writer now writes `Chuboe_Packaging_ID` alongside text. DigiKey + Master wired (was missing). Audit confirmed Arrow/Future/Newark/Waldom/Rutronik don't expose usable packaging type. ~73% of franchise volume now auto-populates packaging at write time.

## Section D: Integration
*(No completed items yet)*

---

# Version History

| Date | Section | Changes |
|------|---------|---------|
| 2026-02-28 | C | VQ Parser initial release (70% parse rate) |
| 2026-03-01 | C | Flag validation fix (78%) |
| 2026-03-02 | C | Simple quote extraction, NoBid management (87%) |
| 2026-03-03 | C | RFQ matching window, vendor ID fix |
| 2026-03-03 | — | Consolidated roadmaps, organized by process flow |
| 2026-03-10 | B | B1 Cooldown tracking implemented (rfq_history.py + supplier template prioritization) |
| 2026-04-07 | C | C10 done: vq-writer auto-captures packaging + date code; C9 added (extract vqPackaging in 7 distributor modules) |

---

*Last updated: 2026-04-07*
