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

#### ⚠️ chuboe_offer_line CPC bean-callout collapse — READ BEFORE WRITING OFFERS

iDempiere has a server-side bean callout on `chuboe_offer_line` that **silently collapses** any two rows in the same offer that share the same `chuboe_cpc` value — strict equality on `(chuboe_offer_id, chuboe_cpc)`, **regardless of how different the MPNs are**. The destruction is invisible to API callers:

1. POST returns `200 OK` with a new ID, exactly as if the line was written successfully.
2. Server-side, after the response is sent, the callout fires:
   - The **earlier** row's `chuboe_mpn` field is **comma-merged in place** with the new MPN: e.g., `5962-1620804QZC` becomes `5962-1620804QZC,TESTAVL-COLLAPSE-CHECK`. This corrupts the survivor's join key (`chuboe_mpn_clean`) so it stops matching anywhere.
   - The **new** row is set `isactive = N` with description overwritten to `"deactived - duplicate CPC - See Line #<survivor_line>"`.

**Verified empirically 2026-04-08** by POSTing two lines on offer 1024752 with the same CPC and totally distinct MPNs. The callout fired on completely unrelated MPN strings — there is no fuzzy match, the only key is CPC equality.

**Mitigation patterns:**

| Pattern | When | How |
|---|---|---|
| **Per-CPC anchor** | Multi-row-per-CPC customer loads (Sanmina-style date code/lot detail) | One row per unique CPC carries `chuboe_cpc` populated; all subsequent rows for that CPC POST with `chuboe_cpc = '' / NULL`. Recover the linkage from `Description` text or sub-table. |
| **Sub-row alternates** | AVL / multi-MPN-per-CPC (Case A in `feedback_avl_multi_mpn_loading.md`) | Write the primary MPN as one `chuboe_offer_line` row, write the alt MPNs as `chuboe_offer_line_mpn` sub-rows under it. The sub-table is **not** subject to the callout. |
| **CPC = '' or NULL** | Any time you don't strictly need CPC at the line level | The callout has no key when CPC is empty; lines stay independent. |

**Also:** `Chuboe_CPC` is **non-updateable on existing rows** — PATCH returns `500 "Cannot update column Chuboe_CPC"`. The CPC must be set at POST time only. So you can't fix a missing CPC after the fact via the standard write path.

**Proper fix (Chuck follow-up):** dedup key should be `(offer_id, cpc, chuboe_mpn_clean)`, not `(offer_id, cpc)`. Same iDempiere field-model bucket as the JSONB virtual-column issue on `chuboe_pricing_api_result` and the non-updateable Chuboe_CPC column.

References:
- `shared/offer-writeback.js` header docstring (full warning)
- memory: `feedback_avl_multi_mpn_loading.md`
- memory: `project_chuboe_offer_line_cpc_collapse.md`

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

#### VQ Field Requirements by Stage

**Tier 1 — VQ Loading (writing the quote):**
All fields required by the VQ Mass Upload Template (see `vq-loading.md`). These are the minimum to create a valid VQ record:

| Field | Column | Required | Default |
|-------|--------|----------|---------|
| RFQ | `chuboe_rfq_id`, `chuboe_rfq_line_id` | Yes | From MPN→RFQ lookup |
| Vendor | `c_bpartner_id` | Yes | From domain-based lookup |
| MPN | `chuboe_mpn` | Yes | — |
| MFR | `chuboe_mfr_id`, `chuboe_mfr_text` | Yes (ID required, not just text) | Resolved via `shared/mfr-lookup.js` |
| Qty | `qty` | Yes | — |
| Cost | `cost` | Yes | — |
| Currency | `c_currency_id` | No | 100 (USD) |
| Date Code | `chuboe_date_code` | No | — |
| MOQ | `chuboe_moq` | No | — |
| SPQ | `chuboe_spq` | No | — |
| Packaging | `chuboe_packaging_id` | Yes | From vendor quote |
| Lead Time | `chuboe_lead_time` | No | — |
| COO | `c_country_id` | No | — |
| RoHS | `chuboe_rohs` | No | — |
| Vendor Notes | `chuboe_note_public` | No | — |
| Buyer | `chuboe_buyer_id` | Yes | Astute employee who sourced |

**Fields that CAN be defaulted at VQ load time** (reduces PO prep work):

