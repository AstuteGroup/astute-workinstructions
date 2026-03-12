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
| Mouser | REST (API key) | mouser.com/api-hub | Planned | 1000334 |
| Octopart | REST + GraphQL | octopart.com/api/home | Planned | — |
| Newark/element14 | REST | developer.element14.com | Planned | 1000390 |
| Future Electronics | TBD | Contact required | Planned | 1000328 |

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

*Last updated: 2026-03-12*
