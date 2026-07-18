# Inventory System Decoupling Proposal

**Date:** 2026-07-09
**Status:** Draft for Review

---

## Problem Statement

The current `inventory_cleanup.js` is a monolithic script that handles 5+ distinct use cases in a single cron run. This creates several problems:

1. **All-or-nothing execution** — Can't run LAM without running everything else
2. **Cascade failures** — One failing group can delay others
3. **Stale data coupling** — LAM 3PL depends on CSVs produced by inventory cleanup; when cleanup is paused, LAM uses stale data
4. **Testing difficulty** — Can't test portal export changes without running OT write-back
5. **Operator confusion** — Single email bundles unrelated warehouse concerns

---

## Current Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     inventory_cleanup.js                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ Infor Parse  │→ │ Warehouse    │→ │ OT Write-back (11 groups)│  │
│  │ & Dedupe     │  │ Split        │  │ + Carryover Merge        │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
│                          ↓                       ↓                  │
│                    ┌──────────────┐    ┌──────────────────────┐    │
│                    │ Portal CSVs  │    │ Summary Email        │    │
│                    │ (2 accounts) │    │ (everything bundled) │    │
│                    └──────────────┘    └──────────────────────┘    │
│                          ↓                                          │
│              ┌─────────────────────┐                               │
│              │ W111/W115 CSVs      │ ← File-based coupling         │
│              │ (written to disk)   │                               │
│              └─────────────────────┘                               │
└─────────────────────────────────────────────────────────────────────┘
                               ↓
┌─────────────────────────────────────────────────────────────────────┐
│                    lam-kitting-runner.js                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ Read CSVs    │→ │ Threshold    │→ │ Franchise Sourcing       │  │
│  │ from disk    │  │ Comparison   │  │ (8 APIs)                 │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
│                                              ↓                      │
│                    ┌──────────────┐  ┌──────────────────────────┐  │
│                    │ RFQ/VQ Write │← │ Customer Offer Refresh   │  │
│                    └──────────────┘  └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

**Problems with this:**
- LAM runner MUST wait for inventory cleanup to produce CSVs
- If inventory cleanup is paused, LAM runs on stale data
- No way to refresh just LAM inventory mid-week
- Portal exports are coupled to OT write-back

---

## Proposed Architecture

### Design Principles

1. **Each use case is an independent module** — can run standalone
2. **Shared data layer** — modules can read from OT OR parse Infor directly
3. **No file-based coupling** — modules query OT, not disk CSVs
4. **Independent scheduling** — each module has its own cron/trigger
5. **Targeted notifications** — each module emails its own stakeholders

### Module Breakdown

```
┌─────────────────────────────────────────────────────────────────────┐
│                    SHARED DATA LAYER                                │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ shared/infor-inventory-parser.js                             │  │
│  │   - Parse AST Item Lots Report (xlsx/csv)                    │  │
│  │   - Deduplicate, clean, split by warehouse                   │  │
│  │   - Returns: { warehouseCode: [rows] }                       │  │
│  └──────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ shared/ot-inventory-reader.js                                │  │
│  │   - Query chuboe_offer + chuboe_offer_line for current inv   │  │
│  │   - Filter by BP, offer type, isactive                       │  │
│  │   - Returns same shape as parser (warehouse-keyed rows)      │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                               ↓
        ┌──────────────────────┼──────────────────────┐
        ↓                      ↓                      ↓
┌───────────────┐    ┌───────────────┐    ┌───────────────────────┐
│ FREE STOCK    │    │ CONSIGNMENT   │    │ LAM 3PL               │
│ INVENTORY     │    │ INVENTORY     │    │                       │
├───────────────┤    ├───────────────┤    ├───────────────────────┤
│ Warehouses:   │    │ Warehouses:   │    │ Warehouses:           │
│ W102 (UK)     │    │ W103 (GE)     │    │ W111 (3PL)            │
│ W104 (Austin) │    │ W106 (Taxan)  │    │ W115 (Dead)           │
│ W108/113 (HK) │    │ W107 (Spart)  │    │ W118 (Consignment)    │
│ W109/114 (PH) │    │ W117 (Eaton)  │    │                       │
│ W112 (SPE)    │    │ W118 (LAM)    │    │ + Threshold file      │
│               │    │               │    │ + Franchise sourcing  │
│ + Franchise   │    │ + Carryovers  │    │ + RFQ/VQ creation     │
│   (Positronic)│    │               │    │ + Customer offer      │
├───────────────┤    ├───────────────┤    ├───────────────────────┤
│ Outputs:      │    │ Outputs:      │    │ Outputs:              │
│ - OT offers   │    │ - OT offers   │    │ - OT offers           │
│ - NetComp CSV │    │ - (no portal) │    │ - Reorder alerts      │
│               │    │               │    │ - RFQ + VQs           │
├───────────────┤    ├───────────────┤    ├───────────────────────┤
│ Cron: Mon 6AM │    │ Cron: Mon 6AM │    │ Cron: Mon 12PM        │
│ Email: Jake   │    │ Email: Jake   │    │ + On-demand mid-week  │
│               │    │               │    │ Email: Jake/Josh      │
└───────────────┘    └───────────────┘    └───────────────────────┘
        ↓                      ↓
┌───────────────────────────────────────┐
│ PORTAL EXPORTER                       │
├───────────────────────────────────────┤
│ Reads FROM OT (not from CSVs)         │
│ Queries active offers by BP/type      │
│ Generates NetComponents CSVs          │
│                                       │
│ Can run independently of write-back   │
│ Can regenerate portal files mid-week  │
├───────────────────────────────────────┤
│ Cron: Mon 7AM (after OT writes done)  │
│ + On-demand when carryovers change    │
└───────────────────────────────────────┘
```

