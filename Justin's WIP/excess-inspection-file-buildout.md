# Excess Inspection File Buildout

## Overview

This document describes the process for building out excess inspection log entries from a Purchase Order PDF. The workflow extracts part data from a PO document and populates the Excel inspection log with all required fields.

## Source Files

- **Input:** Purchase Order PDF (e.g., `POV0069002.pdf`)
- **Reference:** `Excess Inspection Log.xlsx` → "Excess POs" tab (for Site lookup)
- **Output:** `excess-inspection-buildout-<POV>.xlsx`

---

## End-to-End Workflow

### Step 1: Parse PDF for Line Items

Extract MPN and quantity from the PO. Format varies by consignment partner:

**Marvell format:**
```
Quantity Manufacturer MPN Date Code
5241 YAGEO RC0201FR-0710RL 2415
```

**GE Aviation format (Component Issued list):**
```
Component Issued
6292 2
009958-1 8
CRCW080510R0F 5000
```

**Note:** Date codes are ignored per business requirements.

### Step 2: Lookup Site from Excess POs Tab

**Do not skip this step.** Query the "Excess POs" tab in `Excess Inspection Log.xlsx` to get the Site:

```javascript
const ws = wb.Sheets['Excess POs'];
const data = XLSX.utils.sheet_to_json(ws);
const poRow = data.find(r => r['PO'] === 'POV0069002');
const site = poRow['Site (as needed)'] || '';
```

| PO | Site |
|----|------|
| POV0069002 | Long Island |
| POV0067609 | Plexus |
| POV0059837 | Grand Rapids |
| POV0061125 | Jacksonville |

### Step 3: Populate Base Fields

| Field | Source | Example |
|-------|--------|---------|
| Consignment Partner | PO header (Vendor) | GE Aviation |
| Site | Excess POs tab lookup | Long Island |
| PO | PO number from document | POV0069002 |
| Item | MPN from line item | CRCW080510R0F |
| Ordered | Quantity from line item | 5000 |
| U/M | Default | EA |

### Step 4: Identify Customer Internal Part Numbers

Customer internal P/Ns (not industry-standard MPNs) get special handling:

**Rules for internal P/Ns:**
- **Product Code:** `BTP`
- **Description:** Use the Item number itself
- **Name (MFR Code):** `M99999`

**Common patterns for GE Aviation internal P/Ns:**
- Pure numeric: `6292`, `10121`, `9626`
- Numeric with dash: `009958-1`, `010103-2`, `402845-3`
- Alphanumeric GE format: `145E2035-3`, `724E2302-1`, `4B4545-1`
- Other non-standard: `LS-204-B-N`, `MH-056`, `TU70-01`

### Step 5: Lookup MFR Code (Name Column)

For industry-standard MPNs, determine manufacturer from MPN prefix pattern:

| MPN Prefix | MFR Code | Manufacturer |
|------------|----------|--------------|
| CRCW | M11888 | VISHAY |
| C1206C, CK | M03110 | KEMET |
| 1206B103K | M03930 | MURATA |
| MC79L, MURA | M04180 | ON SEMICONDUCTOR |
| LM117, LM741 | M04095 | NATIONAL SEMICONDUCTOR |
| SMCJ, 30KPA | M03395 | LITTELFUSE |
| 16CTQ | M11888 | VISHAY |
| RC07 | M00224 | ALLEN BRADLEY |
| RLR07 | M11888 | VISHAY |
| WTA, WTAV | M06355 | WINCHESTER |

**For unknown manufacturers:** Use `M99999` for the Name field.

Query to lookup MFR codes:
```sql
SELECT value as mfr_code, name
FROM adempiere.chuboe_mfr
WHERE isactive = 'Y'
  AND value LIKE 'M%'
  AND UPPER(name) LIKE '%<MANUFACTURER>%';
```

**Additional Common MFR Codes:**
| Manufacturer | Code |
|--------------|------|
| YAGEO | M06441 |
| WALSIN | M06251 |
| TEXAS INSTRUMENTS | M05844 |
| PANASONIC | M04260 |
| MICROCHIP | M03611 |
| SAMSUNG | M06607 |

### Step 6: Lookup or Infer Description

Query `chuboe_rfq_line_mpn` for known descriptions:

