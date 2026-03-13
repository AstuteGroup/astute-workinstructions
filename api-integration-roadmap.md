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
| Mouser | REST (API key) | mouser.com/api-hub | **Blocked** | 1000334 |
| Octopart | REST + GraphQL | octopart.com/api/home | Planned | — |
| Newark/element14 | REST | developer.element14.com | Planned | 1000390 |
| Avnet | OAuth2 REST | apiportal.avnet.com | **Pending docs** | 1000002 |
| Venkel | REST (?) | venkel.com | **Pending docs** | 1001951 |
| Texas Instruments | OAuth2 REST | api-portal.ti.com | **Pending approval** | 1001369 |

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

*Last updated: 2026-03-13*