---

## Module Specifications

### 1. shared/infor-inventory-parser.js

**Purpose:** Parse Infor AST Item Lots Report into structured data

**Input:** Excel or CSV file path

**Output:**
```javascript
{
  metadata: { sourceFile, parsedAt, totalRows, duplicatesRemoved },
  byWarehouse: {
    'W102': [ { mpn, mfr, qty, lot, location, dateCode, unitCost, ... }, ... ],
    'W104': [ ... ],
    // etc
  }
}
```

**No side effects** — pure parsing, no file writes, no OT calls

---

### 2. shared/ot-inventory-reader.js

**Purpose:** Read current inventory state from OT offers

**Functions:**
```javascript
// Get inventory for specific warehouse groups
getInventoryByGroups(['Free_Stock_Austin', 'Free_Stock_HK'])

// Get inventory for specific BPs
getInventoryByBP(1000332) // Astute Electronics Inc

// Get LAM inventory (W111 + W115 equivalent)
getLAMInventory()
```

**Output:** Same shape as parser — modules don't care where data came from

---

### 3. workflows/free-stock-inventory.js

**Purpose:** Manage free stock (Austin, UK, HK, PH) + Franchise

**Warehouses:** W102, W104, W108, W109, W112, W113, W114

**Data source:** Infor parser (weekly) OR OT reader (for status checks)

**Outputs:**
- OT offers (5 groups: Austin, Stevenage, HK, PH, Franchise)
- NetComponents non-auth CSV (via portal exporter trigger)
- NetComponents franchise CSV (via portal exporter trigger)

**Cron:** Monday 6 AM

**Email:** Free Stock Inventory Summary

---

### 4. workflows/consignment-inventory.js

**Purpose:** Manage consignment inventory (GE, Taxan, Spartronics, Eaton)

**Warehouses:** W103, W106, W107, W117

**Special handling:**
- Prices blanked (confidential)
- Carryover merge for Eaton

**Outputs:**
- OT offers (4 groups)
- NO portal export (consignment not marketed externally)

**Cron:** Monday 6 AM

**Email:** Consignment Inventory Summary

---

### 5. workflows/lam-inventory.js (NEW — replaces current LAM 3PL runner dependency on CSVs)

**Purpose:** Unified LAM inventory management

**Warehouses:** W111 (3PL), W115 (Dead), W118 (Consignment)

**Data sources:**
- **Primary:** Infor parser (for weekly full refresh)
- **Secondary:** OT reader (for mid-week threshold checks)
- **Threshold file:** Lam_Kitting_DB.xlsx

**Sub-modules (can run independently):**

| Sub-module | Function | Can Run Standalone? |
|------------|----------|---------------------|
| `lam-inventory-refresh.js` | Parse Infor, write W115/W118 offers to OT | Yes |
| `lam-threshold-check.js` | Compare inventory vs thresholds | Yes (reads OT) |
| `lam-sourcing.js` | Hit franchise APIs for reorder items | Yes |
| `lam-rfq-writer.js` | Create RFQs + VQs in OT | Yes |
| `lam-customer-offer.js` | Refresh BI dashboard offer | Yes |

**Key change:** `lam-threshold-check.js` queries OT directly — doesn't need CSVs

```javascript
// OLD: Read from disk (coupled to inventory cleanup)
const w111 = readCSV('Inventory 2026-07-09/W111_LAM_3PL.csv');
const w115 = readCSV('Inventory 2026-07-09/W115_LAM_Dead_Inventory.csv');

// NEW: Query OT (decoupled)
const lamInventory = await otInventoryReader.getLAMInventory();
// Returns W111 + W115 + W118 data from active offers
```

**Cron options:**
- Full refresh: Monday 12 PM (after Infor parsed)
- Threshold check only: Daily (uses OT data)
- On-demand: Any time

**Emails:**
- LAM Reorder Alerts (to Josh)
- LAM Inventory Summary (to Jake)

---

