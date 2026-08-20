# Packaging Variant Expansion

**Status:** In Development
**Created:** 2026-08-17
**Owner:** Trading Analysis

## Overview

When sourcing parts, different packaging variants of the same base part (e.g., 7" reel vs 13" reel) are often interchangeable. This system expands MPN searches to include packaging variants, increasing hit rate on franchise APIs.

## Key Concepts

### Manufacturer Suffixes vs Distributor Packaging

| Concept | Example | Source |
|---------|---------|--------|
| **Manufacturer suffix** | `SN74LVC1G04DBVR` vs `DBVT` | Manufacturer assigns different MPNs for different packaging |
| **Distributor packaging** | "Cut Tape" vs "Tape & Reel" | Same MPN, distributor sells in different quantities |

**We care about manufacturer suffixes** - these are different MPNs we need to query separately on some APIs.

### Franchise API Types

| Type | Behavior | Strategy |
|------|----------|----------|
| **Type A (Discovery)** | Returns all related MPNs in one search | Use their response directly, learn patterns |
| **Type B (Exact Match)** | Only returns searched MPN | Generate variants from MFR rules, query each |

**Known Classifications:**
- DigiKey: Type A (keyword search returns variants)
- Mouser: Test pending (`exact: false` may enable discovery)
- Arrow: Test pending
- Others: Test pending

Run `node scripts/audit-franchise-variant-behavior.js` to classify APIs.

## Architecture

### MFR-Level Rules (Not MPN-Level)

Rules are stored per manufacturer, not per MPN:
- ~200 manufacturers × ~10 suffixes = ~2000 rules
- vs. millions of MPN-level variant mappings

```javascript
// Example rule structure
{
  'Texas Instruments': {
    suffixGroups: {
      REEL_SIZE: ['R', 'T'],      // R=7" reel, T=13" reel
    },
    suffixes: [
      { suffix: 'R', group: 'REEL_SIZE', packaging: 'TAPE_REEL_7' },
      { suffix: 'T', group: 'REEL_SIZE', packaging: 'TAPE_REEL_13' },
    ],
  }
}
```

### Query-Time Expansion

```javascript
const { expandPackagingVariants } = require('../shared/packaging-variants');

// Input: SN74LVC1G04DBVR, Texas Instruments
const variants = expandPackagingVariants('SN74LVC1G04DBVR', 'Texas Instruments');
// Output: ['SN74LVC1G04DBVR', 'SN74LVC1G04DBVT']
```

## Files

| File | Purpose |
|------|---------|
| `shared/packaging-variants.js` | Core module - expansion, detection, learning |
| `shared/data/mfr-suffix-rules.json` | Cached suffix rules (auto-generated) |
| `scripts/audit-franchise-variant-behavior.js` | Quarterly audit of API behavior |
| `scripts/discover-packaging-variants.js` | Discovery script (uses DigiKey API) |

## Quarterly Audit

**Schedule:** Run manually every 90 days (Jan 1, Apr 1, Jul 1, Oct 1)

**Purpose:** Detect if franchise APIs change behavior (Type A → Type B or vice versa)

**Command:**
```bash
node scripts/audit-franchise-variant-behavior.js
```

**Output:** `shared/data/franchise-variant-audit.json`

The audit:
1. Tests each franchise with known variant MPNs
2. Checks if related variants are returned
3. Compares to previous audit to detect changes
4. Logs `nextAuditDue` date

## Discovery Process

### Initial Seeding (DigiKey)

DigiKey's keyword search returns all related products. Use this to discover patterns:

```bash
# Run when API quota is available
node scripts/discover-packaging-variants.js --sample 100
```

This:
1. Queries DigiKey with sample MPNs
2. Captures all returned MPNs (before filtering)
3. Extracts suffix patterns per manufacturer
4. Updates `shared/data/mfr-suffix-rules.json`

### Continuous Learning

When enrichment runs, if a franchise returns variants we didn't expect:
```javascript
const { learnSuffixPattern } = require('../shared/packaging-variants');
learnSuffixPattern('Texas Instruments', 'T', 'REEL_SIZE', 'TAPE_REEL_13');
```

## Integration with Enrichment

### Restricted Manufacturers

Packaging variant expansion runs for ALL manufacturers, including restricted ones. We still want market intelligence on restricted parts - the restriction only applies at the **buying decision** (VQ creation), not at profiling.

```javascript
const { expandPackagingVariants } = require('../shared/packaging-variants');

// Expand variants for ALL MPNs (no restriction check here)
const variants = expandPackagingVariants(mpn, mfrName);

// Query franchises, capture data
// Restriction check happens later at VQ creation, not here
```

The restricted MFR check in `shared/restricted-mfrs.js` is applied downstream when creating VQs or making purchase decisions - not during market profiling.

### For Type A Franchises (DigiKey)

No change needed - they return variants automatically. Just capture and learn from their response.

### For Type B Franchises

Modify the enrichment loop:

```javascript
const { expandPackagingVariants } = require('../shared/packaging-variants');

// Before querying
const variants = expandPackagingVariants(mpn, mfr);

// Query each variant
for (const variant of variants) {
  const result = await searchPart(franchiseName, variant, qty);
  // ... collect results
}

// Pick best across all variants
```

## Common Suffix Patterns

### Texas Instruments
- `R` = 7" reel (2500-3000 pcs)
- `T` = 13" reel (10,000+ pcs)
- `E4` = RoHS compliant variant

### Analog Devices / Linear / Maxim
- `REEL` = 13" reel
- `REEL7` = 7" reel
- `RZ` = 7" reel (newer designation)

### Microchip / Atmel
- `-T` = Tape packaging
- `-R` = Reel packaging
- `-CT` = Cut tape

### Infineon / International Rectifier
- `PBF` = Lead-free (tube)
- `TRPBF` = Lead-free tape & reel

### STMicroelectronics
- `TR` = Tape & reel
- `TY` = Tape & reel (alternate)

## Roadmap

1. ✅ Create packaging-variants.js module (with verified MFR suffix rules)
2. ✅ Create audit script for API behavior (Type A vs Type B classification)
3. ✅ Create coverage gap analysis script (OT-driven prioritization)
4. ✅ Web scrape manufacturer ordering guides for top MFRs
5. ⬜ Run API audit when quota available (classify Mouser/Arrow)
6. ⬜ **Integrate into api-enrichment.js** (standard for ALL workflows)
   - Add `expandPackagingVariants()` call in `profileMpn()`
   - For Type A (DigiKey): query once, learn from response
   - For Type B: expand variants, query each, merge results
7. ⬜ Add more MFRs as needed (Yageo, TDK, AVX, Taiyo Yuden)
8. ⬜ Add quarterly audit reminder to session greeting
