# Database Schema - MI KPI Tracker

Database schema reference for Material Inspection KPI automation.

## Overview

**Database:** `idempiere_replica` (PostgreSQL)
**Schema:** `adempiere`
**Access Required:** Read-only (SELECT)

---

## Primary Tables

### 1. chuboe_po_userpick
**Purpose:** Tracks when inspectors pick parts for inspection

**Key Fields:**
```sql
chuboe_po_userpick
├── chuboe_insp_lot_id    -- Links to inspection lot (FK)
├── chuboe_po_pickeduser_id -- Inspector user ID (FK to ad_user)
├── startdate             -- When pick occurred (TIMESTAMP)
└── isactive              -- Y/N (only Y records are counted)
```

**Usage:**
- Determines which OTINs were picked in target month
- First pick date determines month attribution
- Multiple picks per OTIN = handoffs/rework (tracked but deduplicated)

**Sample Query:**
```sql
SELECT
    pick.chuboe_insp_lot_id,
    MIN(pick.startdate) AS first_pick_date
FROM adempiere.chuboe_po_userpick pick
WHERE pick.startdate >= '2026-05-01'
  AND pick.startdate < '2026-06-01'
  AND pick.isactive = 'Y'
GROUP BY pick.chuboe_insp_lot_id;
```

---

### 2. chuboe_insp_mpnlot_v
**Purpose:** View containing OTIN and part information

**Key Fields:**
```sql
chuboe_insp_mpnlot_v
├── chuboe_insp_lot_id    -- Primary key / lot identifier
├── chuboe_otin_search    -- OTIN number (searchable format)
├── mfr_name              -- Manufacturer name
└── mpn                   -- Manufacturer Part Number
```

**Usage:**
- Links pick sessions to specific OTINs
- Provides part identification for reporting
- Used for OTIN counting (distinct OTINs)

**Sample Query:**
```sql
SELECT
    v.chuboe_otin_search AS otin,
    v.chuboe_insp_lot_id
FROM adempiere.chuboe_insp_mpnlot_v v
WHERE v.chuboe_insp_lot_id IN (picked_lot_ids);
```

---

### 3. chuboe_insp_lot_lnk
**Purpose:** Links inspection lots to specific inspection types

**Key Fields:**
```sql
chuboe_insp_lot_lnk
├── chuboe_insp_lot_id    -- Lot identifier (FK)
├── chuboe_insp_id        -- Inspection type ID (FK to chuboe_insp)
└── isactive              -- Y/N (only Y records are counted)
```

**Usage:**
- Determines which inspection types were performed on each OTIN
- Multiple records per OTIN = multiple inspection types (base + additional)
- Critical for Additional Inspection tracking

**Sample Query:**
```sql
SELECT
    lnk.chuboe_insp_lot_id,
    lnk.chuboe_insp_id
FROM adempiere.chuboe_insp_lot_lnk lnk
WHERE lnk.chuboe_insp_lot_id = '12345'
  AND lnk.isactive = 'Y';
```

---

### 4. chuboe_insp
**Purpose:** Inspection types and definitions

**Key Fields:**
```sql
chuboe_insp
├── chuboe_insp_id        -- Primary key
├── name                  -- Inspection type name
└── description           -- Inspection details
```

**Inspection Types (Base Tiers):**
- `'Tier 1 Passive Inspection'` → Weight: 0.75
- `'Tier 1 Active Inspection'` → Weight: 1.0
- `'Tier 1 Inspection'` → Weight: 1.0 (same as Active)
- `'MASTER OTIN reference'` → Weight: 0.5
- `'Tier 2 Inspection'` → Weight: 2.0
- `'Tier 3 Inspection'` → Weight: 3.0
- `'AS6171'` → Weight: 4.0

**Inspection Types (Additional - All +0.2):**
- Contains `'Decapsulation'`
- Contains `'Solderability'`
- Contains `'SEM'`
- Contains `'Scrape'`
- Contains `'Destructive Sampling'`
- Contains `'Non-conforming'`

