# API Integration Roadmap

Cross-cutting roadmap for external API integrations. Individual implementations live in workflow-specific roadmaps; this provides the centralized view.

**Central Config:** `~/workspace/.env` (all API keys stored here)

---

## Overview

| API Category | Use Cases | Count | Roadmap Reference |
|--------------|-----------|-------|-------------------|
| Franchise Distributors | Pricing, stock, screening | 25 | `rfq_sourcing/sourcing-roadmap.md` § A1 |
| Broker / Independent | Pricing, inventory, RFQ | 2 | This file |
| Aggregators | Multi-source search, screening | 4 | This file |
| Component Intelligence | Lifecycle, risk, compliance | 2 | This file |
| MRO / Industrial Suppliers | Pricing, specs, procurement | 1 | This file |
| LLM / AI | Quote extraction, vendor inference | 1 | `rfq_sourcing/sourcing-roadmap.md` § C7 |

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
| Sager Electronics | REST (API key) | developer.sager.com | **To investigate** | 1000335 |
| Rochester Electronics | REST (?) | api.rocelec.com | **To investigate** | 1000058 |
| Mouser | REST (API key) | mouser.com/api-hub | **Blocked** | 1000334 |
| Octopart/Nexar | GraphQL | nexar.com/api | Planned (aggregator) | — |
| Avnet | OAuth2 REST | apiportal.avnet.com | **Pending docs** | 1000002 |
| Venkel | REST (?) | venkel.com | **Pending docs** | 1001951 |
| Texas Instruments | OAuth2 REST | api-portal.ti.com | **Pending approval** | 1001369 |
| Master Electronics | REST v2 (path params) | masterelectronics.com/en/gettingstarted | **Active** | 1000405 |
| Allied Electronics | EDI (?) | Unknown | **To investigate** | 1000392 |
| Waldom Electronics | REST | sandbox.waldom.com | **To investigate** | 1000644 |
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

**Code:** `rfq_sourcing/franchise_check/digikey.js`

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

**Implementation details:** See `rfq_sourcing/sourcing-roadmap.md` Section A

**Key files:**
- `~/workspace/.env` — API credentials
- `rfq_sourcing/franchise_check/digikey.js` — DigiKey API module
- `rfq_sourcing/franchise_check/` — Screening workflow

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

**Code:** `rfq_sourcing/franchise_check/arrow.js`

**Usage:**
```bash
node arrow.js LM317T 100
```

**Source filtering:** Arrow API returns both arrow.com (franchise) and Verical.com (marketplace). We filter to arrow.com sources only (AMERICAS, EUROPE, APAC).

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

**Code:** `rfq_sourcing/franchise_check/rutronik.js`

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

**Code:** `rfq_sourcing/franchise_check/future.js`

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

**Code:** `rfq_sourcing/franchise_check/newark.js`

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

**Code:** `rfq_sourcing/franchise_check/tti.js`

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

### Sager Electronics API (To Investigate)

