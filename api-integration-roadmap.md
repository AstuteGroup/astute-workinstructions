# API Integration Roadmap

Cross-cutting roadmap for external API integrations. Individual implementations live in workflow-specific roadmaps; this provides the centralized view.

**Central Config:** `~/workspace/.env` (all API keys stored here)

---

## Overview

| API Category | Use Cases | Count | Roadmap Reference |
|--------------|-----------|-------|-------------------|
| Franchise Distributors | Pricing, stock, screening | 25 | `Trading Analysis/RFQ Sourcing/sourcing-roadmap.md` § A1 |
| Broker / Independent | Pricing, inventory, RFQ | 2 | This file |
| Aggregators | Multi-source search, screening | 4 | This file |
| Component Intelligence | Lifecycle, risk, compliance | 2 | This file |
| MRO / Industrial Suppliers | Pricing, specs, procurement | 1 | This file |
| LLM / AI | Quote extraction, vendor inference | 1 | `Trading Analysis/RFQ Sourcing/sourcing-roadmap.md` § C7 |

---

## Franchise Distributor APIs

**Status:** In Progress | **Priority:** Active

Real-time pricing and availability from authorized distributors. Replaces FindChips scraping with direct API access.

| Distributor | API Type | Documentation | Status | BP ID |
|-------------|----------|---------------|--------|-------|
| DigiKey | OAuth2 REST (2-leg) | developer.digikey.com | **Active** | 1000327 |
| Arrow | REST (query params) | developers.arrow.com | **Active** | 1000386 |
| Rutronik | REST (query params) | rutronik24.com/api.html | **Active** | 1002668 |
| Future Electronics | REST (API key header) | documenter.getpostman.com/view/18706946/UzBvFhcj | **Active** | 1000328 |
| TTI | REST (apiKey header) | developer.tti.com | **Active** | 1000326 |
| Newark/element14/Farnell | REST (API key) | partner.element14.com | **Active** | 1000390 |
| Sager Electronics | REST (API key) | developer.sager.com | **Active** | 1000335 |
| Rochester Electronics | REST (?) | api.rocelec.com | **To investigate** | 1000058 |
| Mouser | REST (API key) | api.mouser.com/api/docs/ui/index | **Active** | 1000334 |
| Octopart/Nexar | GraphQL | nexar.com/api | Planned (aggregator) | — |
| Avnet | OAuth2 REST | apiportal.avnet.com | **Pending docs** | 1000002 |
| Venkel | REST (?) | venkel.com | **Pending docs** | 1001951 |
| Texas Instruments | OAuth2 REST | api-portal.ti.com | **Pending approval** | 1001369 |
| Master Electronics | REST v2 (path params) | masterelectronics.com/en/gettingstarted | **Active** | 1000405 |
| Allied Electronics | EDI (?) | Unknown | **To investigate** | 1000392 |
| Waldom Electronics | REST | api.waldom.com | **Active** | 1000644 |
| Analog Devices | REST | analog.com/en/support/api-suites.html | **To investigate** | 1000774 |
| Wurth Electronics | REST | we-online.com/en/support/collaboration/api | **To investigate** | — |
| LCSC Electronics | REST | lcsc.com/docs/index.html | **To investigate** | 1002898 |
| Sourceability | REST | Contact for access | **To investigate** | 1000261 |
| RS Components | REST | Contact sales rep | **To investigate** | 1000554 |
| Electro Sonic | REST | CalcuQuote integration | **To investigate** | 1000404 |

### DigiKey API (Active)

**App:** API_Astute | **API:** Product Information v4 | **Auth:** 2-Legged OAuth

**Credentials:**
| Key | Value |
|-----|-------|
| Client ID | `ivtDsDLOQ6l4TgHiKzRJeI42BUrw5ZRq` |
| Client Secret | `2gx8NL6aSwH9GkpH` |
| Account ID | `14763716` |

**Token endpoint:** `https://api.digikey.com/v1/oauth2/token`

**iDempiere Vendor:**
- BP ID: `1000327`
- BP Value: `1002331`
- Name: `Digi-Key Electronics`

**Code:** `Trading Analysis/RFQ Sourcing/franchise_check/digikey.js`

**Usage:**
```bash
# Single part lookup
node digikey.js LM317 100

# Returns: qty, price at RFQ qty, VQ-ready data
```

**Token lifecycle:** Tokens expire in ~10 minutes. The module auto-refreshes.

**Current Use (Active):**
| Field | Use |
|-------|-----|
| `franchiseQty` | Total available (product-level, no double-counting) |
| `franchiseBulkPrice` | Lowest price break — used for screening decision |
| `franchiseRfqPrice` | Price at RFQ quantity — used for VQ loading |
| `vqVendorNotes` | "DigiKey stock: X,XXX \| DigiKey PN: XXX" |
| `vqMpn`, `vqManufacturer`, `vqDescription` | VQ template fields |

**Future Use Cases (data available in API):**
| Field | Future Use |
|-------|------------|
| `StandardPricing` (all breaks) | Quick Quote pricing intelligence — know full price curve |
| `ManufacturerLeadWeeks` | Lead time quoting, shortage detection |
| `ProductStatus` / `Discontinued` / `EndOfLife` | Obsolescence monitoring for BOMs |
| `DatasheetUrl` | Auto-attach datasheets to quotes |
| `Parameters` (specs) | Cross-reference / alternative part finding |
| `RohsStatus` / `ReachStatus` | Compliance filtering |
| `HtsusCode` | Export/tariff calculations |
| `MinimumOrderQuantity` | Order planning |
| `NormallyStocking` | Availability risk assessment |
| `PhotoUrl` | Visual verification in quotes |

**Implementation details:** See `Trading Analysis/RFQ Sourcing/sourcing-roadmap.md` Section A

**Key files:**
- `~/workspace/.env` — API credentials
- `Trading Analysis/RFQ Sourcing/franchise_check/digikey.js` — DigiKey API module
- `Trading Analysis/RFQ Sourcing/franchise_check/` — Screening workflow

### Arrow API (Active)

**API:** Pricing & Availability v4 | **Auth:** Query parameters (login + apikey)

**Credentials:**
| Key | Value |
|-----|-------|
| Login | `astutegroup1` |
| API Key | `fe8176be3335c19ce3d5f82cc8a06b21d04e62354e137b60994f4a95190a6d76` |

**Endpoint:** `https://api.arrow.com/itemservice/v4/en/search/token?login=X&apikey=Y&search_token=MPN`

**iDempiere Vendor:**
- BP ID: `1000386`
- BP Value: `1002390`
- Name: `Arrow Electronics`

**Code:** `Trading Analysis/RFQ Sourcing/franchise_check/arrow.js`

**Usage:**
```bash
node arrow.js LM317T 100
```

**Source filtering (2026-04-09 fix):** Arrow API returns both `arrow.com` (Arrow franchise: Europe / Americas / APAC) and `Verical.com` (Verical broker marketplace). The parser splits these into separate VQ rows tagged with the right business partner — Arrow Electronics (`1000386`) for franchise, Verical (`1001436`) for broker. Verical lots that Arrow's API also publishes under the `arrow.com` tree (sourcePartId starts with `V`) are dropped to avoid double-counting.

**Current Use (Active):**
| Field | Use |
|-------|-----|
| `franchiseQty` | Total available from arrow.com sources |
| `franchiseBulkPrice` | Lowest price break — used for screening |
| `franchiseRfqPrice` | Price at RFQ qty — used for VQ |
| `vqDateCode` | Date code from best source |
| `vqVendorNotes` | "Arrow stock: X \| DC: YYWW" |

**Future Use Cases:**
| Field | Future Use |
|-------|------------|
| `shipsFrom` | Regional sourcing preferences |
| `shipsIn` | Lead time estimates |
| `dateCode` | Date code filtering |
| Datasheet URL | Auto-attach to quotes |
| RoHS/compliance | Compliance filtering |

#### RESOLVED 2026-04-09 — Arrow / Verical channel split + stock-bounded pricing

**Status:** Fixed | **Verified on:** `IMZ120R030M1H` qty=100

Diagnostic run on the reproducer surfaced six concrete bugs in `arrow.js`:

1. **`franchiseQty` overstated 130x.** Doc claimed "filter to arrow.com only" — code did the opposite: it summed `arrowQty + vericalQty` into `franchiseQty`. Real Arrow franchise = 150 pcs (Europe). Reported = 19,759.
2. **Verical lots double-counted.** Arrow's API mirrors Verical inventory under both the `Verical.com` webSite tree AND the `arrow.com → Arrow Americas` source. The mirrors are identifiable by sourcePartId prefix (`V*`). Legacy parser counted them twice.
3. **`franchiseBulkPrice` was unreachable.** Parser surfaced the lowest tier price regardless of whether on-hand stock could unlock it (`qty>=240 $2.069` from a 120pc lot). Buyers can't actually pay that.
4. **`franchiseRfqPrice` from wrong source.** "Best source" was picked by lowest bulk break, not by best stock-bounded price-at-rfqQty.
5. **Lead time leaked onto stocked rows.** `mfrLeadTime` (OEM replenishment) was reported alongside `fohQty>0`, contradicting itself.
6. **MPN substitution silent.** Searched `IMZ120R030M1H`, Arrow returned only `IMZ120R030M1HXKSA1` (tube variant). Parser fell back to `PartList[0]` and surfaced the wrong SKU with no warning.

**Fixes shipped:**
- `arrow.js` rewritten to walk every sourcePart, classify by webSite + sourcePartId prefix (drop V* mirrors on arrow.com), bound prices by reachable on-hand qty (`priceForBuy(breaks, min(rfqQty, fohQty))`), and emit one entry per real source-with-stock into a new `vqLines[]` array tagged with the right vendor BP (Arrow `1000386` or Verical `1001436`).
- `shared/franchise-api.js` — added Verical to DISTRIBUTORS map (inactive, for cache reconstitution). Master vqLines builder spreads `r.vqLines` when present so each Arrow + Verical opportunity surfaces as its own row.
- `shared/api-result-writer.js` — envelope `Pricings[]` now captures one row per source with `SupplierName` set to "Arrow Electronics" or "Verical", plus new `SourceChannel`/`SourcePartId` fields. Cache hits preserve the per-source detail.
- `shared/vq-writer.js` — `writeVQFromAPI()` and `writeVQBatch()` pre-warm both pass over `d.vqLines`; one VQ written per sub-line. Natural key (`Chuboe_RFQ_Line_ID, Chuboe_MPN, C_BPartner_ID, Cost`) gives a separate VQ row per lot since costs differ across lots.