**Usage:**
- Maps inspection IDs to human-readable names
- Determines KPI weights via CASE logic in scripts
- Additional Inspections identified by partial name match (LIKE)

**Sample Query:**
```sql
SELECT
    i.chuboe_insp_id,
    i.name,
    CASE
        WHEN i.name = 'Tier 1 Passive Inspection' THEN 0.75
        WHEN i.name = 'Tier 2 Inspection' THEN 2.0
        WHEN i.name LIKE '%Decapsulation%' THEN 0.2
        -- ... etc
    END AS weight
FROM adempiere.chuboe_insp i;
```

---

### 5. chuboe_insp_datelotcode
**Purpose:** Date codes and lot codes for inspected parts

**Key Fields:**
```sql
chuboe_insp_datelotcode
├── chuboe_insp_lot_id    -- Lot identifier (FK)
├── chuboe_insp_id        -- Inspection type ID (FK)
├── datecode              -- Date code value
├── lotcode               -- Lot code value
└── isactive              -- Y/N
```

**Usage:**
- Used to calculate DC/LC Count (distinct date/lot codes)
- Priority: Count distinct lot codes if present, else count distinct date codes
- Falls back to 1 if neither exists

**DC/LC Count Logic:**
```sql
CASE
    WHEN COUNT(DISTINCT NULLIF(dlc.lotcode, '')) > 0
    THEN COUNT(DISTINCT NULLIF(dlc.lotcode, ''))
    ELSE COALESCE(COUNT(DISTINCT NULLIF(dlc.datecode, '')), 1)
END AS dclc_count
```

**Sample Query:**
```sql
SELECT
    dlc.chuboe_insp_lot_id,
    dlc.chuboe_insp_id,
    COUNT(DISTINCT NULLIF(dlc.lotcode, '')) AS lot_count,
    COUNT(DISTINCT NULLIF(dlc.datecode, '')) AS date_count
FROM adempiere.chuboe_insp_datelotcode dlc
WHERE dlc.chuboe_insp_lot_id = '12345'
  AND dlc.isactive = 'Y'
GROUP BY dlc.chuboe_insp_lot_id, dlc.chuboe_insp_id;
```

---

### 6. ad_user
**Purpose:** User information for inspectors

**Key Fields:**
```sql
ad_user
├── ad_user_id            -- Primary key
└── name                  -- User's full name
```

**Austin Inspectors:**
```sql
WHERE name IN (
    'Jacob DeWit',
    'Daisy Mendoza',
    'Ofelio Martinez',
    'Juan Serrano',
    'Jacob Palmertree',
    'Sharanya Sarkar'
)
```

**Usage:**
- Links pick records to specific inspectors
- Used for individual performance tracking
- Filter determines which site's data is included

---

## Table Relationships

```
ad_user
  ↓ (via chuboe_po_pickeduser_id)
chuboe_po_userpick
  ↓ (via chuboe_insp_lot_id)
chuboe_insp_mpnlot_v  ←→  chuboe_insp_lot_lnk
  ↓                          ↓ (via chuboe_insp_id)
chuboe_insp_datelotcode    chuboe_insp
```

**Data Flow:**
1. Inspector picks part → `chuboe_po_userpick` record created
2. Pick links to lot → `chuboe_insp_lot_id` in `chuboe_insp_mpnlot_v`
3. Lot has inspections → `chuboe_insp_lot_lnk` links to `chuboe_insp`
4. Inspections have DC/LC → `chuboe_insp_datelotcode` provides counts

---

## Common Query Patterns

