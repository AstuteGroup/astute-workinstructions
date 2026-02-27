# RFQ Sourcing Automation Roadmap

This document tracks planned enhancements for full automation of the RFQ sourcing workflow.

---

## 1. LLM Description Scanning (Restrictions Detection)

**Status:** Planned

**Problem:** Some suppliers include restrictions in their listing descriptions that require human review:
- "RFQs for OEM & EMS only. NO Resellers!"
- "Factory sealed only"
- "Min order $500"

**Solution:**
- Quick scan of description field before supplier selection
- LLM-based classification: `restricted`, `warning`, `ok`
- Auto-skip restricted suppliers; flag warnings for review
- Track restriction patterns to build keyword blocklist over time

**Example Restrictions to Detect:**
- OEM/EMS only
- No resellers/brokers
- Export restrictions (ITAR, EAR)
- Minimum order requirements (beyond standard MOQ)
- Payment terms requirements

---

## 2. Cross-Region Duplicate Detection

**Status:** Planned

**Problem:** Same supplier inventory appears in multiple regions (e.g., Silicon Solutions Americas + Silicon Solutions Europe), leading to duplicate RFQs for the same stock.

**Solution:**
- Detect supplier name patterns across regions (company name + region suffix)
- Match by similar company names with different regional suffixes
- When duplicates found:
  - Select only one region (prefer closest/fastest shipping)
  - Or mark as "same inventory" to avoid double-counting qty

**Detection Patterns:**
- `CompanyName` + `Americas` / `Europe` / `Asia`
- `CompanyName Inc` / `CompanyName GmbH` / `CompanyName Ltd`
- Same contact email across regions

---

## 3. Supplier Fatigue Tracking

**Status:** Planned

**Problem:** Some suppliers get frustrated when bombarded with RFQs, especially when:
- High RFQ volume, low conversion rate
- Repeated RFQs for parts they rarely quote
- Multiple RFQs for same parts in short timeframe

**Solution:**
- Track RFQ history per supplier:
  - Total RFQs sent (30/60/90 day windows)
  - Response rate (quotes received / RFQs sent)
  - Conversion rate (orders / quotes)
- Apply fatigue scoring:
  - High fatigue = deprioritize or skip
  - Low response = reduce RFQ frequency
- Supplier preferences tracking:
  - "Chip 1 Exchange" - picky, send only high-value
  - "Commodity Components" - limit frequency
- Cooldown periods after rejection/no-response

**Data Sources:**
- NetComponents RFQ submission log
- Email responses (via VQ Loading)
- iDempiere PO/SO records

---

## 4. Alternate Packaging Analysis

**Status:** In Progress (basic normalization implemented)

**Problem:** Parts with different packaging suffixes are often interchangeable but listed separately:
- `LTC2446IUHF#TRPBF` (tape & reel, lead-free)
- `LTC2446IUHF#PBF` (tube/tray, lead-free)
- `LTC2446IUHF` (base part)

**Current Implementation:**
- Packaging suffix stripping in MPN normalization:
  - `-TR`, `-TRL`, `-TR500`, `-TR750` (tape & reel variants)
  - `#TRPBF` → `#PBF` normalization

**Planned Enhancements:**
- When exact MPN not found, automatically search packaging variants
- Present alternatives to user: "Part not found, but LTC2446IUHF#PBF available"
- Track packaging preferences per customer (some require specific packaging)
- Build packaging suffix database by manufacturer

**Common Packaging Suffixes:**
| Suffix | Meaning |
|--------|---------|
| -TR | Tape & Reel |
| -TRL | Tape & Reel, Left-hand |
| -CT | Cut Tape |
| -ND | No Documentation |
| #PBF | Lead-Free (RoHS) |
| #TRPBF | Tape & Reel, Lead-Free |
| /TR | Alternate tape & reel notation |

---

## 5. Memory Product Handling

**Status:** Planned

**Problem:** Memory ICs (DRAM, Flash, SRAM) have unique market dynamics:
- Higher price volatility
- Spot market pricing
- Specialized broker networks
- Different quality/authenticity concerns
- Shorter product lifecycles

**Solution:**
- Detect memory MPNs by prefix patterns:
  - **Micron:** MT (DRAM), N25Q (Flash)
  - **Samsung:** K4, K9 (DRAM/Flash)
  - **SK Hynix:** H5, HY (DRAM)
  - **Winbond:** W25, W29 (Flash)
  - **ISSI:** IS42, IS61 (DRAM/SRAM)
  - **Nanya:** NT (DRAM)

- Apply different sourcing criteria:
  - Check memory spot pricing sources (DRAMeXchange, Inspot)
  - Query memory-specific broker networks
  - Higher price volatility tolerance in scoring
  - Different lead time expectations
  - Enhanced COC/authenticity requirements

- Memory-specific scoring adjustments:
  - Date code less critical (shorter lifecycles)
  - Pricing benchmarks vs spot market
  - Supplier memory specialization rating

---

## 6. Franchise Pricing & Availability via API

**Status:** Planned

**Problem:** Currently scraping FindChips for franchise data - fragile, rate-limited, and we discard the detail after screening.

**Solution:**
- Replace FindChips scraping with direct API feeds from authorized distributors
- Capture full pricing and availability data per distributor
- Store for downstream use (Quick Quote, negotiation leverage, market validation)

**Target APIs:**
- **Octopart API** - Aggregated pricing across distributors
- **DigiKey API** - Direct pricing and stock
- **Mouser API** - Direct pricing and stock
- **Arrow API** - Direct pricing and stock
- **Newark/Farnell API** - Direct pricing and stock

**Data to Capture:**
```json
{
  "mpn": "LM358N",
  "queried_at": "2026-02-27T15:30:00Z",
  "distributors": [
    {"name": "DigiKey", "qty": 5000, "price_1": 0.45, "price_100": 0.38, "price_1000": 0.32, "lead_time": "In Stock"},
    {"name": "Mouser", "qty": 3200, "price_1": 0.44, "price_100": 0.37, "price_1000": 0.31, "lead_time": "In Stock"}
  ],
  "lowest_bulk_price": 0.31,
  "total_franchise_qty": 8200
}
```

**Benefits:**
- Eliminates FindChips scraping entirely
- Real-time pricing (no stale cache)
- Higher rate limits / no blocking
- Richer data (lead times, MOQs, packaging options)

---

## Implementation Priority

| # | Feature | Impact | Effort | Priority |
|---|---------|--------|--------|----------|
| 1 | Alternate Packaging | High | Low | **Now** (basic done) |
| 2 | LLM Description Scanning | High | Medium | **Next** |
| 3 | Franchise Pricing via API | High | Medium | Q2 |
| 4 | Memory Product Handling | Medium | Medium | Q2 |
| 5 | Cross-Region Duplicates | Medium | Low | Q2 |
| 6 | Supplier Fatigue | High | High | Q3 |

---

## Completed Enhancements

- [x] Header row detection fix (cell count method)
- [x] Supplier link finding (table column 15)
- [x] "24+" date codes scored as fresh
- [x] Quantity tiebreaker only when below requested qty
- [x] Coverage-based selection
- [x] Cross-region balancing
- [x] Min order value filtering
- [x] Basic MPN packaging normalization

---

*Last updated: 2026-02-27*
