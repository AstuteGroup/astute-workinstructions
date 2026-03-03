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
- `rfq_sourcing/` — Franchise screening + NetComponents RFQ submission
- `vq-parser/` (separate repo) — Quote email parsing

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
| B1 | Supplier Selection Deduplication | **Now** | Not implemented |
| B2 | No-Bid Filtering | **Now** | Planned |
| B3 | Supplier Fatigue Tracking | **Next** | Planned |
| B4 | LLM Description Scanning | Later | Planned |
| B5 | Cross-Region Duplicate Detection | Later | Planned |
| B6 | Alternate Packaging Analysis | Later | In Progress |
| B7 | Memory Product Handling | Later | Planned |

---

## B1. Supplier Selection Deduplication

**Status:** Not implemented | **Priority:** Now

**Problem:** We sometimes send RFQs to the same supplier for the same MPN multiple times within a short window:
- Wastes supplier time
- Annoys suppliers who already quoted or declined
- Contributes to supplier fatigue

**Solution:**

Before sending RFQ to supplier, check:
```
IF (Supplier + MPN) requested within last X days → SKIP
```

**Configurable windows:**
| Scenario | Window |
|----------|--------|
| Default | 14 days |
| Supplier responded with quote | 30 days |
| Supplier said no-bid | 90 days |
| Urgent/override | 0 (always send) |

**Data Structure:**
```json
{
  "rfqHistory": [
    {
      "vendorSearchKey": "V12345",
      "mpn": "LTC2446IUHF#PBF",
      "rfqDate": "2026-03-01",
      "rfqId": "1130500",
      "response": "quoted" | "no-bid" | "pending"
    }
  ]
}
```

**Integration:**
- NetComponents RFQ submission (check before sending)
- VQ Parser (update `response` status when quote received)
- No-Bid tracking (update when no-bid detected)

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

## B6. Alternate Packaging Analysis

**Status:** In Progress | **Priority:** Later

**Problem:** Parts with different packaging suffixes are often interchangeable:
- `LTC2446IUHF#TRPBF` (tape & reel, lead-free)
- `LTC2446IUHF#PBF` (tube/tray, lead-free)

**Current Implementation:**
- Packaging suffix stripping in MPN normalization
- `-TR`, `-TRL`, `-TR500`, `-TR750` handling
- `#TRPBF` → `#PBF` normalization

**Planned:**
- When exact MPN not found, search packaging variants
- Present alternatives to user
- Track packaging preferences per customer

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

---

*Last updated: 2026-03-03*