### Get All Picks for a Month
```sql
WITH austin_inspectors AS (
    SELECT ad_user_id, name
    FROM adempiere.ad_user
    WHERE name IN ('Jacob DeWit', 'Daisy Mendoza', ...)
),
all_picks AS (
    SELECT
        pick.chuboe_insp_lot_id,
        MIN(pick.startdate) AS first_pick_date
    FROM adempiere.chuboe_po_userpick pick
    JOIN austin_inspectors u ON pick.chuboe_po_pickeduser_id = u.ad_user_id
    WHERE pick.startdate >= '2026-05-01'
      AND pick.startdate < '2026-06-01'
      AND pick.isactive = 'Y'
    GROUP BY pick.chuboe_insp_lot_id
)
SELECT * FROM all_picks;
```

### Get Inspection Details for Picked OTINs
```sql
SELECT
    v.chuboe_otin_search AS otin,
    i.name AS inspection_type,
    -- Calculate weight based on inspection type
    CASE
        WHEN i.name = 'Tier 1 Passive Inspection' THEN 0.75
        WHEN i.name = 'Tier 2 Inspection' THEN 2.0
        -- ... etc
    END AS weight
FROM all_picks ap
JOIN adempiere.chuboe_insp_mpnlot_v v
    ON ap.chuboe_insp_lot_id = v.chuboe_insp_lot_id
JOIN adempiere.chuboe_insp_lot_lnk lnk
    ON v.chuboe_insp_lot_id = lnk.chuboe_insp_lot_id
JOIN adempiere.chuboe_insp i
    ON lnk.chuboe_insp_id = i.chuboe_insp_id
WHERE lnk.isactive = 'Y';
```

### Calculate DC/LC Counts
```sql
SELECT
    dlc.chuboe_insp_lot_id,
    dlc.chuboe_insp_id,
    CASE
        WHEN COUNT(DISTINCT NULLIF(dlc.lotcode, '')) > 0
        THEN COUNT(DISTINCT NULLIF(dlc.lotcode, ''))
        ELSE COALESCE(COUNT(DISTINCT NULLIF(dlc.datecode, '')), 1)
    END AS dclc_count
FROM adempiere.chuboe_insp_datelotcode dlc
WHERE dlc.isactive = 'Y'
GROUP BY dlc.chuboe_insp_lot_id, dlc.chuboe_insp_id;
```

---

## Data Quality Notes

### Active Records Only
Always filter by `isactive = 'Y'` to exclude soft-deleted records:
```sql
WHERE pick.isactive = 'Y'
  AND lnk.isactive = 'Y'
  AND dlc.isactive = 'Y'
```

### NULLIF for Empty Strings
Date/lot codes may be empty strings rather than NULL. Use `NULLIF(field, '')`:
```sql
COUNT(DISTINCT NULLIF(dlc.lotcode, ''))
```

### Case Sensitivity
Inspector names are case-sensitive. Use exact matches:
```sql
WHERE name = 'Daisy Mendoza'  -- NOT 'daisy mendoza' or 'DAISY MENDOZA'
```

### Date Range Boundaries
Use inclusive start, exclusive end for clean month boundaries:
```sql
WHERE pick.startdate >= '2026-05-01'
  AND pick.startdate < '2026-06-01'
```

---

## Performance Considerations

### Indexes
Key tables should have indexes on:
- `chuboe_po_userpick.startdate`
- `chuboe_po_userpick.chuboe_insp_lot_id`
- `chuboe_insp_lot_lnk.chuboe_insp_lot_id`
- `chuboe_insp_datelotcode.chuboe_insp_lot_id`

### Query Optimization
- Use CTEs (WITH clauses) for readability
- Filter inactive records early
- Group/aggregate at appropriate levels
- Typical query execution: 2-5 seconds for 1 month

---

## Schema Version

**Last Updated:** June 2026
**iDempiere Version:** Custom Chuboe implementation
**Compatibility:** Scripts tested against PostgreSQL 13+

---

## Support

For schema questions or access issues:
- Database Admin: [Contact Info]
- iDempiere Documentation: Internal wiki
- Table structure: Use `\d tablename` in psql
