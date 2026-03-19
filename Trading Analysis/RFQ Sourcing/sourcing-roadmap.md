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
| C8 | MFR Text Validation | **Next** | Planned |

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

**Status:** Planned | **Priority:** Next

**Problem:** VQ Loading extracts `MFR Text` as freetext with no validation. Unlike Market Offer Upload (which validates `MFR_ID` against `mfr-aliases.json`), VQ uploads may fail or require manual cleanup when MFR Text doesn't map to a known manufacturer.

**Solution:**
- Prescreen MFR Text against manufacturer codes in iDempiere during extraction
- Reuse `mfr-aliases.json` from Market Offer workflow (already has common aliases like TI → Texas Instruments)
- Flag unrecognized manufacturers before upload, report in session summary

**Reference:** See `Trading Analysis/Market Offer Uploading/market-offer-uploading.md` "Manufacturer Matching (CRITICAL)" section for existing implementation pattern.

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

---

*Last updated: 2026-03-10*