**Verified output for `IMZ120R030M1H` qty=100:**
- 4 vqLines: 3 Verical (18,799 / 210 / 150 pcs at \$10.45 / \$8.943 / \$9.5388) + 1 Arrow Europe (150 pcs Netherlands at \$9.5477)
- 3 V-prefix mirrors dropped from arrow.com Americas (210 / 120 / 0 pcs)
- Top-level `franchiseQty=150` (Arrow only, was 19,759); `vericalQty=19,159` exposed separately
- The 120pc lot whose only tier was `qty>=240 $2.069` is correctly excluded at rfqQty=100 (unreachable)

**Followups (not done in this pass):**
- MPN substitution: still silent. `IMZ120R030M1HXKSA1` is surfaced as `vqMpn` with no `mpnSubstituted` flag. If buyers need bare-base only, add a packaging-suffix stripper to `normalizeMpn` and warn on fallback.
- "Lots that exist but are unreachable at this rfqQty" (e.g., the 120pc/$2.069 lot) are silently dropped. Could surface them as `unreachableOpportunities[]` so a buyer asking for 100 can see "you could get \$2.069 if you bumped to 120."
- Cache invalidation: any cached arrow envelopes captured before today still have the legacy single-row shape. They'll naturally roll over within 7d (non-PPV TTL); no manual purge.

#### TODO — Verical channel surfacing gap (open 2026-05-07, second case 2026-05-11)
Found while investigating ROI-tracker missed-franchise hits: Arrow's API returns `not_carried` for parts that Verical actually stocks. Concrete cases:
- `Q6004D3RP` — buyer purchased 2,500 from Verical at \$0.7608 (Sanmina, RFQ 1132985), Arrow API returned no hits (2026-05-07).
- `Q6004D3RP` re-confirmed via live probe 2026-05-11 (East West Mfg RFQ 1132985) — Arrow API still returns `found=false` for the same MPN.

**Hypothesis:** Verical inventory is partially exposed via Arrow's standard product API. Some MPNs surface (the rewrite on 4/09 confirmed this works for parts that DO surface) but not all. May require a different endpoint, query parameter, or marketplace-specific call.

**To investigate:**
1. Pull a list of recent broker-purchased MPNs where Arrow's API returned `not_carried`. Check Verical.com directly for stock — confirm the gap is real (not just Verical-doesn't-stock-it).
2. Test Arrow API with different parameters: `RetailChecksumOptions`, `TaxOptions`, alt endpoints (`/products/v3/search` vs current).
3. Check Arrow's documentation for a Verical-specific channel flag.
4. If Arrow truly has no API surface for Verical's full catalog, evaluate if Verical has its own API or web scrape pathway.

**Why it matters:** ROI tracker flags these as "missed franchise" — but if Verical's surface is structurally limited via Arrow, these aren't bugs we can fix on our side. Worth knowing the bound. Already excluded from the DigiKey miss fix (commit `c6ae2e5`) since it's an Arrow-side gap, not DigiKey.

**Priority context (2026-05-11):** All confirmed Verical wins in the 30d ROI window turned out to be transactional RFQs (customer already committed pre-RFQ — see commit `39b543c` and memory `feedback_check_window_before_miss_narrative.md`). The surfacing gap is still real but lower priority than originally framed — wait for a non-transactional Verical-sourced win before sinking time into the Arrow-API investigation. Cross-listed in `~/workspace/deferred-work.md` § Investigations as a parked pointer entry.

### Rutronik API (Active)

**API:** Rutronik24 REST API | **Auth:** Query parameter (apikey)

**Credentials:**
| Key | Value |
|-----|-------|
| API Key | `nppg7idj64gy` |

**Endpoint:** `https://www.rutronik24.com/api/search?searchterm=MPN&apikey=X`

**iDempiere Vendor:**
- BP ID: `1002668`
- BP Value: `1004668`
- Name: `Rutronik Inc.`

**Code:** `Trading Analysis/RFQ Sourcing/franchise_check/rutronik.js`

**Usage:**
```bash
node rutronik.js S3001-D320 100
```

**Note:** European distributor - may not stock all US-common parts. Returns pricing even for zero-stock items (with lead time).

**Current Use (Active):**
| Field | Use |
|-------|-----|
| `franchiseQty` | Stock available |
| `franchiseBulkPrice` | Lowest price break — screening |
| `franchiseRfqPrice` | Price at RFQ qty — VQ |
| `vqLeadTime` | Lead time in days |
| `vqVendorNotes` | "Rutronik stock: X \| SKU: Y" or "Lead time: X days" |

### Future Electronics API (Active)

**API:** Orbweaver REST API | **Auth:** Header `x-orbweaver-licensekey`

**Credentials:**
| Key | Value |
|-----|-------|
| API Key | `IW7OI-DOC91-OKUD3-37YK2-X3RSY` |

**Endpoints:**
| Type | Endpoint | Method |
|------|----------|--------|
| Single | `https://api.futureelectronics.com/api/v1/pim-future/lookup?part_number=X&lookup_type=exact` | GET |
| Batch | `https://api.futureelectronics.com/api/v1/pim-future/batch/lookup` | POST |

**Lookup types:** `exact` (default), `default` (starts with), `contains`

**iDempiere Vendor:**
- BP ID: `1000328`
- BP Value: `1002332`
- Name: `Future Electronics Corporation`

**Code:** `Trading Analysis/RFQ Sourcing/franchise_check/future.js`

**Usage:**
```bash
node future.js LM317T 100
node future.js LM317 100 contains  # search variants
```

**Current Use (Active):**
| Field | Use |
|-------|-----|
| `franchiseQty` | Total available from quantities.quantity_available |
| `franchiseBulkPrice` | Lowest price break — screening |
| `franchiseRfqPrice` | Price at RFQ qty — VQ |
| `vqDateCode` | Date code from part_attributes |
| `vqLeadTime` | Lead time from quantities.factory_leadtime |
| `vqVendorNotes` | "Future stock: X \| DC: YYWW \| Future PN: Z" |

**Response structure:**
```json
{
  "offers": [{
    "part_id": { "mpn": "...", "seller_part_number": "..." },
    "part_attributes": [{"name": "manufacturerName", "value": "..."}],
    "quantities": { "quantity_available": 18965, "factory_leadtime": "7" },
    "pricing": [{ "unit_price": 0.44, "quantity_from": 1, "quantity_to": 14 }]
  }]
}
```

**⚠ KNOWN GAP — Non-stock MOQ/SPQ extraction (2026-04-14):**
Future parser returns price + LT on non-stocked/factory-order items but leaves `stock`, `moq`, and `spq` empty. Same pattern as Mouser (see Mouser section above). Confirmed on:
- `RNCF0805TKT10K0` — Future $0.605 (13 wks) — no MOQ/stock extracted
- `RNCF0805TTT10K0` — Future $0.587 (13 wks) — no MOQ/stock extracted
- `TNPW1206198RBEEA` — Future $0.143 (8 wks) — no MOQ

**Hypothesis:** Factory-order qty info lives in `quantities` object (likely `minimum_order_quantity` / `order_multiple` / similar) that the extractor doesn't pull when `quantity_available=0`. Check:
1. Raw Future response for non-stock MPN vs stocked MPN
2. Identify factory-order MOQ/SPQ fields in `quantities` object
3. Update `future.js` to extract them
4. Add defensive warning if price returned without MOQ on non-stock items

**Impact:** Can't compare MOQs across vendors when only one (Master) returns it. Buyers can't make informed decisions on factory-order MOQ overage.

**Code:** `Trading Analysis/RFQ Sourcing/franchise_check/future.js`

---

### Newark / Farnell / element14 API (Unified)

**API:** element14 Product Search API | **Auth:** Query parameter (callInfo.apiKey)

Single API key provides access to all regional stores. Different stores have different inventory pools and local currency pricing.

**Credentials:**
| Key | Value |
|-----|-------|
| API Key | `72pqcg952mk4kkw3g8veb9xz` |

**Endpoint:** `https://api.element14.com/catalog/products`

**Rate limits:** 2 calls/sec, 1,000 calls/day (free tier)

---

#### Regional Stores

| Store | storeInfo.id | Currency | Status | Notes |
|-------|--------------|----------|--------|-------|
| **Newark** | `www.newark.com` | USD | **Active** | Primary for US/USD screening |
| **Farnell** | `uk.farnell.com` | GBP | **Active** | UK/EU coverage |
| element14 AU | `au.element14.com` | AUD | To investigate | |
| element14 SG | `sg.element14.com` | SGD | To investigate | |
| element14 CN | `cn.element14.com` | CNY | To investigate | |
| element14 HK | `hk.element14.com` | HKD | To investigate | |

**Note:** Newark and Farnell maintain separate inventory. Querying both stores uses 2 API calls per part.

---

#### iDempiere Vendor

- BP ID: `1000390`
- BP Value: `1002394`
- Name: `Newark in One (Element 14)`

---

#### Code & Usage

**Code:** `Trading Analysis/RFQ Sourcing/franchise_check/newark.js`

```bash
# Search both Newark + Farnell (default)
node newark.js LM317T 100

# Search single store only
node newark.js LM317T 100 --store www.newark.com
node newark.js LM317T 100 --store uk.farnell.com
```

**Search types:**
- MPN search: `term=manuPartNum:LM317T`
- Keyword search: `term=any:fuse`
- SKU search: `term=id:1278613`

---

#### Output Fields

| Field | Use |
|-------|-----|
| `franchiseQty` | Combined stock (Newark + Farnell) |
| `franchiseBulkPrice` | Lowest price break — screening (USD from Newark) |
| `franchiseRfqPrice` | Price at RFQ qty — VQ (USD from Newark) |
| `stores.newark` | Newark-specific: stock, price, SKU, currency |
| `stores.farnell` | Farnell-specific: stock, price, SKU, currency |
| `vqVendorNotes` | "Newark: X @ $Y \| Farnell: X @ £Y" |
| `vqDatasheetUrl` | Link to datasheet PDF |

