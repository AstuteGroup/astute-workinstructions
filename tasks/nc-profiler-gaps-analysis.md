# NC Profiler Data Gap Analysis - RFQ 1141182

**Date:** 2026-08-14
**Related RFQ:** 1141182 (UK Excess Stock)
**Scrape Date:** 2026-08-10

---

## Summary

Of 2,126 parts in RFQ 1141182, **614 parts (29%)** have ONLY Astute Electronics as the supplier in the NC Profiler scrape results. This analysis investigates why.

---

## Root Cause: Scraper Design Filters

The NC Profiler (`batch_rfqs_from_system.py` --check-only mode) intentionally excludes several inventory sources:

### 1. **Asia/Other Region Excluded** (Line 247)
```python
if not in_stock_section or current_region == 'Asia/Other':
    continue
```
- Any broker based in Asia, China, Hong Kong, etc. is not captured
- This is by design (focus on Americas/Europe)

### 2. **"Brokered" Inventory Excluded** (Lines 238-241)
```python
if 'in stock' in row_text or 'in-stock' in row_text:
    in_stock_section = True
elif 'brokered' in row_text:
    in_stock_section = False
```
- NetComponents distinguishes "In Stock" vs "Brokered" inventory
- "Brokered" = supplier can source but doesn't have physical stock
- The scraper ONLY captures "In Stock" inventory
- Brokers listing parts as "Brokered" are skipped

### 3. **Franchise Distributors Excluded** (Lines 258-263)
```python
auth_icon = await supplier_cell.query_selector('.ncauth')
if auth_icon:
    continue
```
- Franchised/authorized distributors (DigiKey, Mouser, Arrow, etc.) are marked with `ncauth` class
- These are intentionally skipped because franchise data comes from API enrichment
- This explains why DigiKey stock wasn't in the scrape for NCP1060AD060R2G

---

## Analysis of 614 Astute-Only Parts

### Patterns Observed

| Pattern | Count | % | Implication |
|---------|-------|---|-------------|
| All Numeric | 74 | 12.1% | Likely proprietary/internal PNs |
| Starts with Letter | 437 | 71.2% | Standard MPN format |
| Very Long (>25 chars) | 3 | 0.5% | Possible concatenated/garbled |
| Europe Region Only | 614 | 100% | Astute UK is Europe-based |
| Full Qty Coverage | 614 | 100% | Astute has stock for full request |

### Sample Astute-Only MPNs
```
338201, 856378, 856733, 1025695, 1056394, 1446312, 1759363,
4083071, 6859304, 7918574, 7918575, 9009694, 10103320
```

Many appear to be numeric part codes (possibly proprietary/internal) that are less likely to have widespread broker availability.

---

## Spot-Check Validation

User spot-checked 3 parts against live NetComponents:

| MPN | Scrape Result | Live NC | Issue |
|-----|---------------|---------|-------|
| MC6A702T2BK100 | CVC 83, Astute 300K, Auxilio 200 | Same | **No issue** (null BP JOIN fixed) |
| TLV9101SIDBVR | Astute only | 2952 from another broker | **Gap** - broker missing |
| NCP1060AD060R2G | Astute + Askoll 222 | DigiKey has stock | DigiKey is franchise (by design) |

**2 of 3** spot-checks showed expected behavior (franchise exclusion, data present). **1 of 3** (TLV9101SIDBVR) shows a real gap.

---

## Possible Causes for TLV9101SIDBVR Gap

1. **Timing** - Broker stock appeared after Aug 10 scrape
2. **Region** - Broker is Asia-based (filtered out)
3. **Listing Type** - Broker listed as "Brokered" not "In Stock"
4. **MPN Variant** - Listed under slightly different MPN

---

## Recommendations

### Short-term (Current Analysis)
1. **Accept the 614 Astute-only parts as T1 candidates** - The scraper found no competing broker inventory in Americas/Europe with physical stock
2. **Note in handoff** - These may have additional Asia-based or "brokered" availability not captured

### Medium-term (Profiler Enhancements)
1. Consider adding "Brokered" inventory capture (with flag to distinguish from "In Stock")
2. Consider adding Asia region capture (with flag for COO/logistics concerns)
3. Add metadata about what was filtered (e.g., "3 Asia suppliers skipped")

### Data Quality
The 614 Astute-only parts are likely a mix of:
- **True scarce parts** - Astute genuinely has exclusive broker stock
- **Obscure/proprietary parts** - Low market presence beyond original inventory holder
- **Gaps in coverage** - Some broker stock not captured due to filters

---

## Technical Details

### Scraper Filtering Logic
```
batch_rfqs_from_system.py --check-only mode:

1. Search NetComponents for MPN
2. Parse results table
3. Filter: Region != Asia/Other
4. Filter: Section = "In Stock" (not "Brokered")
5. Filter: Not franchised (no .ncauth class)
6. Aggregate by supplier
7. Record results with status='SCRAPED'
```

### Results File
- **Location:** `RFQ_1141182/Results_2026-08-10_153907.xlsx`
- **Total Rows:** 39,808
- **Unique MPNs:** 2,126
- **Unique Suppliers:** 893 brokers captured

---

## Files

| File | Purpose |
|------|---------|
| `batch_rfqs_from_system.py` | Scraper script (--check-only mode for profiling) |
| `config.py` | Filtering configuration (region limits, DC preferences) |
| `Results_2026-08-10_153907.xlsx` | Raw scrape output |
| `analyze-scrape-gaps.js` | Analysis script for this investigation |
