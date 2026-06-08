# Excess Inspection File Buildout

## Overview

This document describes the process for building out excess inspection log entries from a Purchase Order PDF. The workflow extracts part data from a PO document and populates the Excel inspection log with all required fields.

## Source Files

- **Input PDF:** `POV0072702.pdf` (Marvell Asia Pte Ltd purchase order)
- **Output Excel:** `Excess Inspection Log_claude.xlsx`
- **Target Sheet:** `POV0072702`

## Data Extraction Process

### Step 1: Parse PDF for Line Items

Extract quantity, manufacturer, and MPN from the PO line items. The PDF format is:
```
Quantity Manufacturer MPN Date Code
5241 YAGEO RC0201FR-0710RL 2415
4927 WALSIN WR02X22R0FAL 42059
```

**Note:** Date codes are ignored per business requirements.

### Step 2: Populate Base Fields

| Field | Source | Example |
|-------|--------|---------|
| Consignment Partner | PO header (Vendor) | Marvell |
| Site | Leave blank unless specified | |
| PO | PO number from document | POV0072702 |
| Item | MPN from line item | RC0201FR-0710RL |
| Ordered | Quantity from line item | 5241 |
| U/M | Default | EA |

### Step 3: Lookup MFR Code (Name Column)

Query the `chuboe_mfr` table for the Infor manufacturer code:

```sql
SELECT name, value
FROM adempiere.chuboe_mfr
WHERE isactive = 'Y'
  AND value LIKE 'M%'
  AND UPPER(name) LIKE '%<MANUFACTURER>%';
```

**Common MFR Codes:**
| Manufacturer | Code |
|--------------|------|
| YAGEO | M06441 |
| WALSIN | M06251 |
| TEXAS INSTRUMENTS | M05844 |
| CHILISIN | M01106 |
| VISHAY | M11888 |
| ON SEMICONDUCTOR / ONSEMI | M04148 |
| PANASONIC | M04260 |
| KOA | M03189 |
| MICROCHIP | M03611 |
| MURATA | M03930 |
| SAMSUNG | M06607 |
| WINBOND | M06361 |
| MPS (Monolithic Power Systems) | M03884 |
| AVNET | M00599 |
| TXC CORPORATION | M06017 |
| SEI | M05127 |

### Step 4: Lookup Description

Query `chuboe_rfq_line_mpn` for part descriptions:

```sql
SELECT DISTINCT chuboe_mpn, description
FROM adempiere.chuboe_rfq_line_mpn
WHERE isactive = 'Y'
  AND description IS NOT NULL
  AND LENGTH(description) > 5
  AND chuboe_mpn = '<MPN>';
```

If no match found, descriptions can be inferred from the MPN pattern:
- `RC####` or `RES` = Resistor
- `CC####` or `CAP` = Capacitor
- `MHCB`, `MHCI` = Inductor
- `TPS`, `CSD`, `NCP` = IC/Semiconductor

### Step 5: Assign Product Code

Based on the description, assign the appropriate product code from the Key sheet:

| Code | Category | Keywords |
|------|----------|----------|
| PA | Passive | RES, RESISTOR, CAP, CAPACITOR, INDUCTOR, CRYSTAL |
| SC | Semiconductors | MOSFET, IC, TRANSISTOR, CONVERTER, REGULATOR, LDO |
| CO | Connectors | CONN, CONNECTOR |
| EM | Electromechanical | RELAY, SWITCH |
| LED | Optoelectronics | LED, DISPLAY |
| PO | Power | POWER |
| TBC | Unknown | (default if no match) |

### Step 6: Apply Header Colors

Apply colors matching the Key sheet legend:
- **Grey (D9D9D9):** Consignment Partner, Site (organizational)
- **Blue (00B0F0):** PO, Ordered (POV Line creation)
- **Green (92D050):** Item, Description, U/M, Product Code, Name, MFR (Item creation)
- **Orange (FFC000):** OTIN, Location (Inspection/Receiving)

## Output Summary

**POV0072702 Results:**
- **Total Rows:** 84
- **Product Code Breakdown:**
  - PA (Passive): 53 items
  - SC (Semiconductors): 31 items
- **All MFR codes found:** Yes
- **All descriptions populated:** Yes

## Sample Output

```
Partner   | PO          | Item                | Qty   | Description                  | U/M | Code | Name   | MFR
Marvell   | POV0072702  | RC0201FR-0710RL     | 5241  | RES 10 OHM 1% 1/20W 0201     | EA  | PA   | M06441 | YAGEO
Marvell   | POV0072702  | WR02X22R0FAL        | 4927  | RES 22 OHM 1% 1/20W 0201     | EA  | PA   | M06251 | WALSIN
Marvell   | POV0072702  | CC0402JRNPO9BN270   | 9024  | CAP CER 27PF 5% 50V C0G 0402 | EA  | PA   | M06441 | YAGEO
Marvell   | POV0072702  | TPS73601DBVR        | 999   | IC LDO REG 400MA SOT23-5     | EA  | SC   | M05844 | TEXAS INSTRUMENTS
Marvell   | POV0072702  | CSD16321Q5          | 5000  | MOSFET N-CH 25V 100A 8-SON   | EA  | SC   | M05844 | TEXAS INSTRUMENTS
```

## Columns Not Populated

These columns are left blank and filled during inspection:
- **OTIN** - Assigned during receiving
- **Location** - Warehouse location after inspection

---

*Created: 2026-06-08*
