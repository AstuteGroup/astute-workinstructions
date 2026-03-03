# Sourcing Automation Roadmap

Consolidated roadmap for RFQ Sourcing and VQ Processing workflows.

**Workflow Tags:**
- `[RFQ]` — RFQ Sourcing (franchise screening, supplier selection, NetComponents submission)
- `[VQ]` — VQ Processing (quote email parsing, RFQ matching, ERP upload)
- `[BOTH]` — Spans both workflows

---

## Process Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SOURCING WORKFLOW                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌───────────┐ │
│  │  Franchise   │───▶│    RFQ       │───▶│     VQ       │───▶│   ERP     │ │
│  │  Screening   │    │   Sourcing   │    │   Parsing    │    │  Upload   │ │
│  └──────────────┘    └──────────────┘    └──────────────┘    └───────────┘ │
│       [RFQ]              [RFQ]               [VQ]               [VQ]        │
│                                                                              │
│  FindChips check     NetComponents       Email parsing      iDempiere VQ    │
│  Filter low-value    Submit RFQs         Extract quotes     Mass upload     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Repos:**
- `rfq_sourcing/` — Franchise screening + NetComponents RFQ submission
- `vq-parser/` (separate repo) — Quote email parsing

---

## Current State (2026-03-03)

| Metric | Value | Workflow |
|--------|-------|----------|
| VQ Parse rate | 87% | [VQ] |
| VQ Vendor match rate | 96% | [VQ] |
| VQ NoBid recovery rate | 83% | [VQ] |
| Franchise screening | Operational | [RFQ] |
| NetComponents RFQ submission | Operational | [RFQ] |

---

## 1. Supplier Selection Deduplication `[RFQ]`

**Status:** Not implemented

**Problem:** We sometimes send RFQs to the same supplier for the same MPN multiple times within a short window:
- Wastes supplier time
- Annoys suppliers who already quoted or declined
- Contributes to supplier fatigue

**Solution:**

### 1.1 Same-Part Cooldown Window
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

### 1.2 Data Structure
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

### 1.3 Integration Points
- NetComponents RFQ submission (check before sending)
- VQ Parser (update `response` status when quote received)
- No-Bid tracking (update when no-bid detected)

---

## 2. RFQ Matching Window `[VQ]`

**Status:** ✅ Implemented (2026-03-03)

**Problem:** Old RFQs with thousands of parts were catching unrelated quotes. A quote for MPN "ABC123" might match an RFQ from 6 months ago instead of the recent one.

**Solution Implemented:**
- 14-day date window for RFQ matching
- Exact MPN match → fuzzy match → flag as `[NEEDS_RFQ]`
- Output uses RFQ's MPN (not vendor's quoted MPN)
- Differences noted in `chuboe_note_public`

**Logic:**
```
IF quote received for MPN
  → Find RFQs containing that MPN from last 14 days
  → If multiple matches, use most recent
  → If no match, flag for manual RFQ assignment
```

---

## 3. Supplier Fatigue Tracking `[RFQ]`

**Status:** Planned

**Problem:** Some suppliers get frustrated when bombarded with RFQs:
- High RFQ volume, low conversion rate
- Repeated RFQs for parts they rarely quote
- Multiple RFQs for same parts in short timeframe

**Solution:**

### 3.1 Fatigue Scoring
Track per supplier:
- Total RFQs sent (30/60/90 day windows)
- Response rate (quotes received / RFQs sent)
- Conversion rate (orders / quotes)
- Average response time

### 3.2 Fatigue Actions
| Fatigue Level | Action |
|---------------|--------|
| Low (healthy) | Normal RFQ flow |
| Medium | Reduce frequency, prioritize high-value |
| High | Skip or flag for manual review |
| Blocked | Supplier requested no more RFQs |

### 3.3 Supplier Preferences
Track known preferences:
- "Chip 1 Exchange" — picky, send only high-value
- "Commodity Components" — limit to 5/week
- "OEM-only suppliers" — skip for resale RFQs

### 3.4 Cooldown Periods
- After no-response: 7-day cooldown
- After no-bid: 14-day cooldown for same MPN
- After complaint: Manual review required

**Data Sources:**
- NetComponents RFQ submission log
- Email responses (via VQ Parser)
- iDempiere PO/SO records

---

## 4. No-Bid Tracking `[BOTH]`

**Status:** Partially implemented

**Problem:** We repeatedly request quotes from suppliers who can't provide certain parts.

### 4.1 No-Bid Detection `[VQ]`
- ✅ Detects: "out of stock", "cannot quote", "not available"
- ✅ Creates CSV with NO-BID flag
- ✅ Moves to Processed folder

### 4.2 No-Bid Database `[BOTH]`
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

### 4.3 No-Bid Filtering `[RFQ]`
- Before sending RFQ: check no-bid history
- If vendor said "no" to MPN within 90 days → skip or flag
- Quarterly cleanup: expire old no-bids (suppliers restock)

---

## 5. LLM Description Scanning `[RFQ]`

**Status:** Planned

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

## 6. Cross-Region Duplicate Detection `[RFQ]`

**Status:** Planned

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

## 7. Alternate Packaging Analysis `[RFQ]`

