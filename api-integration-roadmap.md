# API Integration Roadmap

Cross-cutting roadmap for external API integrations. Individual implementations live in workflow-specific roadmaps; this provides the centralized view.

**Central Config:** `~/workspace/.env` (all API keys stored here)

---

## Overview

| API Category | Use Cases | Roadmap Reference |
|--------------|-----------|-------------------|
| Franchise Distributors | Pricing, stock, screening | `rfq_sourcing/sourcing-roadmap.md` § A1 |
| LLM / AI | Quote extraction, vendor inference | `rfq_sourcing/sourcing-roadmap.md` § C7 |
| *Future* | TBD | — |

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
| TTI | REST (apiKey header) | developer.tti.com | **Active** (Lead Time) | 1000326 |
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

### TTI API (Active — Lead Time)

**API:** Lead Time API (POST) + Search API (GET) + Quote API (not yet subscribed)
**Auth:** `apiKey` header (custom Azure APIM header — NOT `Ocp-Apim-Subscription-Key`)

**Portal:** [developer.tti.com](https://developer.tti.com/)

**Credentials:**
| Key | Product | Value |
|-----|---------|-------|
| Search API Key | Search (manufacturers list) | `9cafe5893ee04935a82d2c5ab663cf26` |
| Lead Time API Key | Lead Time (stock, LT, lifecycle) | `ee0620712e46441296dd77341d6179e8` |
| Quote API Key | Quote line items | *(not yet subscribed)* |

**Endpoints:**
| Method | Path | API Key | Description |
|--------|------|---------|-------------|
| POST | `/leadtime/v1/requestLeadtime` | Lead Time | Stock, lead time, lifecycle, CoO |
| GET | `/service/api/v1/search/manufacturers` | Search | Manufacturer code reference list |
| GET | `/quote/v2/{quoteId}/lineitems?page=X&size=Y` | Quote | Quote line items (needs key) |

**Lead Time API Request:**
```json
POST /leadtime/v1/requestLeadtime
Headers: apiKey: <key>, Content-Type: application/json, Cache-Control: no-cache

{ "description": "Lookup description", "partNumbers": ["MPN1", "MPN2", "MPN3"] }
```

**Lead Time API Response:**
```json
{
  "leadTimes": [{
    "requestedPartNumber": "C0805C104K5RACTU",
    "ttiPartNumber": "C0805C104K5RACTU",
    "manufacturerPartNumber": "C0805C104K5RAC7800",
    "leadTime": "14",           // weeks
    "available": 2832000,       // stock qty
    "mfrAlias": "KEM",          // manufacturer code
    "lifeCycle": "Active",
    "countryOfOrigin": "CN",
    "customerEntity": "NDC",
    "availableOnOrder": [{"quantity": 0, "date": "N/A"}]
  }],
  "totalCount": 1
}
```

**Rate limit:** ~5 seconds between lead time calls

**iDempiere Vendor:**
- BP ID: `1000326`
- BP Value: `1002330`
- Name: `TTI Inc`

**Code:** `rfq_sourcing/franchise_check/tti.js`

**Usage:**
```bash
# Single part lookup
node tti.js C0805C104K5RACTU 100

# Batch lookup (all sent in one API call)
node tti.js ERJ-6ENF1001V C0805C104K5RACTU LM317T

# List manufacturer codes
node tti.js --manufacturers
```

**Current Use (Active):**
| Field | Use |
|-------|-----|
| `franchiseQty` | Stock available from `available` field |
| `vqLeadTime` | Lead time in weeks |
| `vqLifeCycle` | Active/EOL/etc. |
| `vqCoo` | Country of origin |
| `vqManufacturer` | Resolved from mfrAlias code |
| `vqSku` | TTI part number |
| `vqVendorNotes` | "TTI stock: X \| LT: Y \| CoO: Z \| Mfr: W" |

**Limitations:**
- **No pricing data** — TTI API does not expose price breaks via Lead Time API
- Pricing may be available via Quote API (needs subscription key)
- Parts not in TTI catalog return `ttiPartNumber: "Not a TTI Part"`
- TTI specializes in passives & connectors — most semiconductor MPNs won't match

**TODO:**
- [ ] Subscribe to Quote API for pricing data
- [ ] Test batch size limits (currently using 20 per request)
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
- BP ID: `1000002`
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

### Octopart/Nexar API (Planned - Aggregator)

**Portal:** [nexar.com/api](https://nexar.com/api)

**Type:** GraphQL (migrated from REST)

**Pricing:** ~$25-200/month based on request volume

**Capabilities:** Aggregates 100+ distributor sources. Useful as fallback for parts not covered by direct APIs.

**Status:** Planned. Could serve as screening fallback when direct APIs don't have stock.

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

*Last updated: 2026-03-18*