**Response groups:**
- `small`: Basic product info
- `medium`: Adds pricing and stock
- `large`: Full details including datasheets (default)

---

### TTI API (Active)

**API:** Search API (primary) + Lead Time API (supplemental) + Quote API (needs key)
**Auth:** `apiKey` header (custom Azure APIM header — NOT `Ocp-Apim-Subscription-Key`)

**Portal:** [developer.tti.com](https://developer.tti.com/)

**Credentials:**
| Key | Product | Value |
|-----|---------|-------|
| Search API Key | Search (pricing, stock, parts) | `9cafe5893ee04935a82d2c5ab663cf26` |
| Lead Time API Key | Lead Time (lifecycle, CoO) | `ee0620712e46441296dd77341d6179e8` |
| Quote API Key | Quote line items | *(not yet subscribed)* |

**Endpoints:**
| Method | Path | API Key | Description |
|--------|------|---------|-------------|
| GET | `/service/api/v1/search/keyword?searchTerms=X` | Search | **Primary** — pricing, stock, lead time, compliance |
| GET | `/service/api/v1/search/manufacturers` | Search | Manufacturer code reference list |
| POST | `/leadtime/v1/requestLeadtime` | Lead Time | Supplemental — lifecycle, CoO, on-order pipeline |
| GET | `/quote/v2/{quoteId}/lineitems?page=X&size=Y` | Quote | Quote line items (needs separate key) |

**Search API (Primary) — Keyword Endpoint:**
```
GET /service/api/v1/search/keyword?searchTerms={mpn}[&exactMatchPartNumber=true][&customerAccountNumber=X][&requestEntity=X]
Headers: apiKey: <search-key>, Accept: application/json
```

**Search API Response:**
```json
{
  "parts": [{
    "ttiPartNumber": "C0805C104K5RACTU",
    "manufacturerPartNumber": "C0805C104K5RAC7800",
    "manufacturer": "KEMET",
    "description": "Multilayer Ceramic Capacitors MLCC - SMD/SMT 50V 0.1uF X7R 0805 10%",
    "availableToSell": 2832000,
    "salesMinimum": 4000,
    "salesMultiple": 4000,
    "pricing": { "quantityPriceBreaks": [{ "quantity": 4000, "price": 0.0114 }, ...] },
    "leadTime": "14 Weeks",
    "packaging": "Reel",
    "datasheetURL": "https://...",
    "buyUrl": "https://...",
    "hts": "8532240020",
    "partNCNR": "N",
    "tariffMessage": "Tariff May Apply",
    "exportInformation": { "eccn": "EAR99", "hts": "8532240020", "taric": "8532240000" },
    "environmentalInformation": { "rohsStatus": "Compliant", "leadInTerminals": "No", "reachSVHC": "No" },
    "regionalInventory": [{ "ttiRegion": "AS", "availableToSell": 20000 }],
    "availableOnOrder": [{ "quantity": 184000, "date": "2026-03-18" }],
    "roHsStatus": "Compliant"
  }],
  "currencyCode": "USD",
  "recordCount": 2
}
```

**Lead Time API (Supplemental):**
```json
POST /leadtime/v1/requestLeadtime
Headers: apiKey: <leadtime-key>, Content-Type: application/json

{ "description": "Lookup", "partNumbers": ["MPN1", "MPN2"] }
// Returns: lifeCycle, countryOfOrigin (not in Search API)
// Rate limit: ~5 seconds between calls
```

**iDempiere Vendor:**
- BP ID: `1000326`
- BP Value: `1002330`
- Name: `TTI Inc`

**Code:** `Trading Analysis/RFQ Sourcing/franchise_check/tti.js`

**Usage:**
```bash
# Single part lookup (uses Search API)
node tti.js C0805C104K5RACTU 100

# With lifecycle/CoO enrichment (adds Lead Time API call)
node tti.js C0805C104K5RACTU 100 --enrich

# Non-exact (partial match) search
node tti.js C0805 100 --partial

# List manufacturer codes
node tti.js --manufacturers
```

**Current Use (Active):**
| Field | Source | Use |
|-------|--------|-----|
| `franchiseQty` | Search | Stock available |
| `franchisePrice` | Search | Price at MOQ |
| `franchiseBulkPrice` | Search | Lowest price break |
| `franchiseRfqPrice` | Search | Price at RFQ qty |
| `vqLeadTime` | Search | Lead time (e.g., "14 Weeks") |
| `vqMoq` / `vqSpq` | Search | Min order qty / sales multiple |
| `vqManufacturer` | Search | Full manufacturer name |
| `vqDescription` | Search | Part description |
| `vqRohs` | Search | RoHS compliance status |
| `vqHts` / `vqEccn` | Search | Export control codes |
| `vqDatasheetUrl` | Search | Datasheet link |
| `vqPackaging` | Search | Reel/Tube/etc. |
| `vqLifeCycle` | Lead Time | Active/EOL (via --enrich) |
| `vqCoo` | Lead Time | Country of origin (via --enrich) |
| `vqVendorNotes` | Both | "TTI stock: X \| LT: Y \| MOQ: Z \| Mfr: W" |

**Notes:**
- TTI specializes in passives & connectors — most semiconductor MPNs won't match
- Search API is the richest of all franchise APIs (pricing, compliance, datasheets, regional stock)
- Lead Time API adds lifecycle and CoO not in Search response, but has strict rate limiting
- Parts not in TTI catalog return empty `parts` array (Search) or `"Not a TTI Part"` (Lead Time)

**Account:** `VAA050` (Astute) — embedded in API key. `customerAccountNumber` param tested but returns same web pricing. Customer-specific/negotiated pricing requires the Quote API.

**TODO:**
- [ ] Subscribe to Quote API for negotiated/customer-specific pricing (endpoint exists, needs key)
- [ ] Integrate into franchise screening pipeline alongside DigiKey/Arrow/etc.

---

### Sager Electronics API (Active)

**Portal:** [developer.sager.com](https://developer.sager.com/)
**Admin:** Mashery — `Sagerelectronics.admin.mashery.com`
**Base URL:** `sagerelectronics.api.mashery.com`

**iDempiere Vendor:**
- BP ID: `1000335`
- Name: `Sager - v3004`
- Value: `1002339`

**API:** Customer Price and Availability
- `POST /customer-price-availability/v1`
- Body: `{ "PartNumber": "MPN" }`
- Auth: `api_key` header (NOT query param)
- Rate limit: 4 calls/sec, 100K calls/day

**API Key:** `y7deugn3bmsk8czcc5aaxk9q` (active, created 2026-03-25)
**Mashery Package Key:** `d378375c-b6fa-45e7-97cd-13603befc563`

**Response fields:** manufacturerPartNumber, manufacturerName, description, currentStockQty, onOrderQuantity, leadTimeDays, pricings[] (unitPrice/qtyBreak tiers), minimumBuy, multiplier, ncnr, roHS, lifeCycleStatus, category, currency, dataSheetUrl, productUrl (includes Astute UTM tracking), sku, packaging.

**Module:** `Trading Analysis/RFQ Sourcing/franchise_check/sager.js`
**Registered in:** `shared/franchise-api.js`

**Status:** Live and integrated. Module built 2026-03-26. Specializes in power, thermal, connectors, electromechanical — returns empty for semiconductor parts not in Sager catalog.

---

### Rochester Electronics API (To Investigate)

**Endpoint:** api.rocelec.com

**iDempiere Vendor:**
- BP ID: `1000058`
- Name: `Rochester Electronics`

**Capabilities:** Obsolete/EOL parts specialist. API exists but documentation unclear.

**Status:** Need to contact Rochester for API access/docs.

---

### Texas Instruments API (Pending Approval)

**API:** Inventory and Pricing API | **Auth:** OAuth2 (client credentials)

**Credentials:**
| Key | Value |
|-----|-------|
| Consumer Key | `PhtlnMQsJ7yR6lboZiSEhxnWkzhp83LO` |
| Consumer Secret | `PYFkiOihdANZqERn` |
| App Name | `api_astute` |
| Account | `api.inc@astutegroup.com` |

**Token endpoint:** `https://transact.ti.com/v1/oauth/accesstoken`
**Inventory endpoint:** `https://transact.ti.com/v2/store/products/{partNumber}?currency=USD`

**Status:** OAuth works but API returns "no apiproduct match found" — need TI to approve subscription to Inventory and Pricing API product. Awaiting TI approval (as of 2026-03-26). Once approved, build `ti.js` module, add `priceBreaks`, register in `franchise-api.js`.

**iDempiere Vendor:**
- BP ID: `1001369`
- Name: `Texas Instruments`

---

### Avnet API (Blocked — APIM unrouted 404)

**Subscription Key:** `067a6c51a2b04ca3ae39c85fd27f7fe2`
**Auth Header:** `ocp-apim-subscription-key: <key>`
**Gateway base:** `https://apigw.avnet.com`
**Documented endpoint (per Roshan Tamrakar 2026-04-29):** `GET https://apigw.avnet.com/external/getDEXFetchProducts?mpn=<MPN>`

**Entitlement caveat:** Our Product & Pricing API request was **rejected**; Avnet granted the **Product Information** API only — returns enrichment + web resale price, not contract pricing. Worth a separate push to Alberto Rosales for P&P access once Product Info is unblocked.

**iDempiere Vendor:**
- BP ID: `1000051` (primary, 6,971 VQ lines) — also `1000002` (legacy, 1 VQ line from 2018)
- Related entities: Avnet EM (1000336), Avnet EMG Ltd (1000202, 1000426), Avnet Silica (1004943), Avnet Technology HK (1000376)
- Combined VQ volume: ~9,800 lines
- Name: `Avnet`

**Status (2026-05-07):** Docs received from Roshan 2026-04-29 with full endpoint path, auth method, and curl example. Smoke test against `getDEXFetchProducts` returns `404 {"statusCode": 404, "message": "Resource not found"}` — APIM's canonical "no operation matched" response. Bad/missing keys return the **same** 404 (would expect 401 if it were an auth issue), so the gateway never reaches our key — our subscription product has no operation registered at this path. Reply sent to Roshan 2026-05-07 asking him to verify subscription entitlement and operation publish status. Once unblocked, build `shared/franchise-apis/avnet.js` matching `tti.js`/`mouser.js` interface and register in `franchise-api.js`.

---

### Mouser API (Active)

**API:** Part Number Search (primary) + Keyword Search
**Auth:** `apiKey` query parameter
**Portal:** [api.mouser.com/api/docs/ui/index](https://api.mouser.com/api/docs/ui/index)

**Credentials:**
| Key | Value |
|-----|-------|
| API Key | `d73312c1-9675-4406-b0b5-d96241d46a5c` |

**Endpoints:**
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/search/partnumber?apiKey=X` | **Primary** — pricing, stock, lead time, compliance |
| POST | `/api/v1/search/keyword?apiKey=X` | Broader keyword search |
| GET | `/api/v2/search/manufacturerlist?apiKey=X` | Manufacturer reference list |

**Part Number Search:**
```
POST /api/v1/search/partnumber?apiKey={key}
Content-Type: application/json

{ "SearchByPartRequest": { "mouserPartNumber": "{mpn}", "partSearchOptions": "Exact" } }
```

**iDempiere Vendor:**
- BP ID: `1000334`
- BP Value: `1002338`
- Name: `Mouser`

**Code:** `Trading Analysis/RFQ Sourcing/franchise_check/mouser.js`

**Usage:**
```bash
# Single part lookup
node mouser.js C0805C104K5RACTU 100

# Non-exact (partial match) search
node mouser.js C0805 100 --partial
```

**Current Use (Active):**
| Field | Source | Use |
|-------|--------|-----|
| `franchiseQty` | AvailabilityInStock | Stock available |
| `franchisePrice` | PriceBreaks[0] | Price at MOQ |
| `franchiseBulkPrice` | PriceBreaks[-1] | Lowest price break |
| `franchiseRfqPrice` | PriceBreaks | Price at RFQ qty |
| `vqLeadTime` | LeadTime | Lead time (e.g., "140 Days") |
| `vqMoq` / `vqSpq` | Min / Mult | Min order qty / sales multiple |
| `vqManufacturer` | Manufacturer | Full manufacturer name |
| `vqDescription` | Description | Part description |
| `vqRohs` | ROHSStatus | RoHS compliance status |
| `vqHts` / `vqEccn` | ProductCompliance[] | Export control codes |
| `vqDatasheetUrl` | DataSheetUrl | Datasheet link |
| `vqPackaging` | ProductAttributes | Reel/Tube/etc. |
| `vqLifeCycle` | LifecycleStatus | Active/Obsolete |
| `vqVendorNotes` | Composite | "Mouser stock: X | LT: Y | Mfr: Z" |

**Notes:**
- Previous key was blocked for distributor accounts (no pricing/stock). New key (2026-03-24) has full access.
- Some parts still return "Not available for purchase by distributors" — handled gracefully as restriction in vendor notes.
- API key goes in query string, not header.
- Mouser has Cart and Order APIs too (27 endpoints total) — not used yet but available for future procurement automation.

**✅ RESOLVED 2026-04-14 — Factory-order MOQ now flagged in synthesized LT lines:**
Original report was that Mouser/Future returned "viable" lines for parts whose MOQ greatly exceeds the RFQ qty. Probe of raw API responses showed the parsers were already extracting `vqMoq`, `vqLeadTime`, and price breaks correctly — the actual gap was in `shared/franchise-api.js → synthesizeStockLtVqLines`, which built the lead-time row using `qty: rfqQty` and ignored MOQ. So a 100-pc RFQ on `QII-0.006-00-61` (Mouser MOQ 9,217) was rendered as a viable "100 @ $0.082" line.

**Fix:** synthesizer now sets `qty = max(rfqDemand, vqMoq)`, re-prices at that buy qty (often unlocks a deeper tier), and prepends `⚠ MOQ N (RFQ q)` to `vendorNotes` when MOQ forces over-buy. Lives in shared, so applies to **every** consumer of `vqLines` (Mouser, Future, DigiKey, TTI, Master, etc.) — not LAM-specific.

**Verified:**
- `QII-0.006-00-61` @ qty 100 → `qty: 9217, cost: $0.082, vendorNotes: "⚠ MOQ 9,217 (RFQ 100) | …"`
- `K202XHT-E9S-N` @ qty 100 (MOQ 1) → `qty: 100, cost: $3.07, vendorNotes: "LT: 175 Days | Mfr: Kycon"` (no warning, picks right price tier)

**Separate observation — `XEL6060-821MEC` API genuinely returns `RestrictionMessage: "Not available for purchase by distributors."`** This isn't a parser bug; the API key sees a distributor-restricted view. If the Mouser web page shows it as buyable, that's a region/account difference worth investigating separately before treating as a fixable gap.

**✅ RESOLVED 2026-04-14 — Wrong-match fallback ("recommendation as result") killed across all parsers:**
Every active parser had the same antipattern: when the searched MPN didn't match any candidate, fall back to `products[0]` (the first thing the distributor's keyword search returned, often a "you might also like" recommendation). Then populate `vqMpn`, `vqManufacturer`, `vqPrice` etc. from that wrong part as if it were the searched MPN. Confirmed empirically in `EPG_Comprehensive_Sourcing_20260402.xlsx`: Newark/Farnell quoted $0.018/43,650 stk for `500-231` from MFR "COMPUTER COMPONENTS,INC" (a totally different part), while DigiKey on the same row correctly identified it as Yageo at $0.27292.

**Fix:** new `shared/mpn-match.js` helper:
- `mpnMatch(searched, candidate, opts)` returns `'exact'` (normalized equal), `'variant'` (one side prefix-contains the other, both ≥5 chars — catches packaging suffixes like `LM358N`/`LM358N/NOPB`, `CRCW0402-T/R`/`CRCW0402` without enumerating per-distributor suffix lists), or `null`
- `pickBestCandidate()` filters to MPN-matching candidates only, ranks by exact > variant then by stock, returns `null` if none — parsers fail closed instead of falling back
- Optional MFR veto via `opts.mfr`: rejects candidates where `computeMfrMatch(rfqMfr, candidateMfr) === 'MISMATCH'`. Uses existing acquisition + alias resolution from `shared/mfr-equivalence.js` so legit relabels (Linear → ADI, TI → Texas Instruments, Stackpole independent of Vishay, etc.) don't false-veto

All 10 active parsers patched: `digikey.js`, `arrow.js`, `rutronik.js`, `future.js`, `newark.js`, `tti.js`, `mouser.js`, `master.js`, `waldom.js`, `sager.js`. `searchPart()` signatures extended to `(mpn, qty, opts)` with the third arg backwards-compat. `shared/franchise-api.js` plumbs `opts.mfr` through and surfaces `result.matchType`.

**Bonus bugs surfaced during the audit:**
- **TTI** was matching against `ttiPartNumber` (TTI's internal SKU like `TTI-LM358N`), not `manufacturerPartNumber` (the real MPN). So exact-MPN tier almost never hit and parser fell straight to "any with stock" — silently wrong-matching for years. Now uses `manufacturerPartNumber || ttiPartNumber`.
- **Sager** never attempted MPN matching at all — just picked the highest-stock product from whatever Sager's keyword search returned. Now uses the same matcher as everyone else.

**Verified:**
- `LM358N` ↔ `LM358N/NOPB` → variant match (no false negative on packaging suffixes)
- `500-231` vs `RC0805FR-07330RL` → null (no false positive on unrelated parts)
- `LM78` vs `LM7805` → null (MIN_LEN floor blocks too-short prefix matches)
- `LM6172` Linear vs ADI → exact (acquisition resolved)
- `LM358N` TI vs Yageo → null (MFR veto fires)

**MFR veto is opt-in.** Existing call sites that don't pass `opts.mfr` get the old behavior minus the wrong-match fallback. To activate the MFR layer, sourcing call sites (LAM EPG, RFQ enrichment, Vortex Matches, etc.) need to pass `{ mfr: rfqMfr }` when calling `searchPart`. Roadmap candidate.

---

### Master Electronics API (Active)

**API:** cgpriceavailability REST API v2 | **Auth:** API key in path

**Credentials:**
| Key | Value |
|-----|-------|
| API Key | `1640d818-0b10-4162-a2ad-34750e79e346` |

**Endpoint:**
```
GET https://api.masterelectronics.com/wapi/v2/cgpriceavailability/{query}/{inStockOnly}/{exactMatch}/{resultsCount}/{apiKey}
```

**IMPORTANT:** The endpoint is `cgpriceavailability` (with 'g'), NOT `cpriceavailability`.

**Path Parameters:**
| Parameter | Description | Values |
|-----------|-------------|--------|
| query | Part number(s) | comma-separated for multiple |
| inStockOnly | Stock filter | `0`=all, `1`=in-stock only |
| exactMatch | Match type | `0`=partial, `1`=exact |
| resultsCount | Max results | number |
| apiKey | Your API key | UUID |

**Example:**
```bash
curl -X GET "https://api.masterelectronics.com/wapi/v2/cgpriceavailability/LM317/0/1/10/1640d818-0b10-4162-a2ad-34750e79e346" -H "accept: application/json"
```

**Docs:** https://www.masterelectronics.com/en/gettingstarted/?div=gettingstarted2

**iDempiere Vendor:**
- BP ID: `1000405`
- BP Value: `1002409`
- Name: `Master Electronics`

**Code:** `Trading Analysis/RFQ Sourcing/franchise_check/master.js`

**Usage:**
```bash
node master.js LM317T 100
node master.js LM317 100 --partial    # partial match
node master.js LM317 100 --in-stock   # in-stock only
```

**Current Use (Active):**
| Field | Use |
|-------|-----|
| `franchiseQty` | Stock available from quantityAvailable |
| `franchiseBulkPrice` | Lowest price break — screening |
| `franchiseRfqPrice` | Price at RFQ qty — VQ |
| `vqLeadTime` | Lead time from factoryLeadTimeTxt |
| `vqMoq` | Minimum order quantity |
| `vqVendorNotes` | "Master stock: X \| MOQ: Y \| Mfr: Z" |

**Response Fields:**
| Field | Description |
|-------|-------------|
| `partNumber` | MPN |
| `manufacturer` | Manufacturer name |
| `quantityAvailable` | Stock (string, parse to int) |
| `factoryLeadTime` | Lead time in weeks |
| `factoryLeadTimeTxt` | "X Week(s)" |
| `moq` | Minimum order quantity |
| `roHS` | "Yes"/"No" |
| `coo` | Country of origin |
| `productLifeCycle` | "Active", "EOL", etc. |
| `price_breaks` | Array of {pricebreak, pricelist} |

**Note:** Activated 2026-03-17. Initial 401 was due to endpoint typo (`cpriceavailability` vs `cgpriceavailability`).

---

### Allied Electronics API (To Investigate)

**iDempiere Vendor:**
- BP ID: `1000392`
- Name: `Allied Electronics Inc`

**Capabilities:** EDI integration available. API unclear.

**Status:** Need to contact Allied for API availability/docs.

---

### TME / Transfer Multisort Elektronik API (To Investigate)

**Portal:** [developers.tme.eu](https://developers.tme.eu) | **Docs:** [api-doc.tme.eu](https://api-doc.tme.eu)

**API:** REST | **Auth:** HMAC-SHA1 signed requests (50-char token + 20-char secret)

**iDempiere Vendor:**
- BP ID: `1000969` (Transfer Multisort Elektronik) / `1006376` (TME Germany GmbH)
- Name: `Transfer Multisort Elektronik`

**Capabilities:**
- Product search (text, category, filters)
- Real-time pricing (multi-tier, multi-currency, customer discounts)
- Real-time stock levels
- Combined pricing + stock endpoint
- Delivery time estimates
- Product specs/parameters, datasheets, photos
- Category tree, similar product recommendations
- Autocomplete/suggestions

**Rate Limits:** 10 req/sec general; 2 req/sec for pricing/stock

**Sandbox:** Feature-unlimited sandbox environment for testing

**Access:** Free self-service registration at developers.tme.eu/signup

**Note:** Large European distributor, 500K+ products. Best-documented API of the new batch — self-service signup with sandbox.

**Status:** To investigate. Register and evaluate.

---

### Samtec API (To Investigate)

**Portal:** [developer.samtec.com](https://developer.samtec.com) | **Catalog API:** [api.samtec.com/catalog](https://api.samtec.com/catalog/index.html)

**API:** REST | **Auth:** Web token-based, 3-step onboarding

**iDempiere Vendor:**
- BP ID: `1000685`
- Name: `Samtec Inc`

**Capabilities:** Product catalog data access (details gated behind registration).

**Contact:** apionboarding@samtec.com

**Note:** High-speed connector manufacturer. Manufacturer-direct channel, not a traditional distributor.

**Status:** To investigate. Register at developer portal.

---

### Schukat API (To Investigate)

**API:** SOAP-based (also supports JSON) | **Auth:** API key per company

**iDempiere Vendor:**
- BP ID: `1002515`
- Name: `Schukat Electronic Vertriebs GmbH`

**Capabilities:** Real-time pricing and stock/availability data.

**Access:** Registration form on website; API key sent by email. Credentials are non-transferable. Daily access limits monitored.

**Note:** German distributor. CalcuQuote has a live integration with their API. SOAP-based is older but functional.

**Status:** To investigate. Register for API key.

---

### SOS Electronic API (To Investigate)

**Portal:** [api-customer.sos.sk/docs](https://api-customer.sos.sk/docs)

**API:** REST/JSON | **Auth:** OAuth 2.0 (Bearer tokens) + Basic HTTP auth

**iDempiere Vendor:**
- BP ID: `1001178`
- Name: `SOS Electronic`

**Capabilities (documented):**
- Invoice retrieval (paid/unpaid, itemized)
- Open order tracking with delivery status
- Product delivery status by order

**Note:** Central/Eastern European distributor. Documented API focuses on order/invoice management. Product pricing/search may exist as separate undocumented endpoints. Contact sales rep to clarify.

**Status:** To investigate. Contact sales for full API scope.

---

### Bürklin API (To Investigate)

**Portal:** [buerklin.com/en/services/eprocurement](https://www.buerklin.com/en/services/eprocurement/)

**API:** Listed as available, plus OCI, cXML PunchOut, BMEcat, EDI

**iDempiere Vendor:**
- BP ID: `1004237` (Buerklin GmbH & Co.) / `1003563` (Burklin GmbH)
- Name: `Buerklin GmbH & Co.`

**Capabilities:** API listed alongside OCI, cXML, BMEcat, Stock Report, EDI (EDIFACT, EANCOM, IDOC, OpenTRANS, CSV).

**Contact:** Robert Mattheus, e-procurement@buerklin.com, +49 89 55875-110

**Note:** German distributor. No public API docs — access requires contacting e-procurement team. Setup reportedly 15-30 min for basic integration.

**Status:** To investigate. Contact e-procurement team for API documentation.

---

### Heilind Electronics (Pursuing EDI Feed)

**iDempiere Vendor:**
- BP ID: `1000351`
- Name: `Heilind Electronics`

**Note:** Major interconnect/electromech distributor (connectors, relays, sensors). No public REST API or developer portal. Strong on TE, Molex, Amphenol — overlap with existing API coverage should be measured before further investment.

**Scraping recon (2026-04-14):** estore.heilind.com is protected by Imperva/Incapsula WAF. Login form POSTs to `/api/` with hidden action key; submit handler is jQuery-bound. Headless Chromium triggers WAF tarpit (200 OK with empty body, no session cookie issued). Catalog search powered by Coveo; CAD models by SamacSys (`componentsearchengine.com`) — both **public-only**, neither exposes account-tier pricing or committed inventory. Stealth-plugin + residential-proxy approach is technically feasible (~85% success) but high-maintenance and breaks whenever Imperva updates rules. Manual cookie bootstrap lasts only 24-72h — not viable as long-term automation. **Decision:** scraping is not a durable path for login-gated data.

**Active path — EDI 832 / 846 feeds (Jake, 2026-04-14):**
- Distributors often have EDI price catalog (832) and inventory advice (846) feeds for accounts that ask, even when reps reflexively say "no API"
- Jake checking with colleagues whether Heilind EDI is already wired up on someone else's setup
- If yes: extend that feed to our pipeline; if no: rep ask via account team

**Fallback if EDI unavailable:** measure how many Heilind-only MPNs (not covered by TTI/Mouser/DigiKey/Newark/Arrow/Avnet/Master) actually appear in monthly RFQ flow. If <50/mo, manual lookups beat any automated solution. If hundreds, revisit stealth-plus-proxy scraping with eyes open to maintenance cost.

**Volume measurement (2026-05-11):** Pulled all RFQ line MPNs in Heilind-bucket MFRs (TE/Tyco, Molex, Amphenol, Samtec, Phoenix Contact, Wurth, Omron, Hirose, JST, 3M, Harting, Weidmuller) over the prior 90 days:

| Bucket | Line MPNs | Distinct MPNs |
|---|---:|---:|
| TE/Tyco | 1,626 | 1,059 |
| Molex | 946 | 670 |
| Samtec | 631 | 422 |
| Phoenix Contact | 596 | 160 |
| Amphenol | 554 | 456 |
| Wurth | 302 | 175 |
| Omron + Hirose + JST + 3M + Harting + Weidmuller | ~430 | ~370 |
| **Total** | **~5,166** | **~3,300** |

Of those 5,166 line-MPNs, **3,074 (60%) got zero VQ from any source** — approximately **1,025 unsourced lines/month** in Heilind's wheelhouse. Volume sits ~20× over the "<50/mo skip automation" threshold. Caveat: zero-VQ ≠ "Heilind would have closed it" — many were never pursued, customer-cancelled, or broker-only buys. Actual Heilind-rescue subset is unknown until tested.

**CalcuQuote-as-proxy (ruled out 2026-05-11):** CalcuQuote lists Heilind as a Supplier Partner. Their rep confirmed CQ does not expose API services, so it cannot be used as a programmatic proxy.

**Stealth-automation options under discussion (2026-05-11):**

Brainstormed the option space with first-party constraint (no new third-party SaaS — rules out Browserbase, residential-proxy services, anti-detect commercial browsers). All three viable options converge on the same OT-write pipeline (scraper → email to workflow inbox → `email-workflow-poller` → new `workflow-actions/heilind-loading.js` → `vq-writer`), so the differentiation is purely on the scraper side.

| Option | Where it runs | Setup | Profile | Risks |
|---|---|---|---|---|
| **A. Browser extension** | Manifest V3 in Jake's existing Chrome. Confirmed corporate policy allows dev-mode unpacked load (no Blocklist/Allowlist/AllowedTypes restrictions; only `ExtensionInstallForcelist` is set, which adds, doesn't block). | ~1 day. | Opportunistic — captures only pages Jake actually browses. | Volume-limited. Human-in-the-loop on every capture. |
| **B. Jake's laptop overnight** *(recommended)* | Playwright on Jake's work laptop, separate Chrome profile (`--user-data-dir`), Windows Task Scheduler ~2am. | ~1 day script + 2 hours workflow action. No new hardware, no new IT conversation. | Hands-free, bulk-capable, overnight only. Calibrated start 20/night, ramp gradually. | Laptop must stay on (corporate auto-shutdown could kill it). VPN drop = wrong IP. Endpoint security may flag 2am Chrome activity. |
| **C. Dedicated office box** | Spare laptop / NUC physically on corporate WAN. Same Playwright (or Claude computer-use) stack. | ~3-5 days incl. IT conversation. | 24/7 capacity. Cleanest stealth signature (consistent office IP, always-on). | IT politics around unmanaged hardware on LAN. Hardware ownership / lifecycle. |

**Stealth signature:** Heilind's office-IP requirement (Imperva fingerprints datacenter IP ranges) is why a cloud Windows VM in Azure or AWS, even on a first-party account, isn't viable without VPN-egress-through-office (its own networking project) — Options B and C bypass that by running on hardware that already has the office IP.

**Recommendation:** Option B as v1, with graduation to Option C if Jake's laptop proves operationally fragile (auto-shutdown, VPN drop, IT flags). Option B has the lowest setup cost AND produces empirical operational data to justify Option C if/when it's needed.

**Open questions for developer discussion (2026-05-12):**

1. Heilind session lifetime — does anyone know empirically how long an estore login persists?
2. Corporate VPN keep-alive — does it drop after inactivity?
3. IT auto-shutdown policy — does Group Policy force laptop shutdown at end of day? (If yes, Option B is blocked.)
4. Endpoint security (CrowdStrike/SentinelOne) behavior when scheduled task spawns Chrome at 2am.
5. Heilind ToU — explicit anti-automation clause?
6. UI selector stability — pilot Claude computer-use as driver instead of fragile CSS selectors?
7. MPN queue scoping — all unsourced Heilind-bucket lines, or value-threshold filter?

**Status:** Three viable options drafted (A/B/C). Dev review scheduled 2026-05-12. EDI 832/846 path remains the long-term answer; stealth automation is the bridge until EDI is wired up.

---

### PEI-Genesis (No Public API)

**iDempiere Vendor:**
- BP ID: `1000674`
- Name: `PEI-Genesis`

**Note:** Connector specialist (mil/aero, industrial). EDI integration available for supply chain partners. Web portal (MyPEI) for order management. No REST API.

**Status:** EDI only. Not a candidate for API integration.

---

### Distrelec (No Public API)

**iDempiere Vendor:**
- BP ID: `1005503`
- Name: `Distrelec Group AG`

**Note:** European distributor, now part of RS Group. Offers OCI (SAP), cXML PunchOut (Ariba), eCl@ss/UNSPSC classification. No REST API.

**Status:** E-procurement integrations only. RS Components API may cover same inventory.

---

### WIN SOURCE API (To Investigate)

**Portal:** [win-source.net/api-solution](https://www.win-source.net/api-solution)

**iDempiere Vendor:**
- BP ID: `1000740`
- Name: `Win Source Electronics`

**Capabilities:** Real-time pricing, inventory, product details, technical specifications. 1.1M+ SKUs, strong in obsolete/hard-to-find parts.

**Contact:** apisolution@win-source.net

**Note:** Independent distributor (not franchise for most lines). Founded 1999, serves 100+ countries. Aligns well with broker sourcing for hard-to-find parts.

**Status:** To investigate. Apply via web form.

---

### OnlineComponents.com API (To Investigate)

**Portal:** [onlinecomponents.com/en/api-suites](https://www.onlinecomponents.com/en/api-suites/)

**iDempiere Vendor:**
- BP ID: `1000882`
- Name: `Onlinecomponents.com`

**Capabilities:** Real-time inventory and pricing across 2.5M+ parts from 400+ suppliers. Contract pricing integration. Compliance data. Also supports EDI.

**Note:** Authorized distributor with broad linecard.

**Status:** To investigate. Contact sales or integration partners.

---

## Broker / Independent Distributor APIs

### Fusion Worldwide API (To Investigate)

**Portal:** [api.fusionww.com/docs](https://api.fusionww.com/docs) (Swagger) | **OpenAPI spec:** [api.fusionww.com/openapi.json](https://api.fusionww.com/openapi.json)

**API:** REST/JSON, OpenAPI 3.1 | **Auth:** Public tier (no auth) + Partner tier (Bearer token)

**iDempiere Vendor:**
- BP ID: `1006372` (listed as customer only — isvendor=N)
- Name: `Fusion Worldwide`

**Public Endpoints (no auth):**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/search?q={term}` | Full-text product search |
| GET | `/v1/catalog/products/{mpn}` | Lookup by MPN |
| GET | `/v1/catalog/categories` | Category hierarchy |
| GET | `/v1/catalog/manufacturers` | Manufacturer listing |
| GET | `/v1/search/suggest?q={prefix}` | Autocomplete |

**Partner Endpoints (Bearer token):**
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/partner/inventory/{mpn}` | Single MPN inventory |
| POST | `/v1/partner/inventory/batch` | Batch inventory (up to 100 MPNs) |
| GET | `/v1/partner/pricing/{mpn}` | Pricing with tier breaks |
| POST | `/v1/partner/pricing/batch` | Batch pricing (up to 100 MPNs) |
| POST | `/v1/partner/quotes/bom` | BOM quote (up to 100 lines) |
| POST | `/v1/partner/rfq` | RFQ submission |

**Catalog:** 700K+ components, 1,200+ categories, 800+ manufacturers

**Contact:** contact@fusionww.com for partner API access

**Note:** Large independent distributor with a modern, well-documented API. Public tier is unusual for a broker — gives free catalog/search. Partner tier adds pricing, inventory, batch operations, and RFQ submission.

**Status:** To investigate. Public tier can be tested immediately; partner tier requires contact.

---

### Quest Components API (To Investigate)

**Portal:** [questcomp.com/questapi.aspx](https://www.questcomp.com/questapi.aspx)

**API:** REST, JSON/XML | **Auth:** API key (issued after approval)

**iDempiere Vendor:**
- BP ID: `1000377`
- Name: `Quest Components`

**Capabilities:** Search inventory by MPN. Returns availability, pricing, lead times. Access to $60M+ inventory (1.5B+ parts).

**Access:** Submit request form with company name, contact info, use case, estimated daily call volume. Docs provided after approval.

**Note:** Broker specializing in obsolete & allocated parts. API docs are not public — provided after access approval.

**Status:** To investigate. Submit request form for API access.

---

## Aggregator APIs

### Octopart/Nexar API (Planned - Aggregator)

**Portal:** [nexar.com/api](https://nexar.com/api)

**Type:** GraphQL (migrated from REST)

**Pricing:** ~$25-200/month based on request volume

**Capabilities:** Aggregates 100+ distributor sources. Useful as fallback for parts not covered by direct APIs.

**Status:** Planned. Could serve as screening fallback when direct APIs don't have stock.

---

### TrustedParts API (Blocked - Access Denied)

**Portal:** [trustedparts.com/docs/api/trustedparts-api](https://www.trustedparts.com/docs/api/trustedparts-api/)

**API:** REST | **Auth:** Free user account + API access request

**Capabilities:** Authorized-only inventory search across 25M+ part numbers from 2,000+ manufacturers. Batch queries up to 50 parts/request. Swagger docs available.

**Note:** Run by ECIA (Electronic Components Industry Association) — franchise-only data. Advertised as free but **access denied to Astute** (likely restricted to OEMs/CMs, not brokers/resellers).

**Status:** Blocked. Access request denied.

---

### OEMSecrets API (Built - Aggregator, Rate Limited)

**Portal:** [oemsecrets.com/api](https://www.oemsecrets.com/api) | **Docs:** [oemsecretsapi.com/documentation](https://oemsecretsapi.com/documentation/)

**API:** REST/JSON (single GET endpoint) | **Auth:** API key as query parameter

**Capabilities:** Part search across 40M+ parts. Real-time pricing (full price breaks) and stock from 60+ distributors including Avnet, RS, Rochester, Verical, TME, EBV, Chip One Stop — plus all our direct-API distributors. Lead time, lifecycle, compliance (RoHS/Pb), datasheets.

**Module:** `Trading Analysis/RFQ Sourcing/franchise_check/oemsecrets.js`
- Filters out 11 distributors we already have direct APIs for (DigiKey, Arrow, Mouser, etc.)
- Surfaces ~49 incremental distributors per search
- CLI: `node oemsecrets.js <MPN> [qty] [--all]`
- `--all` flag includes direct-API distributors for cross-reference

**Rate Limit:** 10 calls/day (free tier, confirmed 3/27). Too low for bulk screening. Contacted OEMSecrets 3/27 to request higher tier.

**Status:** Module built and tested. **Blocked on rate limit increase.** If bumped to 500+/day, could replace FindChips scraping entirely (better data, zero maintenance). Not yet registered in `franchise-api.js` — will integrate when quota is sufficient.

---

### Supplyframe / FindChips API (To Investigate - Aggregator)

**Portal:** [dev.supplyframe.com](http://dev.supplyframe.com/)

**API:** Developer API | **Auth:** Application through developer portal

**Capabilities:** 600M+ MPNs. Pricing, availability, datasheets, lifecycle, parametric data. Powers PartQuest, Altium integration.

**Note:** Astute already uses FindChips via Playwright for franchise screening. The official API would replace browser automation with a more reliable, faster programmatic interface. Now owned by Siemens.

**Status:** To investigate. Apply through developer portal.

---

## Component Intelligence APIs

### SiliconExpert API (To Investigate)

**Portal:** [siliconexpert.com/products/api](https://www.siliconexpert.com/products/api/)

**API:** REST | **Auth:** Paid subscription (free trial available)

**Capabilities:** 1B+ components. Lifecycle status, obsolescence forecasts, compliance (RoHS/REACH), parametric data, cross-references, inventory data. Silver package (static) vs. Gold package (dynamic EOL predictions). Connects to PLM/CAD/ERP tools.

**Note:** Not a pricing API — lifecycle and obsolescence intelligence. High value for BOM Monitoring (workflow #12) and Vortex Matches (workflow #10) for knowing when parts are going EOL before quoting.

**Status:** To investigate. Request free trial to evaluate.

---

### Z2Data (To Investigate)

**Portal:** [z2data.com](https://www.z2data.com/)

**API:** REST | **Auth:** Paid platform

**Capabilities:** Risk scoring, lifecycle management, compliance (1B+ parts, 150K+ suppliers), geographic risk, sub-tier supplier mapping. All data exportable via API.

**Note:** Supply chain risk intelligence. Complements pricing APIs with "should we even source this part" risk data.

**Status:** To investigate. Contact for API access and pricing.

---

### Waldom Electronics API (Active)

**Production URL:** `https://api.waldom.com`
**Swagger:** `https://api.waldom.com/swagger/index.html`
**Portal:** [sandbox.waldom.com](https://sandbox.waldom.com/en/WaldomAPISuite/GettingStarted)

**Regional portals:**
- Americas: sandbox.waldom.com
- APAC: sandbox.waldomapac.com
- EMEA: sandbox.waldomemea.com

**iDempiere Vendor:**
- BP ID: `1000644`
- BP Value: `1002648`
- Name: `Waldom Electronics`

**Auth:** API key in URL path: `/api/v1/{ApiKey}/...`

**Endpoints (from Swagger):**
- `GET /api/v1/{ApiKey}/InventoryAndPricing/{Term}/{InStockOnly}/{ExactMatch}/{ResultsCount}` — Primary search (inventory + pricing)
- `GET /api/v1/{ApiKey}/Inventory` — Inventory only (POST required)
- `GET /api/v1/{ApiKey}/Pricing` — Pricing only
- `GET /api/v1/{ApiKey}/ProductSearch/{Term}/{InStockOnly}/{ExactMatch}/{ResultsCount}` — Product search
- `POST /api/v1/{ApiKey}/OrderAPI` — Place orders
- `GET /api/v1/{ApiKey}/OrderAPI/{PONumber}` — Order status
- `GET /api/v1/{ApiKey}/AsnAPI/{PONumber}` — ASN/shipping
- `GET /api/v1/{ApiKey}/InvoiceAPI/{PONumber}` — Invoices

**Capabilities:**
- **Store API Suite:** Order placement, management, tracking, invoice retrieval
- **Inventory & Pricing API Suite:** Real-time inventory and pricing data

**Script:** `Trading Analysis/RFQ Sourcing/franchise_check/waldom.js`
**Activated:** 2026-03-25
**Status:** Active. Integrated into `shared/franchise-api.js` as distributor #8.

---

### Analog Devices API (To Investigate)

**Portal:** [analog.com/en/support/api-suites.html](https://www.analog.com/en/support/api-suites.html)

**iDempiere Vendor:**
- BP ID: `1000774`
- Name: `Analog Devices`

**Capabilities:**
- **Ordering API:** Order placement, tracking, modifications, milestone notifications, order documentation
- Product search, pricing, availability

**Status:** Developer portal exists. Need to register and evaluate.

---

### Wurth Electronics API (To Investigate)

**Portal:** [we-online.com/en/support/collaboration/api](https://www.we-online.com/en/support/collaboration/api)

**iDempiere Vendor:** Not in database (passive component manufacturer)

**Capabilities:** REST API for system integration. Contact sales rep for access and credentials.

**Note:** European passive component manufacturer. May be useful for specific product lines.

**Status:** Contact sales representative for API access.

---

### LCSC Electronics API (To Investigate)

**Portal:** [lcsc.com/docs/index.html](https://www.lcsc.com/docs/index.html)

**Agent Portal:** [lcsc.com/agent](https://www.lcsc.com/agent)

**iDempiere Vendor:**
- BP ID: `1002898`
- Name: `Shenzhen LCSC Electronics Technology Co., Ltd`

**Capabilities:** 8 API services including real-time pricing (regular + discounted), product details, order creation.

**Note:** China-based distributor. Large catalog, competitive pricing on passives. Good for Asia sourcing.

**Status:** Need LCSC account to apply for API access.

---

### Sourceability / Sourcengine API (To Investigate)

**iDempiere Vendor:**
- BP ID: `1000261`
- Name: `Sourceability North America`

**Capabilities:**
- **Sourcengine Order API:** Research, quote, purchase from 3,500+ suppliers globally
- ERP/MRP integration for automated procurement

**Note:** Marketplace aggregator model - connects to thousands of suppliers, not just their own stock.

**Status:** Contact for API access. Integrated with CalcuQuote.

---

### RS Components API (To Investigate)

**iDempiere Vendor:**
- BP ID: `1000554`
- Name: `RS Components International`

**Capabilities:** Pricing, availability. App ID required from sales representative.

**Note:** Web price only - no customer-specific pricing via API currently.

**Status:** Contact local sales rep for API App ID.

---

### Electro Sonic API (To Investigate)

**iDempiere Vendor:**
- BP ID: `1000404`
- Name: `Electro Sonic Group, Inc.`

**Capabilities:** MPN search, pricing, availability via API. Integrated with CalcuQuote.

**Note:** Canadian distributor, part of Master Electronics group.

**Status:** Contact account manager or CalcuQuote for API access.

---

## MRO / Industrial Supplier APIs

### McMaster-Carr API (Blocked - Access Denied)

**Portal:** [mcmaster.com/help/api](https://www.mcmaster.com/help/api/)
**Contact:** eprocurement@mcmaster.com

**API:** REST API (8 endpoints) | **Auth:** Client certificate + Bearer token (24hr expiry)

**iDempiere Vendor:**
- BP ID: `1000918`
- BP Value: `1002922`
- Name: `McMaster-Carr`

**Status:** Access denied. McMaster reserves API access for long-standing customers and does not provide access to other distributors as company policy.

**TODO:**
- [x] ~~Email eprocurement@mcmaster.com to request API integration~~ — Denied (distributor policy)
- [ ] ~~Evaluate subscription model feasibility~~ — N/A
- [ ] ~~Determine relevant product categories~~ — N/A

---

## LLM / AI APIs

**Status:** Planned | **Priority:** Later

AI-assisted extraction and inference for edge cases.

| Provider | Use Case | Status |
|----------|----------|--------|
| Anthropic (Claude) | VQ extraction fallback, vendor name inference | Planned |

**Implementation details:** See `Trading Analysis/RFQ Sourcing/sourcing-roadmap.md` Section C7

---

## API Response Caching

**Status:** Planned | **Priority:** High | **Location:** `shared/franchise-api.js`

Cache franchise API responses to avoid duplicate calls across workflows and within large RFQ runs. Caching applies to ALL API consumers (LAM Kitting, Franchise Screening, Stock RFQ, Vortex, Quick Quote).

### Design

**Cache key:** MPN + distributor
**Storage:** JSON file(s) in `shared/cache/` or `/tmp/franchise-cache/`
**Stores:** Full API response (all price breaks, stock levels, lead time) — each workflow picks the relevant price break for its context

### TTL Rules

Locked 2026-04-08 — used by `RFQ API Enrichment` workflow (cron-driven, every-RFQ pass). The canonical TTL-by-RFQ-type table lives here; the workflow doc references this section.

| RFQ Type | TTL | Rationale |
|----------|-----|-----------|
| PPV | 30 days | Stable customer PPV parts — infrequent pricing churn |
| Astute Franchised | 30 days | Franchise-sourced, stable supply chain |
| Shortage | 7 days | Volatile inventory, needs fresher reads |
| Stock | 14 days | Broker-to-broker quoting; hot parts refresh via inbound activity, 14d is upper bound for quiet MPNs. Catches tightening within ~2 broker quotes vs 30d (too stale on tightening) and 7d (wastes quota in deep channels). Updated 2026-05-11. |
| EOL/LTB | 7 days | Declining stock, but inventory levels shift fast |
| 3PL/VMI | 7 days | Kitting pulls, qty-driven freshness |
| Hot Parts | 7 days | High-urgency by definition |
| Proactive Offer | 7 days | Market-timed, needs current reads |
| *(any type)* + cached price < customer target | Force refresh | Confirm inventory is still available at that price |

### Interface (proposed)

```javascript
const results = await searchAllDistributors(mpn, qty, {
  cacheTTL: '7d',           // default
  // or for PPV:
  cacheTTL: '30d',
  // or conditional refresh:
  cacheBypassIf: (cached) => cached.lowestPrice < customerTarget,
});
```

### Dual Purpose: Cache + VQ

Every API call serves two purposes:

1. **Cache (local JSON)** — fast rate-limit check before making API calls
2. **VQ (database)** — permanent pricing record via `shared/rfq-writer.js`

On each API call:
1. Check cache → if within TTL, return cached data (no API call)
2. If stale → make API call → write cache file + write VQ lines to `ai_writeback`
3. All price breaks captured as VQ lines:
   - Stock qty > 0 at a price break → VQ with availability
   - Price break qty > available stock → lead time quote
4. VQ history feeds Quick Quote, suggested resale, market data

The cache prevents duplicate API calls. The VQs build pricing history over time.

### Why This Matters
- Large RFQs (300+ lines x 8 APIs = 2,400+ calls) hit rate limits
- Same MPN appearing across multiple RFQs/workflows gets queried repeatedly
- Pricing data is stable enough for weekly caching; inventory is the variable
- Each workflow displays different price breaks from the same cached data (MOQ for LAM, qty-1 for Vortex, customer qty for Quick Quote)
- VQ history provides pricing trends and feeds downstream quoting workflows

---

## Pricing Envelope OT-Native Storage

**Status:** Blocked on iDempiere config | **Priority:** Later | **Owner:** TBD (needs iDempiere admin)
**Discovered:** 2026-04-08 W1 testing
**Current workaround:** thin-pointer rows + local cache (shipped)

### Background

`shared/api-result-writer.js` was originally designed to write the full franchise API envelope (per-distributor price ladders, stock, lead times, HTS/ECCN, etc.) into `adempiere.chuboe_pricing_api_result.json_info` via the iDempiere REST API. The vision was that every API call would build a snapshot OT could query directly — Vortex Matches, Quick Quote, Hurricane Search, and any future "pricing trend over time" report would read from one canonical OT location.

### What We Discovered (W1 Test, 2026-04-08)

Running three POST tests against prod with Tsunami User credentials (role 1000004):

| Test | Payload | Result |
|---|---|---|
| Minimal POST (linkage fields only) | `{Chuboe_Pricing_API_Result_UU, MPNs}` | ✅ **200, id assigned** |
| POST with `Chuboe_JSON_Info_Text` (PascalCase from ad_column) | adds JSON envelope | ✗ **500: "Cannot update virtual column Chuboe_JSON_Info_Text"** |
| POST with `json_info` (lowercase postgres) | adds JSON envelope | ✗ **500: "Column json_info does not exist"** |

**Findings:**
1. **Role permissions are NOT a blocker.** Tsunami User can create rows in `chuboe_pricing_api_result` via REST. The earlier `project_api_production_status.md` note ("blocked by WebService User role 1000056") was based on a different role than we actually use, and is moot.
2. **The JSON column is virtual in the iDempiere data dictionary.** Postgres physically has `json_info jsonb` (the legacy Flux/CalcuQuote pipeline writes there directly via SQL — last write 2024-12-30), but `ad_column` registers it as `Chuboe_JSON_Info_Text` with `IsVirtual=Y`. Virtual columns are read-only via REST.
3. **No writable text/json field is exposed by the REST model** for this table. The fields it exposes for write are: `AD_Table_ID`, `Record_ID`, `MPNs`, `Chuboe_Pricing_API_Result_UU`. That's enough for a thin-pointer row, not enough for an envelope.

### Current Workaround (Shipped 2026-04-08)

`api-result-writer.js` `writeDb()` was patched to **thin-pointer mode**:

- Writes one row per pull with `MPNs` (comma-separated list, varchar 255), `AD_Table_ID + Record_ID` (linkage to source RFQ), `Chuboe_Pricing_API_Result_UU`, and the auto-populated `Created` timestamp.
- The **full pricing envelope stays in the local cache** (`shared/data/api-pricing-cache/{MPN}_{date}.json`) and is the canonical store.
- `extractPriceAtQty()` already falls back to cache when DB has no JSON content, so all read-side consumers (Vortex, QQ, Hurricane) keep working.

What we get from the thin-pointer rows today:
- "We pulled API data for this RFQ on this date for these MPNs" — visible in OT, joinable to the source RFQ
- Time-series of API call activity per RFQ / MPN list / source workflow
- Auditability of who pulled what and when

What we don't get until this is unblocked:
- Per-distributor price ladders, stock levels, lead times queryable via OT-native SQL
- Pricing trend over time without re-pulling APIs
- Hurricane Search reading our envelopes (it currently reads the legacy Flux data, which we don't write to)

### Resolution Options

**Option 1 — Un-virtualize the existing column.** Have an iDempiere admin flip `Chuboe_JSON_Info_Text` from `IsVirtual=Y` to `IsVirtual=N`. The underlying postgres column already exists as `json_info jsonb`. Risk: changes the data dictionary in a way that could affect any other consumer of the virtual definition. Need to verify nothing depends on the current virtual SQL expression.

**Option 2 — Add a new physical text column.** Create a new column on `adempiere.chuboe_pricing_api_result` (e.g., `chuboe_envelope_text` or similar), register it in `ad_column` as a regular `Text` reference type, REST API will then expose it for writes. Lower-risk than un-virtualizing because it's additive.

**Option 3 — Use `ai_writeback.chuboe_pricing_api_result` instead.** If the `ai_writeback` schema has a parallel table that's not bound by the production data dictionary's virtual-column constraint, we could write there. Unclear whether this schema is still active or planned for retirement.

### Pre-Work Before Unblocking

1. Confirm the virtual column's SQL expression — what does `Chuboe_JSON_Info_Text` actually compute today? `SELECT columnsql FROM adempiere.ad_column WHERE columnname = 'Chuboe_JSON_Info_Text';`
2. Audit whether any Hurricane Search / OT report depends on the virtual column's current behavior (if so, un-virtualizing breaks them).
3. Decide between Option 1 and Option 2 with whoever owns iDempiere config (Jake or Chuck).
4. If Option 2: pick the column name carefully — if the new column is `Chuboe_JSON_Info_Text_New` and the legacy is kept around as an alias, consumers would need migration.

### Definition of Done

- [ ] iDempiere data dictionary change applied (Option 1 or 2)
- [ ] `api-result-writer.js` `writeDb()` updated to include the JSON envelope in the payload
- [ ] Smoke test: POST envelope succeeds, GET-by-id returns the envelope content
- [ ] One real franchise screening run produces visible envelope rows in `chuboe_pricing_api_result`
- [ ] `extractPriceAtQty()` updated to read DB-first when envelopes are present (currently falls back to cache)
- [ ] `project_api_production_status.md` memory note updated to remove the stale role-perm theory
- [ ] Backfill: run `flushCacheToDB()` to import accumulated cache entries into OT

### Why This Is Parked

The thin-pointer workaround is good enough for current consumer patterns:
- Vortex / QQ / Hurricane all read from local cache successfully today
- We don't have a "pricing trend over time" report yet that would benefit from OT-native queryability
- Adding it later is a one-line change to writeDb() once the column is writable — no consumer churn

The unblock has real value (especially as we accumulate more snapshots and build trend analysis), but it's not on the critical path for any current workflow.

---

## ROI Tracker Follow-ups

Cross-cutting items surfaced by the ROI tracker rollout (2026-05-11, commits `71c11c7` + `39b543c`). These are bot-performance / API-surface concerns that span multiple distributors; each is also tracked in `~/workspace/deferred-work.md` for active-backlog visibility.

### LT-VQ suppression check in `synthesizeStockLtVqLines`

**Status:** Open — to verify | **Priority:** Medium (affects every API that returns LT pricing) | **Surfaced:** 2026-05-11

Live probe via `~/workspace/oneoffs/probe-coverage-gaps.js` showed several DigiKey responses returning `found=true stockQty=0 cost=$X` (LT pricing valid even with no stock). If `synthesizeStockLtVqLines` in `shared/franchise-api.js` gates VQ row emission on `stockQty > 0`, we are silently suppressing those LT-flavor VQ rows across the entire enrichment pipeline (RFQ enrichment, Quick Quote, Vortex Matches, Hurricane).

**Probe evidence:**
- `FOD8314` qty=205 → DK returned `found=true stockQty=0 cost=$1.12`
- `PRM48AF480T400A00` qty=90 → DK returned `found=true stockQty=0 cost=$111.71`

In both cases human buyers eventually purchased the parts from DK at or near those quoted prices — so the LT pricing was legitimate and actionable.

**To investigate:** Read `synthesizeStockLtVqLines` (≈ line 190 of `shared/franchise-api.js`). Trace whether a non-zero `cost` with `stockQty=0` produces an LT-tagged row in the output array. If suppressed, fix to emit one LT row when `cost` is present, with `qty=rfqQty` and `leadTime` populated.

**Cross-listed:** `~/workspace/deferred-work.md` § Investigations — 🟢 ready.

### Diagnostic envelope retention (lighter cousin of OT-native storage)

**Status:** Considered — not started | **Priority:** Low | **Surfaced:** 2026-05-11

The 2026-05-11 coverage-gap investigation required live-reprobing DK + Arrow APIs because the thin-pointer rows in `chuboe_pricing_api_result` (per § "Pricing Envelope OT-Native Storage" above) carry no response body. We had to query the APIs in real time to find out what they returned at the moment Claude enriched — and the answer may have changed since.

**Lighter scope than the full Pricing Envelope unblock:** capture a compact per-call summary (`ts, distributor, mpn, qty, found, stockQty, vqPrice, error_msg, latency_ms, http_status`) in NDJSON files under `~/workspace/.api-pricing-cache/diagnostics/{YYYY-MM-DD}/`. No iDempiere dependency. Append-only, rotate weekly, auto-delete after 90 days.

**Distinct from § "Pricing Envelope OT-Native Storage"** which is about full OT-queryable envelopes (blocked on iDempiere admin un-virtualizing a column). This is local-disk retention for retrospective diagnosis only. Both can ship independently.

**Cross-listed:** `~/workspace/deferred-work.md` § Decisions — 🅿️ parked.

### Bucket 3b distributor prioritization signal

**Status:** Self-populating — review quarterly | **Surfaced:** 2026-05-11

The ROI tracker's "Bucket 3b: No API for this distributor" classifies Adoption Real-Sourcing lines where the winning vendor is a franchise/catalog/authorized type but the BP isn't in Claude's API-coverage set. Over time this accumulates a ranked list of distributors worth integrating — Heilind, RS Components, Symmetry, Allied are likely candidates per the existing "To investigate" entries elsewhere in this roadmap.

**Today (30d window, 2026-05-12):** 2 lines / \$2.04 — not actionable yet.

**Review cadence:** Quarterly. First scheduled review ~2026-08-12 (90 days after `39b543c` shipped). When a distributor surfaces with material revenue (\$5K+ in a 90d window, or repeated appearance across multiple windows), promote it from "To investigate" to "In Progress" status in § Franchise Distributor APIs above.

**How to read:** `node scripts/vq-enrichment-roi-tracker.js --window 90 --dry-run` → log line shows `noApi=N/$X`. Drill into source lines via the rendered email under § "Bucket 3b — No API for this distributor".

**Cross-listed:** `~/workspace/deferred-work.md` § Time-conditional reminders — 🟡 future-dated.

### `shared/business-segments.js` rollout to other reports

**Status:** Built (`71c11c7`), adoption pending | **Surfaced:** 2026-05-11

The canonical Adoption / LAM Kitting / Stock RFQ segment classifier lives at `astute-workinstructions/shared/business-segments.js`. Only the ROI tracker uses it today. BOM Monitoring, seller-activity reports, and any future bot-activity scorecard that mixes those segments should adopt the shared module to keep the "winning vs efficiency" framing consistent (Adoption = competitive wins; LAM/Stock = autonomous-flow efficiency).

**Memory reference:** `feedback_roi_framing_winning_vs_efficiency.md`. Pull-when-touched is fine — no urgent driver.

**Cross-listed:** `~/workspace/deferred-work.md` § Decisions — 🅿️ parked.

### Transactional-window shared utility

**Status:** Inlined in one consumer, candidate for extraction | **Surfaced:** 2026-05-11

The `<60min` RFQ→first-sold-CQ check (= "RFQ created to process an order, no real sourcing competition") and the 1-24hr "needs review" gate live inlined in `scripts/vq-enrichment-roi-tracker.js`. Any future alert / dashboard / scorecard that talks about "Claude misses" must run this filter first — otherwise it conflates salesperson order-documentation workflow with actual competitive losses.

**Extract when:** A second consumer wants the classification. Move to `shared/sourcing-window.js` with `classifyWindow(rfqCreated, firstSoldCqCreated) → 'processOrder' | 'needsReview' | 'realSourcing'`.

**Memory reference:** `feedback_check_window_before_miss_narrative.md` (the rule: any "miss" report must run the window filter first).

**Cross-listed:** `~/workspace/deferred-work.md` § Decisions — 🅿️ parked.

---

## Future Integrations

Placeholder for other API integrations as needs arise:

- Shipping/logistics APIs (FedEx, UPS, DHL)
- Currency conversion APIs
- Compliance/export control APIs
- Customer portal integrations

---

## Monitoring & Alerts

**Status:** Planned

| Feature | Description | Status |
|---------|-------------|--------|
| Teams webhook alerts | POST to Teams channel when API fails | Planned |
| API health check script | `node api-health.js` to test all APIs on demand | Planned |
| End-of-run summary | Show API success/fail counts after screening | Planned |

**Teams webhook setup:** Create Incoming Webhook connector in Teams channel, paste URL into config.

---

## Environment Setup

All API keys are stored in `~/workspace/.env`:

```bash
# Franchise APIs
DIGIKEY_CLIENT_ID=
DIGIKEY_CLIENT_SECRET=
ARROW_API_KEY=
MOUSER_API_KEY=
OCTOPART_API_KEY=

# LLM APIs
ANTHROPIC_API_KEY=
```

**Security notes:**
- `.env` is gitignored — never commit credentials
- Individual projects load from this central file
- Rotate keys periodically

---

*Last updated: 2026-03-19*