**Status:** In Progress (basic normalization implemented)

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

## 8. Memory Product Handling `[RFQ]`

**Status:** Planned

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

## 9. Franchise Pricing via API `[RFQ]`

**Status:** Planned

**Problem:** Currently scraping FindChips — fragile, rate-limited.

**Solution:**
- Replace with direct API feeds (Octopart, DigiKey, Mouser, Arrow)
- Capture full pricing and availability
- Store for Quick Quote and negotiation

---

## 10. VQ Parser Improvements `[VQ]`

### 10.1 Parser Bugs
- [ ] Multi-row table header extraction bug
- [ ] MPN bleeding into price field (NUP2105 → $2105)

### 10.2 Vendor-Specific Templates
Target vendors with high failure rates:
- OzDizan
- Inelco
- Galco
- ECOMAL (CID image references in emails)

### 10.3 Attachment Handling
- [ ] Increase PDF timeout (15s → 30s)
- [ ] Detect "see attachment" and skip body parsing
- [ ] Better pdf.js-extract for complex tables

### 10.4 Retry Tracking
- Track parse attempts per email
- Skip if already tried with current parser version
- Move to ParseFailed after 3 failures

---

## 11. LLM Fallback for VQ Parsing `[VQ]`

**Status:** Planned (currently disabled)

**Use Cases:**
- Low-confidence parses (< 0.6)
- Informal prose quotes
- Multi-line quote analysis

**Cost-Benefit:**
- API cost: ~$0.01-0.05 per email
- Benefit: 10-15% additional parse rate
- Decision: Enable for high-value RFQs or after 2 failed attempts

---

## 12. Integration & Automation `[BOTH]`

### 12.1 iDempiere Integration `[VQ]`
- Direct VQ upload via API
- Validate before upload
- Error handling and rollback

### 12.2 Scheduling `[BOTH]`
- Daily: Fetch emails, parse, consolidate
- Weekly: Reprocess NeedsReview folder
- Monthly: Review ParseFailed, expire old no-bids

### 12.3 Notifications `[BOTH]`
- HIGH_COST items (> $1000)
- High partial rate (> 30%)
- Parsing failure spikes
- Supplier fatigue alerts

---

## 13. Reporting & Analytics `[BOTH]`

### 13.1 Parse Rate Dashboard `[VQ]`
- Daily/weekly trends
- Vendor-specific rates
- Strategy success (HTML vs regex vs PDF)

### 13.2 Vendor Performance `[BOTH]`
- Response time
- Quote completeness
- No-bid rate
- Price competitiveness

### 13.3 RFQ Efficiency `[RFQ]`
- RFQs sent vs quotes received
- Conversion to orders
- Supplier fatigue trends

---

## Implementation Priority

| # | Feature | Workflow | Impact | Effort | Priority |
|---|---------|----------|--------|--------|----------|
| 1 | Supplier Selection Deduplication | [RFQ] | High | Medium | **Now** |
| 2 | RFQ Matching Window | [VQ] | High | Low | ✅ Done |
| 3 | No-Bid Tracking (full) | [BOTH] | High | Low | **Now** |
| 4 | Supplier Fatigue | [RFQ] | High | High | **Next** |
| 5 | LLM Description Scanning | [RFQ] | High | Medium | Q2 |
| 6 | Parser Bug Fixes | [VQ] | Medium | Low | Q2 |
| 7 | Vendor Templates | [VQ] | Medium | Medium | Q2 |
| 8 | Franchise API | [RFQ] | High | Medium | Q2 |
| 9 | Cross-Region Duplicates | [RFQ] | Medium | Low | Q2 |
| 10 | Memory Handling | [RFQ] | Medium | Medium | Q3 |
| 11 | LLM VQ Fallback | [VQ] | Medium | Low | Q3 |
| 12 | iDempiere Integration | [VQ] | High | High | Q3 |
| 13 | Scheduling/Automation | [BOTH] | Medium | Medium | Q4 |

---

## Completed

### RFQ Sourcing `[RFQ]`
- [x] Header row detection fix
- [x] Supplier link finding (table column 15)
- [x] "24+" date codes scored as fresh
- [x] Quantity tiebreaker only when below requested qty
- [x] Coverage-based selection
- [x] Cross-region balancing
- [x] Min order value filtering
- [x] Basic MPN packaging normalization

### VQ Processing `[VQ]`
- [x] NoBid folder cleanup
- [x] Flag validation fix
- [x] Simple quote extraction
- [x] Domain-based vendor lookup
- [x] Fuzzy name matching
- [x] Automatic flag stripping in consolidate
- [x] 14-day RFQ matching window
- [x] Vendor ID correction (search_key vs c_bpartner_id)

---

## Version History

| Date | Component | Changes |
|------|-----------|---------|
| 2026-02-28 | [VQ] | Initial release (70% parse rate) |
| 2026-03-01 | [VQ] | Flag validation fix (78%) |
| 2026-03-02 | [VQ] | Simple quote extraction, NoBid management (87%) |
| 2026-03-03 | [VQ] | RFQ matching window, vendor ID fix |
| 2026-03-03 | [BOTH] | Consolidated roadmaps |

---

*Last updated: 2026-03-03*
