# OT Data Model Reference

Single source of truth for iDempiere (OT) table structures, relationships, and field locations. All workflows MUST reference this document instead of documenting schema inline.

---

## Entity Relationship Overview

```
                    chuboe_rfq (Header - customer demand)
                         |
              chuboe_rfq_line (CPC level)
               /         |         \
   chuboe_rfq_line_mpn   |          |
   (MPN/MFR level)       |          |
                         |          |
              chuboe_vq_line    chuboe_cq_line
              (vendor quotes)  (customer quotes)
                   |                  |
                   +------ both ------+
                           |
                     c_orderline
                  (convergence point: links
                   VQ + CQ + RFQ line)


   chuboe_offer (Header - market inventory)
        |
   chuboe_offer_line (CPC level)
        |
   chuboe_offer_line_mpn (MPN level)
   (matched to RFQ/VQ/CQ by MPN, not FK)
```

---

## Core Entity Chains

### RFQ Chain (Customer Demand)

**3-level hierarchy: Header -> Line (CPC) -> Line MPN (MPN/MFR)**

| Level | Table | PK | Parent FK |
|-------|-------|----|-----------|
| Header | `chuboe_rfq` | `chuboe_rfq_id` | -- |
| Line | `chuboe_rfq_line` | `chuboe_rfq_line_id` | `chuboe_rfq_id` |
| Sub-line | `chuboe_rfq_line_mpn` | `chuboe_rfq_line_mpn_id` | `chuboe_rfq_line_id` (also `chuboe_rfq_id` denormalized) |

**Where key fields live:**

| Field | Header | Line (CPC) | Line MPN |
|-------|--------|------------|----------|
| **MPN** | -- | `chuboe_mpn`* | **`chuboe_mpn`** |
| **MFR** | -- | `chuboe_mfr_id`/`_text`* | **`chuboe_mfr_id`/`_text`** |
| **CPC** | -- | **`chuboe_cpc`** | `chuboe_cpc` (copy) |
| **Qty** | -- | `qty` | `qty` |
| **Target Price** | -- | `priceentered` | `priceentered` |
| **Date Code** | -- | `chuboe_date_code` | `chuboe_date_code` |
| **Customer** | **`c_bpartner_id`**, `bpname` | -- | -- |
| **Doc#** | **`value`** | -- | -- |
| **RFQ Type** | **`chuboe_rfq_type_id`** | -- | -- |
| **Salesperson** | **`salesrep_id`** | -- | -- |
| **Project** | **`c_project_id`** | -- | -- |

**CRITICAL:** The Line level holds the customer's CPC. The Line MPN sub-level is where **MPN and MFR authoritatively live**. One CPC line can have multiple candidate MPNs. Fields marked `*` on the Line level may be NULL — always join to `chuboe_rfq_line_mpn` for MPN/MFR data.

---

### Offer Chain (Market Inventory / Excess)

**3-level hierarchy: Header -> Line -> Line MPN** (parallel structure to RFQ)

| Level | Table | PK | Parent FK |
|-------|-------|----|-----------|
| Header | `chuboe_offer` | `chuboe_offer_id` | -- |
| Line | `chuboe_offer_line` | `chuboe_offer_line_id` | `chuboe_offer_id` |
| Sub-line | `chuboe_offer_line_mpn` | `chuboe_offer_line_mpn_id` | `chuboe_offer_line_id` |

**Where key fields live:**

| Field | Header | Line | Line MPN |
|-------|--------|------|----------|
| **MPN** | -- | **`chuboe_mpn`**, `chuboe_mpn_clean` | `chuboe_mpn`, `chuboe_mpn_clean` |
| **MFR** | -- | **`chuboe_mfr_id`/`_text`** | -- |
| **CPC** | -- | `chuboe_cpc` | -- |
| **Qty** | -- | **`qty`** | -- |
| **Price** | -- | **`priceentered`** | -- |
| **Recommended Resale** | -- | `apl_offer_recommendedresale` | -- |
| **Date Code** | -- | `chuboe_date_code` | -- |
| **Lead Time** | -- | `chuboe_lead_time` | -- |
| **MOQ/SPQ** | -- | `chuboe_moq`, `chuboe_spq` | -- |
| **Vendor/Source** | **`c_bpartner_id`** | -- | -- |
| **Offer Type** | **`chuboe_offer_type_id`** | -- | -- |
| **Doc#** | **`value`** | -- | -- |

**Note:** Unlike RFQ, Offer MPN/MFR data primarily lives at the **Line level** (not the sub-line). `chuboe_offer_line_mpn` is for alternate MPN cross-references.

---

### VQ (Vendor Quote — Supply Side)

**Flat — single table, no header.**

| Table | PK |
|-------|----|
| `chuboe_vq_line` | `chuboe_vq_line_id` |