```sql
SELECT DISTINCT r.chuboe_mpn, r.description
FROM adempiere.chuboe_rfq_line_mpn r
WHERE r.isactive = 'Y'
  AND r.description IS NOT NULL
  AND LENGTH(r.description) > 5
  AND r.chuboe_mpn = '<MPN>';
```

**If no DB match, infer from MPN pattern:**

| Pattern | Description |
|---------|-------------|
| CRCW0805* | RES THICK FILM 0805 |
| CRCW1206* | RES THICK FILM 1206 |
| CRCW2512* | RES THICK FILM 2512 |
| M39003*, M39014* | CAPACITOR MIL-SPEC |
| JAN*1N*, JANTX*1N* | DIODE MIL-SPEC |
| JAN*2N*, JANTX*2N* | TRANSISTOR MIL-SPEC |
| M38510* | IC MIL-SPEC |
| M55342* | RESISTOR FILM MIL-SPEC |
| NAS*, MS* | HARDWARE MIL-SPEC |
| SMCJ*, 30KPA* | DIODE TVS |
| MURA* | DIODE RECTIFIER ULTRA FAST |

**For customer internal P/Ns:** Use the Item number as the Description.

### Step 7: Assign Product Code

| Code | Category | Keywords/Rules |
|------|----------|----------------|
| PA | Passive | RES, RESISTOR, CAP, CAPACITOR, INDUCTOR, CRYSTAL |
| SC | Semiconductors | DIODE, TRANS, IC, MOSFET, REGULATOR, LDO |
| CO | Connectors | CONN, CONNECTOR, SPLICE |
| EM | Electromechanical | HARDWARE, NAS, MS, RELAY, SWITCH |
| LED | Optoelectronics | LED, DISPLAY |
| BTP | Customer Internal P/N | Non-standard part numbers (see Step 4) |

### Step 8: Export File

**Naming convention:** `excess-inspection-buildout-<POV>.xlsx`

Example: `excess-inspection-buildout-POV0069002.xlsx`

---

## Output Summary

### POV0069002 (GE Aviation - Long Island)

- **Total Rows:** 82
- **Product Code Breakdown:**
  - PA (Passive): 31 items
  - BTP (Internal P/N): 27 items
  - SC (Semiconductors): 16 items
  - EM (Electromechanical): 5 items
  - CO (Connectors): 3 items
- **MFR Coverage:** 26 known, 56 unknown (M99999)

### Sample Output

```
Partner      | Site        | PO          | Item              | Ordered | Description                   | Code | Name    | MFR
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
GE Aviation  | Long Island | POV0069002  | 6292              |       2 | 6292                          | BTP  | M99999  |
GE Aviation  | Long Island | POV0069002  | CRCW080510R0F     |    5000 | RES THICK FILM 0805           | PA   | M11888  | VISHAY
GE Aviation  | Long Island | POV0069002  | C1206C102J5GAC    |    7977 | CAP 1206 1000PF 5% 50WVDC NPO | PA   | M03110  | KEMET
GE Aviation  | Long Island | POV0069002  | MC79L12ABD        |    2329 | IC VOLTAGE REG NEGATIVE       | SC   | M04180  | ON SEMICONDUCTOR
GE Aviation  | Long Island | POV0069002  | SMCJ58A-E3/57T    |     850 | DIODE TVS                     | SC   | M03395  | LITTELFUSE
GE Aviation  | Long Island | POV0069002  | WTA20SACJTL       |       8 | CONNECTOR                     | CO   | M06355  | WINCHESTER
```

---

## Columns Not Populated

These columns are left blank and filled during inspection:
- **OTIN** - Assigned during receiving
- **Location** - Warehouse location after inspection

---

## Header Colors (Reference)

| Color | Columns | Purpose |
|-------|---------|---------|
| Grey (D9D9D9) | Consignment Partner, Site | Organizational |
| Blue (00B0F0) | PO, Ordered | POV Line creation |
| Green (92D050) | Item, Description, U/M, Product Code, Name, MFR | Item creation |
| Orange (FFC000) | OTIN, Location | Inspection/Receiving |

---

*Created: 2026-06-08*
*Updated: 2026-06-23 - Added GE Aviation workflow, Site lookup, BTP code, M99999 for unknown MFR*