| Field | Column | Default | Logic |
|-------|--------|---------|-------|
| UOM | `c_uom_id` | 100 (Each) | Always unless otherwise noted |
| COO | `c_country_id` | 1000001 (PENDING) | If vendor didn't specify |
| RoHS | `chuboe_rohs` | `Y` | Unless otherwise noted |
| Traceability | `chuboe_traceability_id` | Derived from vendor type | Franchise (1000002) → Auth Dist Certs (1000001); all others → Non-Traceable (1000003) |
| Vendor Type | `chuboe_vendortype_id` | From BP record | Read `c_bpartner.chuboe_vendortype_id` |
| Packaging | `chuboe_packaging_id` | From vendor quote | If provided; otherwise left blank |

**Tier 2 — PO Processing (marking as purchased):**
ALL Tier 1 fields PLUS the following. A VQ **MUST NOT** be marked `IsPurchased = Y` unless every field is populated. No partial writes.

| Field | Column | Source |
|-------|--------|--------|
| Partner Location | `c_bpartner_location_id` | BP default (most have only 1) |
| Warehouse Group | `chuboe_warehouse_group_id` | Deal-specific (AUSTIN, HONG KONG, etc.) |
| Ship-to Warehouse | `chuboe_warehouse_id` | Deal-specific (SPEC BUY, ALLOCATED, consignment, etc.) |
| Shipper | `m_shipper_id` | Default: FedEx Ground (1000003) |
| Incoterm | `chuboe_inco_term_id` | Default: EXW (1000000) unless otherwise noted |
| Promise Date | `datepromised` | Derived from lead time: "stock" = today + 5 business days |
| Due Date | `duedate` | Same as promise date |
| IsPurchased | `ispurchased` | `Y` — set ONLY after all fields validated |

**Warehouse routing rules:**
- W103, W106, W107 → always Warehouse Group: AUSTIN (1000000)
- W111 → always Warehouse Group: BROWNSVILLE (1000008)
- ALLOCATED/PRESOLD → most commonly AUSTIN or HONG KONG

**Promise date derivation:**
- Lead time = "stock" or "in stock" → +5 business days from today
- Lead time = numeric (e.g., "12 weeks") → calculate from today
- Lead time = blank → must be provided at PO time

**CRITICAL: The API does NOT enforce OT's mandatory field validation.** Records can be written via API with missing fields that OT would reject on save. All validation is enforced **client-side via `shared/vq-purchase-validator.js`**, which is the canonical source of truth for the Tier 2 checklist (date code, lead time, promise date, packaging, traceability, warehouse + warehouse_group pair per program, shipper, incoterm, public/private note split, competing-VQ untick).

**Required writer paths — do not bypass:**

| Operation | Use | NOT |
|---|---|---|
| Tick `IsPurchased='Y'` | `shared/vq-patcher.js` → `tickVQForPurchase(vqId, {program, extra})` | `patchRecord('chuboe_vq_line', id, {IsPurchased: 'Y'})` |
| POST approve-order R_Request | `shared/r-request-writer.js` → `postApproveOrder({vqId, program, rfqId, summary, approvalText})` | `apiPost('r_request', {...})` directly |

Both wrappers run the validator internally and abort on any violation. The "don't bypass" rule exists because we empirically did bypass it on 2026-04-20 and shipped an approval with null promise date, null lead time, buyer-internal content in the public note, and Austin (1000000) where Brownsville (1000008) was expected.

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

**CQ Status (`r_status_id`):**
| ID | Name | Use |
|----|------|-----|
| 1000027 | Open | New/active quote |
| 1000026 | Closed | Finalized |

**CQ Resolution (`chuboe_cq_resolution_id`):**
| ID | Name |
|----|------|
| 1000000 | No Stock |
| 1000001 | Bought From Authorized Channels |
| 1000002 | Lower Price |
| 1000003 | Pushed Demand |
| 1000004 | Won |
| 1000005 | Lost Stock |

**Writer:** `shared/cq-writer.js` — `writeCQ(rfqSearchKey, line)` / `writeCQBatch(rfqSearchKey, lines)`

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

## Denormalized Counters on `chuboe_rfq_line`

`chuboe_rfq_line` has two denormalized counter columns: **`chuboe_vq_count`** and **`chuboe_cq_count`**. These are populated by **server-side bean callouts** in production (not in test) when an RFQ line / line MPN is created.

- They are **not** maintained by a join against the live VQ/CQ table — they're a snapshot written by the callout at creation time.
- OT does **not** associate VQs from other RFQs with new RFQs at the data layer. So `chuboe_vq_count > 0` on a freshly-created RFQ line does **not** mean live VQ rows are linked — verify with a real join (`chuboe_vq_line.chuboe_rfq_line_id = …`) before drawing conclusions.
- Authoritative VQ counts must come from `chuboe_vq_line` joined via `chuboe_rfq_line_id`, `chuboe_rfq_id`, or `chuboe_rfq_id_multi` — never trust the counter column for analysis.

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

### `Value` (Search Key) on Chuboe Tables