| Field | Column |
|-------|--------|
| **MPN** | `chuboe_mpn`, `chuboe_mpn_clean`, `chuboe_mpn_clean_mask` |
| **MFR** | `chuboe_mfr_id`, `chuboe_mfr_text` |
| **Qty** | `qty` |
| **Cost (buy price)** | `cost` |
| **Date Code** | `chuboe_date_code` |
| **Vendor** | `c_bpartner_id`, `bpname` |
| **Vendor Type** | `chuboe_vendortype_id` |
| **Buyer** | `chuboe_buyer_id` |
| **Salesperson** | `salesrep_id` |
| **Lead Time** | `chuboe_lead_time` |
| **Package** | `chuboe_package_desc` |
| **RoHS** | `chuboe_rohs` |
| **Currency** | `c_currency_id` |
| **MOQ/SPQ** | `chuboe_moq`, `chuboe_spq` |
| **Quote Date** | `chuboe_datequotetrx` |
| **PO Reference (Infor POV)** | `chuboe_po_string` |
| **HTS/ECCN** | `chuboe_hts`, `chuboe_eccn` |

**VQ has NO CPC column.** CPC is a customer concept. To get CPC for a VQ, join through `chuboe_rfq_line_id` → `chuboe_rfq_line.chuboe_cpc`.

**Cross-entity FKs:**
- `chuboe_rfq_line_id` → `chuboe_rfq_line`
- `chuboe_rfq_id` → `chuboe_rfq` (denormalized)

---

### CQ (Customer Quote — Sell Side)

**Flat — single table, no header.**

| Table | PK |
|-------|----|
| `chuboe_cq_line` | `chuboe_cq_line_id` |

| Field | Column |
|-------|--------|
| **MPN** | `chuboe_mpn`, `chuboe_mpn_clean` |
| **MFR** | `chuboe_mfr_id`, `chuboe_mfr_text` |
| **CPC** | `chuboe_cpc`, `chuboe_cpc_clean` |
| **Qty** | `qty` |
| **Resale (sell price)** | `priceentered` |
| **Date Code** | `chuboe_date_code` |
| **Customer** | `c_bpartner_id`, `bpname` |
| **Sold?** | `issold` (Y/N) |
| **Lead Time** | `chuboe_lead_time` |
| **Quote Date** | `chuboe_datequotetrx` |
| **Include in Quote** | `ischuboeincludeinquote` |
| **Resolution** | `chuboe_cq_resolution_id`, `r_status_id` |

**Cross-entity FKs:**
- `chuboe_rfq_line_id` → `chuboe_rfq_line`
- `chuboe_rfq_id` → `chuboe_rfq` (denormalized)
- **NO direct FK to VQ.** VQ↔CQ link is indirect through shared `chuboe_rfq_line_id`.

---

### Order Line (Convergence Point)

`c_orderline` carries FKs to all entities when a deal closes:
- `chuboe_vq_line_id` → `chuboe_vq_line`
- `chuboe_cq_line_id` → `chuboe_cq_line`
- `chuboe_rfq_line_id` → `chuboe_rfq_line`
- Also has its own `chuboe_mpn`, `chuboe_cpc`, `chuboe_mfr_id`, `chuboe_date_code`
- `chuboe_po_string` = Infor POV number (filter: `LIKE 'POV%'`)

---

## Key Join Patterns

| From → To | Join |
|-----------|------|
| RFQ → Line | `chuboe_rfq.chuboe_rfq_id = chuboe_rfq_line.chuboe_rfq_id` |
| RFQ Line → Line MPN | `chuboe_rfq_line.chuboe_rfq_line_id = chuboe_rfq_line_mpn.chuboe_rfq_line_id` |
| VQ → RFQ Line | `chuboe_vq_line.chuboe_rfq_line_id = chuboe_rfq_line.chuboe_rfq_line_id` |
| VQ → RFQ Header | `chuboe_vq_line.chuboe_rfq_id = chuboe_rfq.chuboe_rfq_id` |
| CQ → RFQ Line | `chuboe_cq_line.chuboe_rfq_line_id = chuboe_rfq_line.chuboe_rfq_line_id` |
| Order → VQ | `c_orderline.chuboe_vq_line_id = chuboe_vq_line.chuboe_vq_line_id` |
| Order → CQ | `c_orderline.chuboe_cq_line_id = chuboe_cq_line.chuboe_cq_line_id` |
| Offer → Line | `chuboe_offer.chuboe_offer_id = chuboe_offer_line.chuboe_offer_id` |
| Offer → RFQ (header-level only) | `chuboe_offer.chuboe_rfq_id = chuboe_rfq.chuboe_rfq_id` |
| Any → MFR | `*.chuboe_mfr_id = chuboe_mfr.chuboe_mfr_id` |
| Any → BPartner | `*.c_bpartner_id = c_bpartner.c_bpartner_id` |