**Portal:** [developer.sager.com](https://developer.sager.com/)

**iDempiere Vendor:**
- BP ID: `1000335`
- Name: `Sager - v3004`

**Capabilities:** Pricing, inventory, order management.

**Status:** Developer portal exists. Need to register and evaluate.

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

**Status:** OAuth works but API returns "no apiproduct match found" - need to subscribe to Inventory and Pricing API product in the TI portal.

**iDempiere Vendor:**
- BP ID: `1001369`
- Name: `Texas Instruments`

---

### Avnet API (Pending Docs)

**Subscription Key:** `067a6c51a2b04ca3ae39c85fd27f7fe2`
**Auth Header:** `Ocp-Apim-Subscription-Key: <key>`

**iDempiere Vendor:**
- BP ID: `1000051` (primary, 6,971 VQ lines) — also `1000002` (legacy, 1 VQ line from 2018)
- Related entities: Avnet EM (1000336), Avnet EMG Ltd (1000202, 1000426), Avnet Silica (1004943), Avnet Technology HK (1000376)
- Combined VQ volume: ~9,800 lines
- Name: `Avnet`

**Status:** Have subscription key but need to log in to [apiportal.avnet.com](https://apiportal.avnet.com/) to see endpoint URLs. The portal mentions a `getPriceAndQty` API but exact path is behind login.

---

### Mouser API (Blocked)

**Issue:** API returns `PriceBreaks: []` and `AvailabilityInStock: null` with message "Not available for purchase by distributors."

Mouser restricts pricing/availability data for distributor accounts. The API still works for:
- Part details, descriptions
- Lead times
- Lifecycle status (EOL, obsolete)
- Suggested replacements
- Compliance data (HTS, ECCN, RoHS)

**Action needed:** Contact Mouser to request pricing API access, or use for non-pricing use cases only.

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

**Code:** `rfq_sourcing/franchise_check/master.js`

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

### Heilind Electronics (No Public API)

**iDempiere Vendor:**
- BP ID: `1000351`
- Name: `Heilind Electronics`

**Note:** Major interconnect/electromech distributor (connectors, relays, sensors). No public API or developer portal found. May offer EDI for large accounts. Site protected by WAF (Incapsula/Imperva).

**Status:** No API available. Monitor for future availability.

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

### OEMSecrets API (To Investigate - Aggregator)

**Portal:** [oemsecrets.com/api](https://www.oemsecrets.com/api) | **Docs:** [oemsecretsapi.com/documentation](https://oemsecretsapi.com/documentation/)

**API:** REST/JSON | **Auth:** Free API key (apply on site, approval required)

**Capabilities:** Part search across 40M+ parts. Real-time pricing and stock from DigiKey, Farnell, RS, Arrow, Mouser, Avnet, Future, and more. BOM tool data. Global coverage.

**Note:** Strong aggregator alternative to Octopart. Multi-distributor price comparison in one API call. Free tier available.

**Status:** To investigate. Apply for free API key.

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

### Waldom Electronics API (To Investigate)

**Portal:** [sandbox.waldom.com](https://sandbox.waldom.com/en/WaldomAPISuite/GettingStarted)

**Regional portals:**
- Americas: sandbox.waldom.com
- APAC: sandbox.waldomapac.com
- EMEA: sandbox.waldomemea.com

**iDempiere Vendor:**
- BP ID: `1000644`
- Name: `Waldom Electronics`

**Capabilities:**
- **Store API Suite:** Order placement, management, tracking, invoice retrieval
- **Inventory & Pricing API Suite:** Real-time inventory and pricing data

**Access:** API key from customer profile → "API Access and Services" section. Full sandbox environment available.

**Status:** Developer portal exists with sandbox. Need to register and evaluate.

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

### McMaster-Carr API (To Investigate)

**Portal:** [mcmaster.com/help/api](https://www.mcmaster.com/help/api/)
**Contact:** eprocurement@mcmaster.com

**API:** REST API (8 endpoints) | **Auth:** Client certificate + Bearer token (24hr expiry)

**iDempiere Vendor:**
- BP ID: `1000918`
- BP Value: `1002922`
- Name: `McMaster-Carr`

**Endpoints:**
| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/login` | Obtain authorization token |
| POST | `/v1/logout` | Expire authorization token |
| PUT | `/v1/products` | Subscribe to product data |
| DELETE | `/v1/products` | Unsubscribe from product data |
| GET | `/v1/products/{partNumber}` | Product specifications |
| GET | `/v1/products/{partNumber}/price` | Current pricing |
| GET | `/v1/images/{path}` | Product images |
| GET | `/v1/cad/{path}` | CAD files (DWG, STEP) |

**Access model:** Approval-based. Email eprocurement@mcmaster.com to begin integration. McMaster issues a client certificate and password per approved customer.

**Capabilities:**
- Product specs, pricing, images, CAD files
- Subscription model — must subscribe to products before retrieving data
- Rate-limited on bandwidth-intensive endpoints (CAD, images)
- User quotas on total subscriptions and daily additions

**Use cases for Astute:**
- Automated pricing lookups for MRO/industrial parts (hardware, tools, raw materials)
- Product spec retrieval for kitting/BOM support

**Restrictions:**
- Not a traditional electronic component distributor — MRO/industrial supplies
- Subscription-per-product model adds complexity vs. simple search APIs
- Client certificate auth is more involved than API key auth

**Status:** To investigate. Need to email eprocurement@mcmaster.com to request API access.

**TODO:**
- [ ] Email eprocurement@mcmaster.com to request API integration
- [ ] Evaluate subscription model feasibility for Astute's use case
- [ ] Determine which product categories are relevant (fasteners, thermal, etc.)

---

## LLM / AI APIs

**Status:** Planned | **Priority:** Later

AI-assisted extraction and inference for edge cases.

| Provider | Use Case | Status |
|----------|----------|--------|
| Anthropic (Claude) | VQ extraction fallback, vendor name inference | Planned |

**Implementation details:** See `rfq_sourcing/sourcing-roadmap.md` Section C7

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