The `value` column on all chuboe header tables (`chuboe_rfq`, `chuboe_offer`, etc.) is the **search key** — the user-facing document number visible in the OT UI. This is NOT the same as the internal primary key.

| Field | Example | Purpose |
|-------|---------|---------|
| `chuboe_rfq_id` (PK) | `1133457` | Internal database ID — used for joins and FK references |
| `value` (search key) | `1124042` | User-facing RFQ number — what users reference in conversation and UI |

**Rules:**
- When reporting results to users, always use the search key (`value`), not the internal PK
- The REST API POST response includes both `id` (PK) and `Value` (search key) — extract both
- In SQL queries, select `value` when you need to display a document number to the user
- The PK is for programmatic use (joins, parent-child linking); the search key is for human use

---

## Lookup / Reference Tables

### Manufacturer (`chuboe_mfr`)
- PK: `chuboe_mfr_id`
- Key columns: `name`, `value` (short code)
- Resolution order: `mfr-aliases.json` → DB lookup (`name ILIKE '%keyword%'`) → use as-is
- Alias file: `Trading Analysis/Market Offer Loading/mfr-aliases.json` (shared across workflows)

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
| 1000025 | LAM Kitting Inventory ⚠ |

> ⚠ **Exclude `1000025` (LAM Kitting Inventory) from any excess/stock/availability/market-offer lookup.** It is a one-off report type representing LAM's *consigned* stock — not ours to sell. Standard filter: `AND o.chuboe_offer_type_id <> 1000025`. The exception is the LAM 3PL workflow itself, which reads this type intentionally. Currently applied in: `shared/market-data.js`, `Trading Analysis/Vortex Matches/vortex-matches.js`, `Trading Analysis/Stock RFQ Loading/suggested-resale.js`, `Trading Analysis/Price Intelligence Dashboard/price-intel.js`. Run `psql -c "SELECT chuboe_offer_type_id, name FROM adempiere.chuboe_offer_type ORDER BY name;"` for the full live list (this table is partial).

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

## Write-Back: iDempiere REST API

Writes to iDempiere now go through the **REST API** via `shared/api-client.js`, replacing the prior `ai_writeback` SQL schema approach.

**Full documentation:** See **`shared/api-writeback.md`** for authentication, payload structures, credential management, and examples for all 12 tables.

### Standard Payload Fields (Every POST)
```json
{
  "AD_Client_ID": 1000000,
  "AD_Org_ID": 0,
  "IsActive": true,
  "CreatedBy": 1000004,
  "UpdatedBy": 1000004
}
```

### ID Management
- **IDs are server-assigned** — no more 9000000+ block
- POST parent first → extract ID from response → POST children with parent ID
- Do NOT include PK fields in POST payloads

### Supported Tables
`chuboe_rfq`, `chuboe_rfq_line`, `chuboe_rfq_line_mpn`, `chuboe_vq_line`, `chuboe_cq_line`, `chuboe_offer`, `chuboe_offer_line`, `chuboe_offer_line_mpn`, `c_bpartner`, `c_bpartner_location`, `c_order`, `c_orderline`, `chuboe_pricing_api_result`

### Consumer Modules (Same Public Interfaces)
| Module | Write Function | Tables Written |
|--------|---------------|----------------|
| `rfq-writer.js` | `writeRFQ(opts)` | chuboe_rfq, chuboe_rfq_line, chuboe_rfq_line_mpn |
| `offer-writeback.js` | `writeOffer(opts)` | chuboe_offer, chuboe_offer_line, chuboe_offer_line_mpn |
| `api-result-writer.js` | `writePricingResult(opts)` | chuboe_pricing_api_result |

### REST API Column Names (PascalCase — Case-Sensitive)

**CRITICAL:** The iDempiere REST API requires **exact PascalCase column names** from the application dictionary (`ad_column.columnname`). Lowercase names will be silently rejected. These are NOT the same as the lowercase PostgreSQL column names used in SELECT queries.

**How to look up column names:**
```sql
SELECT c.columnname FROM adempiere.ad_column c
JOIN adempiere.ad_table t ON c.ad_table_id = t.ad_table_id
WHERE t.tablename = 'Chuboe_RFQ' AND c.isactive = 'Y';
```
Note: `ad_table.tablename` is also PascalCase (e.g., `Chuboe_RFQ`, not `chuboe_rfq`).

#### Chuboe_RFQ (52 columns — key ones for API writes)