**WARNING — Common Wrong Joins:**
- `c_orderline.chuboe_vq_line_id` → join to `chuboe_vq_line`, NOT `chuboe_rfq_line`
- For RFQ MPN data, always go to `chuboe_rfq_line_mpn` — `chuboe_rfq_line.chuboe_mpn` may be NULL

---

## Price Column Names

Price means different things on different tables:

| Table | Column | Meaning |
|-------|--------|---------|
| `chuboe_rfq_line` / `_mpn` | `priceentered` | Customer's **target price** |
| `chuboe_vq_line` | `cost` | Vendor's **buy price** |
| `chuboe_cq_line` | `priceentered` | Our **sell price** to customer |
| `chuboe_offer_line` | `priceentered` | Offer **list price** |
| `chuboe_offer_line` | `apl_offer_recommendedresale` | Suggested **resale price** |
| `c_orderline` | `priceentered` | Actual **transaction price** |

---

## search_key vs c_bpartner_id

**These are DIFFERENT numbers for the same partner.** Import templates expect `search_key` (`c_bpartner.value`), not `c_bpartner_id`.

| Partner | c_bpartner_id | search_key (value) |
|---------|---------------|--------------------|
| Cyclops Electronics | 1000491 | 1002495 |
| LAM Research | 1000730 | (different) |

Always use `c_bpartner.value` (search_key) when populating import templates.

---

## Lookup / Reference Tables

### Manufacturer (`chuboe_mfr`)
- PK: `chuboe_mfr_id`
- Key columns: `name`, `value` (short code)
- Resolution order: `mfr-aliases.json` → DB lookup (`name ILIKE '%keyword%'`) → use as-is
- Alias file: `Trading Analysis/Market Offer Uploading/mfr-aliases.json` (shared across workflows)

### RFQ Types (`chuboe_rfq_type`)
| ID | Name |
|----|------|
| 1000000 | Stock |
| 1000001 | Shortage |
| 1000002 | PPV |
| 1000003 | EOL/LTB |
| 1000004 | Hot Parts |
| 1000006 | Unqualified Spot RFQ |

### Offer Types (`chuboe_offer_type`)
| ID | Name |
|----|------|
| 1000000 | Customer Excess |
| 1000001 | Broker Stock Offer |
| 1000003 | Franchise Offers |
| 1000004 | Stock - Austin |
| 1000005 | Stock - HK |
| 1000006 | Stock - Stevenage |
| 1000007 | Stock - Philippines |
| 1000008 | Consignment - GE |
| 1000009 | Consignment - Taxan |
| 1000010 | Consignment - Spartronics |

### Well-Known Partner IDs
| search_key | Name | Usage |
|------------|------|-------|
| 1008499 | Unqualified Broker | Default for unknown senders in Stock RFQ Loading |

---

## Valid Values (Enums)

### Packaging (`chuboe_package_desc` / `chuboe_packaging_id`)
REEL, TRAY, BULK, CUT TAPE, F-TUBE, AMMO, BOX, F-REEL, F-TRAY, OTHER

### RoHS (`chuboe_rohs`)
Yes, No, Not Applicable

### Country of Origin (COO) — Common Mappings
| ISO | Country |
|-----|---------|
| CN | China |
| TW | Taiwan |
| MY | Malaysia |
| TH | Thailand |
| PH | Philippines |
| JP | Japan |
| KR | South Korea |
| US | United States |
| DE | Germany |
| GB | United Kingdom |
| MX | Mexico |

### Currency (`c_currency_id`)
| ID | Currency |
|----|----------|
| 100 | USD |

---

## ai_writeback Schema

### Mandatory Columns (Every INSERT)
```sql
ad_client_id  = 1000000
ad_org_id     = 0
isactive      = 'Y'
created       = CURRENT_TIMESTAMP
createdby     = 1000004        -- Jake Harris
updated       = CURRENT_TIMESTAMP
updatedby     = 1000004
```

### Primary Key Rules
- All new IDs **must start at 9000000+** to avoid collisions with production sequences
- Query `MAX(id)` from `ai_writeback` before inserting to find next safe ID

### Available Tables
`chuboe_rfq`, `chuboe_rfq_line`, `chuboe_rfq_line_mpn`, `chuboe_vq_line`, `chuboe_cq_line`, `chuboe_offer`, `chuboe_offer_line`, `chuboe_offer_line_mpn`, `c_bpartner`, `c_bpartner_location`, `c_order`, `c_orderline`, `chuboe_pricing_api_result`

---

## Global Query Rules

1. **Always filter `isactive = 'Y'`** unless explicitly told otherwise
2. **Always filter `ad_client_id = 1000000`** when querying shared tables like `chuboe_mfr`
3. **Never write to `adempiere` schema** — use `ai_writeback` for all inserts