### 6. workflows/portal-exporter.js

**Purpose:** Generate NetComponents CSV uploads

**Data source:** OT offers (NOT disk CSVs)

**Logic:**
```javascript
// Query all active offers that should go to portal
const offers = await getPortalEligibleOffers();
// Filter: WAREHOUSE_WRITEBACK groups minus consignment
// Include: Static carryovers marked for portal

// Generate CSVs
generateNetComponentsNonAuth(offers);  // Account #1167233
generateNetComponentsFranchise(offers); // Account #1126121
```

**Can run independently:**
- After OT writes complete
- After carryover changes
- On-demand for corrections

**Cron:** Monday 7 AM (or triggered after inventory writes)

---

### 7. workflows/carryover-manager.js (extracted from inventory_cleanup.js)

**Purpose:** Manage static carryover inventory

**Carryovers:**
- Eaton Consignment (merged into W117)
- Free Stock Philippines (merged into W109/W114)
- LAM Consignment (merged into W118)
- GM Stock (standalone)

**Functions:**
```javascript
// Add lines to a carryover
addCarryoverLines('Eaton Consignment', csvPath);

// Retire lines
retireCarryoverLines('LAM Consignment', ['MPN1', 'MPN2']);

// Reconcile against Infor (mark as arrived)
reconcileCarryover('Eaton Consignment', inforData);

// Refresh OT offer (standalone carryovers only)
refreshStandaloneCarryover('GM Stock');
```

**Can run independently** — doesn't need full inventory cleanup

---

## Migration Path

### Phase 1: Extract Shared Data Layer (Week 1)

1. Create `shared/infor-inventory-parser.js`
   - Extract parsing logic from `inventory_cleanup.js`
   - Add unit tests

2. Create `shared/ot-inventory-reader.js`
   - Query `chuboe_offer` + `chuboe_offer_line`
   - Map to same output shape as parser

3. **No cron changes yet** — existing scripts continue to work

### Phase 2: Decouple LAM (Week 2)

1. Update `lam-threshold-check.js` to use OT reader
   - Falls back to Infor parser if OT data is stale

2. Update `lam-kitting-runner.js`
   - Remove dependency on disk CSVs
   - Add `--source=ot` or `--source=infor` flag

3. **Add independent LAM cron**
   - Daily threshold check (reads OT)
   - Weekly full refresh (reads Infor)

4. **Test:** Pause inventory cleanup, verify LAM still runs

### Phase 3: Split Inventory Cleanup (Week 3)

1. Create `workflows/free-stock-inventory.js`
   - Extract Austin, UK, HK, PH, Franchise logic

2. Create `workflows/consignment-inventory.js`
   - Extract GE, Taxan, Spartronics, Eaton logic

3. Create `workflows/lam-inventory.js`
   - Extract W115, W118 write-back (W111 stays internal-only)

4. **Deprecate monolithic `inventory_cleanup.js`**
   - Keep as orchestrator that calls sub-modules
   - Or retire entirely once sub-modules proven

### Phase 4: Decouple Portal Export (Week 4)

1. Create `workflows/portal-exporter.js`
   - Reads from OT, not CSVs

2. Update cron to run after OT writes complete

3. **Test:** Run portal export independently of inventory write-back

---

## Cron Schedule (Proposed)

| Time (Mon) | Job | Dependencies |
|------------|-----|--------------|
| 6:00 AM | `free-stock-inventory.js` | Infor export in inbox |
| 6:05 AM | `consignment-inventory.js` | Infor export in inbox |
| 6:10 AM | `lam-inventory-refresh.js` | Infor export in inbox |
| 7:00 AM | `portal-exporter.js` | OT offers written |
| 12:00 PM | `lam-threshold-check.js` + sourcing + RFQ | OT offers current |

| Time (Daily) | Job | Dependencies |
|--------------|-----|--------------|
| 8:00 AM | `lam-threshold-check.js` (quick) | Reads OT |

---

## Benefits

1. **Granular control** — Pause/run individual workflows
2. **Faster iteration** — Test one module without running all
3. **Better monitoring** — Each module has its own health check
4. **Reduced blast radius** — One failure doesn't cascade
5. **Mid-week flexibility** — LAM can refresh without full inventory run
6. **Clearer ownership** — Each workflow has a single purpose

---

## Open Questions

1. **Infor export frequency** — Can we get more frequent exports for LAM?
2. **OT data freshness** — How do we indicate when OT data is stale?
3. **Carryover triggers** — Should carryover changes auto-trigger portal refresh?
4. **Alerting** — Should each module have independent health monitoring?

---

## Next Steps

1. [ ] Review this proposal
2. [ ] Prioritize which decoupling to do first (recommend: LAM)
3. [ ] Create shared data layer modules
4. [ ] Migrate LAM to use OT reader
5. [ ] Test LAM running independently
6. [ ] Continue with remaining modules