| API Column Name | Notes |
|-----------------|-------|
| `AD_Client_ID` | auto-included by apiPost |
| `AD_Org_ID` | auto-included by apiPost |
| `C_BPartner_ID` | Customer |
| `Chuboe_RFQ_Type_ID` | See RFQ Types lookup |
| `SalesRep_ID` | Salesperson |
| `Description` | |
| `Processed` | |
| `Chuboe_InitialLoad_API` | |
| `Chuboe_CSV_Import` | |
| `CustomerQuoteReport` | |
| `Chuboe_RFQ_ToRequest_Button` | |
| `Chuboe_AMER_RFQ2BuyerQueue` | |
| `Chuboe_APAC_RFQ2BuyerQueue` | |
| `Chuboe_EMEA_RFQ2BuyerQueue` | |
| `Chuboe_INDIA_RFQ2BuyerQueue` | **INDIA** all-caps |
| `Chuboe_JAPN_RFQ2BuyerQueue` | **JAPN** all-caps |
| `Add_Pricing_API_Vendor` | |
| `Chuboe_Search_vendor` | **lowercase v** in vendor |
| `Chuboe_Search_Stock` | |
| `Chuboe_Multi_RFQtoBuyerQueue` | **lowercase 'to'** |
| `Chuboe_CSV_CQMass` | |
| `R_Status_ID` | |
| `IsActive` | auto-included by apiPost |
| `Created` | |
| `CreatedBy` | auto-included by apiPost |
| `Updated` | |
| `UpdatedBy` | auto-included by apiPost |

#### Chuboe_RFQ_Line (28 columns — key ones for API writes)

| API Column Name | Notes |
|-----------------|-------|
| `Chuboe_RFQ_ID` | FK to parent RFQ |
| `Chuboe_RFQ_Line_ID` | PK — do NOT include in POST |
| `Line` | Line number |
| `Qty` | |
| `PriceEntered` | Target price |
| `Chuboe_CPC` | Customer Part Code |
| `Chuboe_CPC_Clean` | Cleaned CPC |
| `Chuboe_Date_Code` | |
| `Description` | |
| `Chuboe_Note_Public` | |
| `Chuboe_Note_Private` | |
| `POReference` | |
| `IsActive` | auto-included |
| `Created` | |
| `CreatedBy` | auto-included |
| `Updated` | |
| `UpdatedBy` | auto-included |

#### Chuboe_RFQ_Line_MPN (22 columns — key ones for API writes)

| API Column Name | Notes |
|-----------------|-------|
| `Chuboe_RFQ_Line_ID` | FK to parent line |
| `Chuboe_RFQ_ID` | FK to header (denormalized) |
| `Chuboe_RFQ_Line_MPN_ID` | PK — do NOT include in POST |
| `Chuboe_MPN` | Manufacturer Part Number |
| `Chuboe_MPN_Clean` | Cleaned MPN |
| `Chuboe_MFR_ID` | FK to chuboe_mfr |
| `Chuboe_MFR_Text` | MFR as free text |
| `Qty` | |
| `PriceEntered` | Target price |
| `Chuboe_Date_Code` | |
| `Chuboe_CPC` | CPC (copy from line) |
| `Description` | |
| `Chuboe_RFQ_MPN_To_VQ_Button` | |
| `Chuboe_RFQ_MPN_To_CQ_Button` | |
| `IsActive` | auto-included |
| `Created` | |
| `CreatedBy` | auto-included |
| `Updated` | |
| `UpdatedBy` | auto-included |

**Tricky casing to watch for:**
- `Chuboe_INDIA_RFQ2BuyerQueue` — not `Chuboe_India_...`
- `Chuboe_JAPN_RFQ2BuyerQueue` — not `Chuboe_Japn_...`
- `Chuboe_Search_vendor` — lowercase `v` (not `Vendor`)
- `Chuboe_Multi_RFQtoBuyerQueue` — lowercase `to` (not `RFQToBuyerQueue`)

---

## Vendor BP Overrides (Do Not Skip)

Some vendors have multiple BPs in OT. **Always use the correct one:**

| Vendor | Use This BP | Search Key | c_bpartner_id | Do NOT Use |
|--------|------------|------------|---------------|------------|
| Avnet (web orders) | **Avnet EM** | 1002340 | 1000336 | Avnet (1001051 / 1000051) |

**Why:** Avnet EM is the web ordering entity. Using the generic "Avnet" BP causes downstream processing issues. This applies to all VQ loading — `vq-writer.js`, `lib-load-vq-row.js`, franchise API enrichment, and any manual VQ creation.

---

## Global Query Rules

1. **Always filter `isactive = 'Y'`** unless explicitly told otherwise
2. **Always filter `ad_client_id = 1000000`** when querying shared tables like `chuboe_mfr`
3. **Never write to `adempiere` schema** — use the REST API via `shared/api-client.js` for all writes
