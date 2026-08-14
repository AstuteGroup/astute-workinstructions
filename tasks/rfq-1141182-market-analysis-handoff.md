# RFQ 1141182 UK Excess Stock - Market Availability Analysis

**Last Updated:** 2026-08-14
**Status:** Complete - v2 sent to Jake, awaiting feedback

---

## Summary

Completed market availability analysis for RFQ 1141182 (UK excess stock). Focus is on **supply position** (primary driver) with demand signals as context.

## Final Output

**File:** `/home/analytics_user/workspace/rfq-1141182-market-availability.xlsx`
**Script:** `/home/analytics_user/workspace/build-market-analysis-final.js`
**Sent to:** jake.harris@astutegroup.com (v2 - with garbled MPN filter)

### Results (2,113 clean parts after filtering 13 garbled MPNs)

| Tab | Parts | Description |
|-----|-------|-------------|
| T1 - ONLY SOURCE | 589 | No franchise, no broker competition - premium pricing |
| T2 - MARKET CONTROL | 220 | No franchise, 50%+ market share |
| T3 - BROKER COMP | 611 | No franchise, broker competition exists |
| T4 - FRANCHISE | 693 | Franchise stock available |
| EOL-OBSOLETE | 1 | Confirmed obsolete (FLZ3V9A pattern) |

### Top T1 Positions (ONLY SOURCE)
1. A0765928 (Nortel legacy) - 212,015 qty
2. CRCW0402HP100100K1 (Vishay) - 130,000 qty
3. MCP79412TSN (Microchip) - 118,800 qty
4. 885342211008 - 89,000 qty
5. PMEG201EA (Nexperia) - 87,000 qty

### Top T2 Positions (MARKET CONTROL)
1. MC6A702T2BK100 - 100% share, 300,000 qty
2. LD39100PURY - 100% share, 114,000 qty
3. 691322110006 - 99% share, 131,480 qty

---

## Methodology

### Tier Assignment (Supply Position)
- **T1 - ONLY SOURCE:** `franchise_qty = 0 AND broker_qty = 0`
- **T2 - MARKET CONTROL:** `franchise_qty = 0 AND our_pct >= 50%`
- **T3 - BROKER COMP:** `franchise_qty = 0 AND our_pct < 50%`
- **T4 - FRANCHISE:** `franchise_qty > 0`

### Data Sources
- **Broker VQs:** NC Profiler scrape (40,916 VQs loaded)
- **Franchise VQs:** API enrichment from 35 sources (Arrow, Future, TTI, Rutronik, Master, Sager, Newark, Mouser, DigiKey, Verical, etc.)
- **Demand signals:** 180-day RFQ history categorized by:
  - OEM/EMS: `iscustomer='Y' AND isvendor='N'` (excluding Chinese names)
  - US/EMEA Broker: `iscustomer='Y' AND isvendor='Y'` (excluding Chinese)
  - China: Names containing shenzhen, hong kong, co., ltd, etc.

### Data Quality Filters
**Garbled MPN detection** (`isGarbled()` function in script):
- MPNs > 25 chars without hyphens
- Contains descriptive words (DIODE, RESISTOR, CAPACITOR, etc.)
- Multiple MPN prefixes concatenated (e.g., two CRCW patterns)

**13 garbled MPNs excluded** from final output

### EOL Detection
- Pattern matching for known obsolete: `FLZ3V9`, `DO3316P-104`
- CalcuQuote API `Obsolete` field was null (not useful)
- Web search confirmed 2 obsolete parts

---

## User Feedback Incorporated (Session History)

1. **Market availability is primary driver** - not internal RFQ demand
2. **Don't overweight internal RFQs** - they indicate consumption but not market potential
3. **Demand categorization matters:**
   - OEM/EMS RFQs = direct customer demand (most valuable)
   - US/EMEA Broker = proxy for OEM demand
   - China = general market interest indicator
4. **Filter garbled MPNs** - concatenated part numbers are bad data (e.g., "CRCW0805680RFKEARC0805FR07680RL" is two resistor MPNs joined)
5. **A0765928 is valid** - old Nortel product, not garbled

---

## Files

| File | Purpose |
|------|---------|
| `build-market-analysis-final.js` | Main analysis script with garbled MPN filter |
| `rfq-1141182-market-availability.xlsx` | Final output file (v2) |
| `build-opportunity-analysis.js` | Earlier scoring-based version (deprecated) |
| `build-market-analysis-v4.js` / `v5.js` | Earlier iterations |

---

## To Regenerate

```bash
cd /home/analytics_user/workspace
node build-market-analysis-final.js
# Output: rfq-1141182-market-availability.xlsx
```

---

## Potential Follow-up

- Jake may want deeper analysis on specific T1/T2 parts
- Could expand EOL detection with more web searches on high-value T1 parts
- Could add pricing recommendations based on position
- May need to investigate the "?" manufacturers (missing mfr data)
- Consider adding a "Data Issues" tab to surface the 13 excluded garbled MPNs for cleanup

---

## Earlier Session Context (2026-08-13)

### VQ Loading (Earlier Session)
- Loaded 40,916 VQs from NC profiler scrape
- 91% BP coverage (37,245 with BP, 3,671 null)
- Fixed `resolveBP` in `shared/api-client.js` (suffix stripping, bidirectional matching)
- Added 20+ vendor aliases to `shared/data/vendor-aliases.json`

### Market Scarcity Analysis
**Market Depth Distribution:**
| Category | Parts | % |
|----------|-------|---|
| No broker availability | 14 | 0.7% |
| Single source (1 vendor) | 582 | 27% |
| Thin market (2-3 vendors) | 298 | 14% |
| Moderate (4-10 vendors) | 407 | 19% |
| Deep market (10+ vendors) | 825 | 39% |

**Key finding:** 880 parts (41%) are SCARCE (1-3 vendors) = pricing opportunity
