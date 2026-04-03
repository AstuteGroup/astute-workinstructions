# iDempiere REST API Write-Back

Single source of truth for writing data to iDempiere via the REST API. Replaces the prior `ai_writeback` PostgreSQL schema approach.

**Status:** Production API connected (`http://172.31.28.106:8080/api/v1`). Write operations currently blocked by role permissions (403) — see [Current Blocker](#current-blocker) below.

**Code:** `shared/api-client.js` — shared module used by all write consumers.

---

## End-to-End Workflow

### Step 1: Configure Credentials (Do Not Skip)

1. Open `~/workspace/.env`
2. Fill in the iDempiere variables:
   ```
   IDEMPIERE_BASE_URL=http://172.31.28.106:8080/api/v1
   IDEMPIERE_USERNAME=your_username
   IDEMPIERE_PASSWORD=your_password
   IDEMPIERE_CLIENT_ID=1000000
   IDEMPIERE_ROLE_ID=1000056
   IDEMPIERE_ORG_ID=1000000
   ```
3. Verify: `node -e "require('./astute-workinstructions/shared/api-client').login().then(t => console.log('OK', t.token.substring(0,20)+'...')).catch(e => console.error(e.message))"`

**Output:** `OK eyJhbGciOiJIUzI1Ni...` confirms the connection works.

### Step 2: Use Consumer Modules (Unchanged Interfaces)

```javascript
// RFQ writing
const { writeRFQ } = require('../shared/rfq-writer');
const result = await writeRFQ({ bpartnerId: 1000190, type: 'Stock', lines: [...] });

// Offer writing
const { writeOffer } = require('../shared/offer-writeback');
const result = await writeOffer({ bpartnerId: 1000332, offerTypeId: 1000008, lines: [...] });

// CQ writing (customer quotes — flat, no header)
const { writeCQ, writeCQBatch } = require('../shared/cq-writer');
const result = await writeCQ('1141355', { mpn: 'ADS1115IDGST', qty: 500, resale: 5.25 });
const batch = await writeCQBatch('1141355', lines);  // lines = [{ mpn, qty, resale, ... }]

// VQ writing (two-pass: exact match → fuzzy resolution for review)
const { writeVQBatch, writeReviewedItems } = require('../shared/vq-writer');
const vqResult = await writeVQBatch('1131217', items);
// vqResult.needsReview → show to user, then:
await writeReviewedItems('1131217', vqResult.needsReview);

// API pricing results — same interface as before
const { writePricingResult } = require('../shared/api-result-writer');
await writePricingResult({ searchResult, mpn, qty, source: 'workflow-name' });
```

### Step 3: Verify Write (Optional)

```javascript
const { apiGet } = require('../shared/api-client');
const record = await apiGet('chuboe_rfq', { id: result.rfqId });
console.log(record);
```

---

## Authentication

### One-Step Login

Reference: [iDempiere REST API Authentication](https://bxservice.github.io/idempiere-rest-docs/docs/api-guides/authentication)

Credentials and auth parameters are sent in a single POST. The `parameters` block selects the client, role, and org in the same request.

```
POST {BASE_URL}/auth/tokens
Content-Type: application/json

{
  "userName": "your_username",
  "password": "your_password",
  "parameters": {
    "clientId": 1000000,
    "roleId": 1000056,
    "organizationId": 1000000
  }
}
```

**Response:**
```json
{
  "token": "eyJhbGciOi...",
  "refresh_token": "eyJhbGciOi...",
  "userId": 1047761,
  "language": "en_US"
}
```

The returned `token` is fully authorized for `/models/` API calls.

#### Auth Values (from .env)

| Env Variable | Value | Description |
|-------------|-------|-------------|
| `IDEMPIERE_CLIENT_ID` | 1000000 | Tsunami |
| `IDEMPIERE_ROLE_ID` | 1000056 | WebService User |
| `IDEMPIERE_ORG_ID` | 1000000 | Tsunami |

#### Discovery Endpoints (optional, for exploring available roles/orgs)

If you omit the `parameters` block, the POST returns a pre-auth token and available clients. Use these to discover valid values:
- `GET /auth/roles?client=1000000`
- `GET /auth/organizations?client=1000000&role=1000056`

### Token Lifecycle

| Token | Lifetime | Renewal |
|-------|----------|---------|
| Access token (JWT) | 1 hour (configurable) | Auto-refreshed by `api-client.js` at 5min before expiry |
| Refresh token | 24 hours | Single-use — reusing triggers security breach and invalidates all tokens |

### Token Refresh

```
POST {BASE_URL}/auth/refresh
Content-Type: application/json

{
  "refresh_token": "current_refresh_token",
  "clientId": 1000000,
  "userId": 1047761
}
```

**Response:**
```json
{
  "token": "new_access_token",
  "refresh_token": "new_refresh_token"
}
```

Refresh tokens are single-use. Reusing a consumed refresh token triggers a security breach and invalidates all related tokens.

### Logout

```
POST {BASE_URL}/auth/logout
Content-Type: application/json

{
  "token": "current_access_token"
}
```

---

## Credential Management

### Best Practices

1. **Never commit credentials.** The `.env` file is gitignored. The `.env.example` template in `shared/` shows the required variables.
2. **One central `.env` file** at `~/workspace/.env` stores all API keys (franchise APIs, iDempiere, etc.). Updated 2026-03-31 with real production credentials.
3. **Role requirements:** The iDempiere user must have a role with `Role Type` set to `WebService` or blank. Current role: `WebService User` (ID 1000056).
4. **Rotate credentials** if a token security breach is detected (refresh token reuse).
5. **Production API** is at `http://172.31.28.106:8080/api/v1` (direct internal IP, HTTP — bypasses the expired SSL cert on `test.orangetsunami.com`).

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `IDEMPIERE_BASE_URL` | Yes | API base URL: `http://172.31.28.106:8080/api/v1` (no trailing slash) |
| `IDEMPIERE_USERNAME` | Yes | iDempiere login username |
| `IDEMPIERE_PASSWORD` | Yes | iDempiere login password |
| `IDEMPIERE_CLIENT_ID` | No | Override AD_Client_ID (default: 1000000) |
| `IDEMPIERE_ORG_ID` | No | Override AD_Org_ID (default: 0) |
| `IDEMPIERE_ROLE_ID` | No | Override Role ID for multi-tenant setups |

---

## ID Management

### Key Change from ai_writeback

With the REST API, **iDempiere assigns primary keys server-side** using its internal sequences. This eliminates the 9000000+ ID block hack.

| Aspect | ai_writeback (old) | REST API (new) |
|--------|-------------------|----------------|
| ID assignment | Client-side, 9000000+ block | Server-side, auto-assigned |
| Collision risk | Possible if production sequences reach 9M | None — server controls all sequences |
| ID retrieval | Known before INSERT | Extracted from POST response body |
| Multi-record writes | Pre-allocate all IDs up front | Sequential: POST parent → get ID → POST children |

### `id` vs `Value` (Search Key) in API Responses

The API POST response contains two important identifiers:
- **`id`** — The internal primary key (e.g., `chuboe_rfq_id = 1133457`). Used for parent-child linking and programmatic references.
- **`Value`** — The **search key** / user-facing document number (e.g., `"1124042"`). This is what users see in the OT UI as the RFQ number, offer number, etc.

**Always extract and return BOTH** from the response:
- Use `id` for subsequent API calls (e.g., POST children with parent's `id`)
- Use `Value` when communicating results to the user (e.g., "Created RFQ 1124042")

```javascript
const rfq = await apiPost('chuboe_rfq', { ... });
const internalId = rfq.id;        // 1133457 — for parent-child linking
const searchKey  = rfq.Value;     // "1124042" — user-facing document number
console.log(`Created RFQ ${searchKey} (internal ID: ${internalId})`);
```

### Parent-Child Write Pattern

For hierarchical records (e.g., RFQ → RFQ Line → RFQ Line MPN):

```javascript
// 1. POST header — server assigns ID
const rfq = await apiPost('chuboe_rfq', headerPayload);
const rfqId = rfq.id;  // server-assigned

// 2. POST line — reference parent ID from step 1
const line = await apiPost('chuboe_rfq_line', { ...linePayload, chuboe_rfq_id: rfqId });
const lineId = line.id;

// 3. POST line MPN — reference both parent IDs
await apiPost('chuboe_rfq_line_mpn', { ...mpnPayload, chuboe_rfq_line_id: lineId, chuboe_rfq_id: rfqId });
```

**Do not use batch for parent-child writes** — each child needs the parent's server-assigned ID.

---

## API Endpoints

### CRUD Operations

| Operation | Method | Endpoint | Notes |
|-----------|--------|----------|-------|
| Create | POST | `/models/{table}` | Returns created record with server-assigned ID |
| Read one | GET | `/models/{table}/{id}` | Returns single record |
| Read many | GET | `/models/{table}?$filter=...` | OData-style filtering |
| Update | PUT | `/models/{table}/{id}` | Partial update, returns updated record |
| Delete | DELETE | `/models/{table}/{id}` | Permanent delete |
| Batch | POST | `/batch` | Multiple independent operations |

### Required Headers

```
Authorization: Bearer {token}
Content-Type: application/json
```

### OData Query Parameters

| Parameter | Example | Purpose |
|-----------|---------|---------|
| `$filter` | `$filter=Name eq 'Acme'` | Filter records |
| `$select` | `$select=Name,Value` | Return specific columns |
| `$orderby` | `$orderby=Created desc` | Sort results |
| `$top` | `$top=10` | Limit results |
| `$skip` | `$skip=20` | Pagination offset |
| `$expand` | `$expand=C_BPartner_Location` | Include related records |

---

## Error Handling

### HTTP Status Codes

| Code | Meaning | Action |
|------|---------|--------|
| 200 | Success | — |
| 201 | Created | Extract ID from response |
| 400 | Bad request | Fix payload (missing required field, invalid value) |
| 401 | Token expired | Auto-refresh token and retry (once) |
| 403 | No permission | Check role permissions for table |
| 404 | Not found | Record or table doesn't exist |
| 500 | Server error | Retry with backoff (max 3 attempts) |

### Retry Strategy (implemented in api-client.js)

- **401:** Refresh token → retry once
- **5xx:** Exponential backoff: 1s, 2s, 4s (max 3 attempts)
- **4xx (except 401):** Fail immediately — payload error, no retry

---

## Batch Operations

Use `POST /batch` for multiple **independent, sibling-level** writes:

```json
POST /api/v1/batch
Content-Type: application/json

[
  { "method": "POST", "resource": "/models/chuboe_offer_line", "body": { ... } },
  { "method": "POST", "resource": "/models/chuboe_offer_line", "body": { ... } }
]
```

**Do NOT batch parent-child writes** — children need the parent's server-assigned ID.

---

## iDempiere Standard Fields (Auto-Populated)

The following fields are **automatically populated by the server** from the authenticated session. Do NOT include them in POST/PUT payloads:

| Field | Server Behavior |
|-------|-----------------|
| `AD_Client_ID` | From session (clientId in auth) |
| `AD_Org_ID` | From session (organizationId in auth) |
| `IsActive` | Defaults to `true` |
| `CreatedBy` | Logged-in user ID |
| `UpdatedBy` | Logged-in user ID |
| `Created` | Server timestamp |
| `Updated` | Server timestamp |
| `id` | Server-assigned primary key |
| `uid` | Server-generated UUID |

**Source:** [iDempiere REST API - Creating Data](https://bxservice.github.io/idempiere-rest-docs/docs/api-guides/crud-operations/creating-data)

**Field naming (CONFIRMED 2026-03-31):** The iDempiere REST API requires **exact PascalCase** column names as defined in `ad_column.columnname`. Lowercase or snake_case names are rejected with a 500 error: `"Wrong name for column"`. This applies to table names too — `ad_table.tablename` is PascalCase (e.g., `Chuboe_RFQ` not `chuboe_rfq`).

To look up the exact column names for any table:
```sql
SELECT c.columnname FROM adempiere.ad_column c
JOIN adempiere.ad_table t ON c.ad_table_id = t.ad_table_id
WHERE t.tablename = 'Chuboe_RFQ' AND c.isactive = 'Y';
```

The `api-client.js` module handles this mapping transparently for consumer modules. When writing payloads directly, use the column names exactly as they appear in `ad_column.columnname`.

---

## Table Payload Structures

For each table: required fields (NOT NULL, no default), commonly-used optional fields, and an example JSON payload. Standard fields (listed above) are auto-populated and omitted from examples.

---

### 1. c_bpartner (Business Partner)

**Use:** Creating new customers or vendors.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `Value` | string | **Yes** | Search key (unique identifier, e.g., `AST-1234`) |
| `Name` | string | **Yes** | Display name |
| `C_BP_Group_ID` | number | **Yes** | Business partner group ID |
| `IsCustomer` | boolean | No (default N) | Is this a customer? |
| `IsVendor` | boolean | No (default N) | Is this a vendor? |
| `IsSummary` | boolean | No (default N) | Summary entry? |
| `IsProspect` | boolean | No (default N) | Prospect? |
| `IsEmployee` | boolean | No (default N) | Employee? |
| `IsSalesRep` | boolean | No (default N) | Sales rep? |

**Example:**
```json
{
  "Value": "NEWVENDOR-001",
  "Name": "New Broker LLC",
  "C_BP_Group_ID": 1000000,
  "IsVendor": true,
  "IsCustomer": false
}
```

---

### 2. c_bpartner_location (Business Partner Address)

**Use:** Adding addresses to a business partner. Requires a parent `c_bpartner`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `C_BPartner_ID` | number | **Yes** | Parent business partner |
| `Name` | string | **Yes** | Location label (e.g., "HQ", "Warehouse") |
| `C_Location_ID` | number | No | Link to address record (if pre-existing) |
| `IsBillTo` | boolean | No (default Y) | Bill-to address? |
| `IsShipTo` | boolean | No (default Y) | Ship-to address? |
| `IsPayFrom` | boolean | No (default Y) | Pay-from address? |
| `IsRemitTo` | boolean | No (default Y) | Remit-to address? |
| `Phone` | string | No | Phone number |
| `Phone2` | string | No | Secondary phone |
| `Fax` | string | No | Fax number |

**Example:**
```json
{
  "C_BPartner_ID": 1000190,
  "Name": "Main Office",
  "IsBillTo": true,
  "IsShipTo": true
}
```

---

### 3. ad_user (Contact)

**Use:** Creating contacts on a business partner. Requires a parent `c_bpartner` and a `c_bpartner_location`.

**IMPORTANT:** Always create the BP and location first, then the contact. Never write a contact without a location — it won't be usable in OT. When creating contacts interactively, gather all required fields (BP, location, name, email) before POSTing. If multiple locations exist on the BP, prompt the user to choose.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `Name` | string | **Yes** | Contact name (max 60 chars) |
| `C_BPartner_ID` | number | **Yes** | Parent business partner |
| `C_BPartner_Location_ID` | number | **Yes** | Location/address on that BP — query existing locations and select |
| `EMail` | string | **Yes*** | Email address (max 60 chars). *Not enforced by DB but required for usability |
| `Phone` | string | No | Phone number (max 40 chars) |
| `Phone2` | string | No | Secondary phone |
| `Title` | string | No | Job title (max 40 chars) |
| `Description` | string | No | Notes (max 255 chars) |
| `IsFullBPAccess` | boolean | No (default Y) | Can see all BP data? |
| `IsBillTo` | boolean | No (default N) | Bill-to contact? |
| `IsShipTo` | boolean | No (default N) | Ship-to contact? |
| `NotificationType` | string | No (default X) | `X` = None, `E` = Email, `N` = Notice, `B` = Both |
| `Fax` | string | No | Fax number |
| `Comments` | string | No | Extended comments (max 2000 chars) |

**Dependency chain:** `c_bpartner` → `c_bpartner_location` → `ad_user`

**Example:**
```json
{
  "Name": "Jane Smith",
  "C_BPartner_ID": 1005694,
  "C_BPartner_Location_ID": 1007031,
  "EMail": "jane.smith@uctec.com",
  "Phone": "+86-755-8303-8598",
  "Title": "Purchasing Manager",
  "IsFullBPAccess": true
}
```

**Server auto-assigns:** `Value` (search key, defaults to generic like `"acontact"`), `AD_Client_ID`, `AD_Org_ID`, `IsActive`, `Created/Updated/By`.

**Tested:** 2026-04-03 on test instance. Both POST (create) and PUT (update) confirmed working.

---

### 4. c_order (Sales/Purchase Order Header)

**Use:** Creating SO or PO headers. Complex — many required fields with no defaults.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `IsSOTrx` | boolean | **Yes** | `true` = Sales Order, `false` = Purchase Order |
| `DocumentNo` | string | **Yes** | Document number (e.g., `AI-SO-001`) |
| `DocStatus` | string | **Yes** | Document status (`DR` = Draft) |
| `DocAction` | string | **Yes** | Next action (`CO` = Complete) |
| `C_DocType_ID` | number | **Yes** | Document type |
| `C_DocTypeTarget_ID` | number | **Yes** | Target document type |
| `DateOrdered` | string | **Yes** | Order date (ISO format) |
| `DateAcct` | string | **Yes** | Accounting date (ISO format) |
| `C_BPartner_ID` | number | **Yes** | Customer/vendor |
| `C_BPartner_Location_ID` | number | **Yes** | Partner address |
| `C_Currency_ID` | number | **Yes** | Currency (100 = USD) |
| `PaymentRule` | string | **Yes** | Payment rule (`P` = On Credit) |
| `C_PaymentTerm_ID` | number | **Yes** | Payment terms |
| `InvoiceRule` | string | **Yes** | Invoice rule (`I` = Immediate) |
| `DeliveryRule` | string | **Yes** | Delivery rule (`F` = Force) |
| `FreightCostRule` | string | **Yes** | Freight cost rule (`I` = Included) |
| `DeliveryViaRule` | string | **Yes** | Delivery via (`S` = Shipper) |
| `PriorityRule` | string | **Yes** | Priority (`5` = Medium) |
| `M_Warehouse_ID` | number | **Yes** | Warehouse |
| `M_PriceList_ID` | number | **Yes** | Price list |

**Example:**
```json
{
  "IsSOTrx": true,
  "DocumentNo": "AI-SO-001",
  "DocStatus": "DR",
  "DocAction": "CO",
  "C_DocType_ID": 1000030,
  "C_DocTypeTarget_ID": 1000030,
  "DateOrdered": "2026-03-30",
  "DateAcct": "2026-03-30",
  "C_BPartner_ID": 1000190,
  "C_BPartner_Location_ID": 1000120,
  "C_Currency_ID": 100,
  "PaymentRule": "P",
  "C_PaymentTerm_ID": 1000000,
  "InvoiceRule": "I",
  "DeliveryRule": "F",
  "FreightCostRule": "I",
  "DeliveryViaRule": "S",
  "PriorityRule": "5",
  "M_Warehouse_ID": 1000000,
  "M_PriceList_ID": 1000000
}
```

---

### 5. c_orderline (Order Line)

**Use:** Adding lines to a sales/purchase order. Requires a parent `c_order`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `C_Order_ID` | number | **Yes** | Parent order |
| `Line` | number | **Yes** | Line number (10, 20, 30...) |
| `DateOrdered` | string | **Yes** | Line order date |
| `M_Warehouse_ID` | number | **Yes** | Warehouse |
| `C_UOM_ID` | number | **Yes** | Unit of measure |
| `QtyEntered` | number | **Yes** | Quantity entered |
| `QtyOrdered` | number | No (default 0) | Quantity ordered |
| `PriceEntered` | number | **Yes** | Unit price |
| `PriceActual` | number | No (default 0) | Actual price |
| `C_Currency_ID` | number | **Yes** | Currency |
| `C_Tax_ID` | number | **Yes** | Tax category |
| `M_Product_ID` | number | No | Product |
| `chuboe_mpn` | string | No | MPN on order line |
| `chuboe_cpc` | string | No | CPC on order line |
| `chuboe_vq_line_id` | number | No | Link to vendor quote |
| `chuboe_cq_line_id` | number | No | Link to customer quote |
| `chuboe_rfq_line_id` | number | No | Link to RFQ line |

**Example:**
```json
{
  "C_Order_ID": 1000500,
  "Line": 10,
  "DateOrdered": "2026-03-30",
  "M_Warehouse_ID": 1000000,
  "C_UOM_ID": 100,
  "QtyEntered": 500,
  "QtyOrdered": 500,
  "PriceEntered": 3.50,
  "PriceActual": 3.50,
  "C_Currency_ID": 100,
  "C_Tax_ID": 1000000,
  "chuboe_mpn": "ADS1115IDGST",
  "chuboe_vq_line_id": 1000200
}
```

---

### 6. chuboe_rfq (RFQ Header)

**Use:** Creating customer RFQ records. Primary write path for Stock RFQ Loading.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `C_BPartner_ID` | number | No* | Customer (*always provided in practice) |
| `chuboe_rfq_type_id` | number | No* | RFQ type (*always provided) |
| `SalesRep_ID` | number | No | Salesperson (default: 1000004 Jake Harris) |
| `r_status_id` | number | No (default NULL) | Status (1000022 = New) |
| `Description` | string | No | Customer reference / notes |
| `Processed` | string | No (default N) | Processing flag |
| `chuboe_initialload_api` | string | No (default Y) | API-loaded flag |

**RFQ Type IDs:**

| Type | ID |
|------|----|
| Stock | 1000007 |
| Shortage | 1000000 |
| PPV | 1000001 |
| EOL/LTB | 1000003 |
| Hot Parts | 1000013 |
| Unqualified Spot RFQ | 1000012 |

**Example:**
```json
{
  "C_BPartner_ID": 1000190,
  "chuboe_rfq_type_id": 1000007,
  "SalesRep_ID": 1000004,
  "r_status_id": 1000022,
  "Description": "Stock RFQ from broker email",
  "Processed": "N",
  "chuboe_initialload_api": "Y",
  "chuboe_csv_import": "N",
  "customerquotereport": "N",
  "chuboe_rfq_torequest_button": "N",
  "chuboe_amer_rfq2buyerqueue": "N",
  "chuboe_apac_rfq2buyerqueue": "N",
  "chuboe_emea_rfq2buyerqueue": "N",
  "chuboe_india_rfq2buyerqueue": "N",
  "add_pricing_api_vendor": "N",
  "chuboe_search_vendor": "N",
  "chuboe_search_stock": "N",
  "chuboe_multi_rfqtobuyerqueue": "N",
  "chuboe_japn_rfq2buyerqueue": "N",
  "chuboe_csv_cqmass": "N"
}
```

---

### 7. chuboe_rfq_line (RFQ Line — CPC Level)

**Use:** Adding lines to an RFQ. One line per CPC.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chuboe_rfq_id` | number | **Yes** | Parent RFQ (from POST response) |
| `Line` | number | No | Line number (10, 20, 30...) |
| `Qty` | number | No | Quantity |
| `PriceEntered` | number | No | Target price |
| `chuboe_cpc` | string | No | Customer part code |

**Example:**
```json
{
  "chuboe_rfq_id": 1131300,
  "Line": 10,
  "Qty": 500,
  "PriceEntered": 0
}
```

---

### 8. chuboe_rfq_line_mpn (RFQ Line MPN — MPN/MFR Level)

**Use:** Attaching MPN/MFR details to an RFQ line. One per MPN per CPC.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chuboe_rfq_line_id` | number | **Yes** | Parent RFQ line (from POST response) |
| `chuboe_rfq_id` | number | No* | Denormalized RFQ header ID (*always provided) |
| `chuboe_mpn` | string | **Yes** (NOT NULL) | Part number |
| `chuboe_mpn_clean` | string | No | Cleaned MPN (alphanumeric only) |
| `chuboe_mfr_id` | number | No | Manufacturer ID (from chuboe_mfr) |
| `chuboe_mfr_text` | string | No | Manufacturer name (text fallback) |
| `Qty` | number | No | Quantity |
| `PriceEntered` | number | No | Target price |
| `Description` | string | No | Part description |
| `chuboe_date_code` | string | No | Date code requirement |
| `chuboe_rfq_mpn_to_vq_button` | string | No | Button flag (set to `N`) |

**Example:**
```json
{
  "chuboe_rfq_line_id": 5000100,
  "chuboe_rfq_id": 1131300,
  "chuboe_mpn": "ADS1115IDGST",
  "chuboe_mpn_clean": "ADS1115IDGST",
  "chuboe_mfr_id": 1019796,
  "chuboe_mfr_text": "Texas Instruments",
  "Qty": 500,
  "PriceEntered": 0,
  "Description": "16-bit ADC, I2C, MSOP-10",
  "chuboe_rfq_mpn_to_vq_button": "N"
}
```

---

### 9. chuboe_vq_line (Vendor Quote Line — Flat)

**Use:** Recording vendor quotes. Flat table (no header).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chuboe_rfq_id` | number | No* | RFQ header reference (*always provided) |
| `chuboe_rfq_line_id` | number | No* | RFQ line reference (*always provided) |
| `C_BPartner_ID` | number | No* | Vendor (*always provided) |
| `chuboe_mpn` | string | No* | Part number (*always provided) |
| `chuboe_mpn_clean` | string | No | Cleaned MPN |
| `chuboe_mfr_id` | number | No | Manufacturer ID |
| `chuboe_mfr_text` | string | No | Manufacturer text |
| `Cost` | number | No | **Buy price** (NOT `PriceEntered`) |
| `Qty` | number | No | Quantity |
| `chuboe_date_code` | string | No | Date code |
| `chuboe_lead_time` | string | No | Lead time |
| `chuboe_buyer_id` | number | No | Buyer |
| `chuboe_vendortype_id` | number | No | Vendor type |
| `C_Currency_ID` | number | No | Currency (100 = USD) |
| `chuboe_moq` | string | No | MOQ |
| `chuboe_spq` | string | No | SPQ |
| `chuboe_datequotetrx` | string | No | Quote date |
| `chuboe_po_string` | string | No | PO reference (Infor POV) |
| `chuboe_package_desc` | string | No | Packaging |
| `chuboe_rohs` | string | No | RoHS status |
| `chuboe_note_public` | string | No | Vendor notes |
| `C_Country_ID` | number | No | Country of origin |
| `Processed` | string | No (default N) | Processing flag |

**CRITICAL:** VQ uses `Cost` for buy price, NOT `PriceEntered`. See `shared/data-model.md`.

**CRITICAL:** `Chuboe_MFR_ID` — many manufacturers are system records (`AD_Client_ID = 0`). These **cannot be FK-referenced** by client-level writes (returns 500: "System ID cannot be used"). When `resolveMFR()` returns `isSystem: true`, omit `Chuboe_MFR_ID` from the payload and rely on `Chuboe_MFR_Text` only. The `vq-writer.js` module handles this automatically.

**Note:** Vendor notes go in `Chuboe_Note_Public`, NOT `Chuboe_Vendor_Notes` (which doesn't exist on this table).

**Example:**
```json
{
  "chuboe_rfq_id": 1131200,
  "chuboe_rfq_line_id": 5000050,
  "C_BPartner_ID": 1000456,
  "chuboe_mpn": "ADS1115IDGST",
  "chuboe_mpn_clean": "ADS1115IDGST",
  "chuboe_mfr_text": "Texas Instruments",
  "Cost": 3.50,
  "Qty": 1000,
  "chuboe_date_code": "2024+",
  "chuboe_lead_time": "Stock",
  "C_Currency_ID": 100,
  "chuboe_datequotetrx": "2026-03-30",
  "Processed": "N"
}
```

---

### 10. chuboe_cq_line (Customer Quote Line — Flat)

**Use:** Recording customer quotes. Flat table (no header).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chuboe_rfq_id` | number | No* | RFQ header reference |
| `chuboe_rfq_line_id` | number | No* | RFQ line reference |
| `C_BPartner_ID` | number | No* | Customer |
| `chuboe_mpn` | string | No* | Part number |
| `chuboe_mpn_clean` | string | No | Cleaned MPN |
| `chuboe_mfr_id` | number | No | Manufacturer ID |
| `chuboe_mfr_text` | string | No | Manufacturer text |
| `chuboe_cpc` | string | No | Customer part code |
| `chuboe_cpc_clean` | string | No | Cleaned CPC |
| `Qty` | number | No | Quantity |
| `PriceEntered` | number | No | **Sell price** (resale to customer) |
| `chuboe_date_code` | string | No | Date code |
| `chuboe_lead_time` | string | No | Lead time |
| `chuboe_datequotetrx` | string | No | Quote date |
| `IsSold` | string | No (default N) | Was this sold? (Y/N) |
| `IsChuboeIncludeInQuote` | string | No (default Y) | Include in quote? |
| `Processed` | string | No (default N) | Processing flag |

**Example:**
```json
{
  "chuboe_rfq_id": 1131200,
  "chuboe_rfq_line_id": 5000050,
  "C_BPartner_ID": 1000190,
  "chuboe_mpn": "ADS1115IDGST",
  "chuboe_cpc": "CUST-ADC-001",
  "Qty": 500,
  "PriceEntered": 5.25,
  "chuboe_datequotetrx": "2026-03-30",
  "IsSold": "N",
  "IsChuboeIncludeInQuote": "Y",
  "Processed": "N"
}
```

---

### 11. chuboe_offer (Offer Header)

**Use:** Creating market inventory offer records. Primary write path for Market Offer Uploading.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `C_BPartner_ID` | number | No* | Vendor/source (*always provided) |
| `chuboe_offer_type_id` | number | No* | Offer type (*always provided) |
| `Description` | string | No | Offer description |
| `DateTrx` | string | No | Transaction date |
| `chuboe_user_id` | number | No | User ID |
| `chuboe_buyer_id` | number | No | Buyer ID |

**Offer Type IDs:** See `shared/offer-writeback.js` `OFFER_TYPES` constant for full mapping.

**Example:**
```json
{
  "C_BPartner_ID": 1000332,
  "chuboe_offer_type_id": 1000008,
  "Description": "Weekly inventory refresh 2026-03-30",
  "DateTrx": "2026-03-30",
  "chuboe_csv_import": "N",
  "chuboe_pulllmarketofferinto": "N",
  "add_pricing_api_vendor": "N",
  "chuboe_search_vendor": "N"
}
```

---

### 12. chuboe_offer_line (Offer Line — CPC Level)

**Use:** Adding line items to an offer. One per MPN.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chuboe_offer_id` | number | **Yes** | Parent offer (from POST response) |
| `Line` | number | No | Line number |
| `chuboe_mpn` | string | **Yes** (NOT NULL) | Part number |
| `chuboe_mpn_clean` | string | No | Cleaned MPN |
| `chuboe_mfr_id` | number | No | Manufacturer ID |
| `chuboe_mfr_text` | string | No | Manufacturer text |
| `Qty` | number | No | Quantity |
| `PriceEntered` | number | No | List/offer price |
| `apl_offer_recommendedresale` | number | No | Suggested resale price |
| `chuboe_date_code` | string | No | Date code |
| `chuboe_lead_time` | string | No | Lead time |
| `chuboe_package_desc` | string | No | Packaging |
| `chuboe_moq` | string | No | MOQ |
| `chuboe_spq` | string | No | SPQ |
| `chuboe_cpc` | string | No | Customer part code |
| `chuboe_cpc_clean` | string | No | Cleaned CPC |
| `C_Country_ID` | number | No | Country of origin |
| `C_Currency_ID` | number | No | Currency |
| `Description` | string | No | Line description |

**Example:**
```json
{
  "chuboe_offer_id": 2000100,
  "Line": 10,
  "chuboe_mpn": "ADS1115IDGST",
  "chuboe_mpn_clean": "ADS1115IDGST",
  "chuboe_mfr_text": "Texas Instruments",
  "Qty": 500,
  "PriceEntered": 3.50,
  "apl_offer_recommendedresale": 5.25,
  "chuboe_date_code": "2024+"
}
```

---

### 13. chuboe_offer_line_mpn (Offer Line MPN — Cross-Reference)

**Use:** Adding MPN cross-references to an offer line.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `chuboe_offer_line_id` | number | **Yes** | Parent offer line |
| `chuboe_mpn` | string | **Yes** (NOT NULL) | Cross-reference MPN |
| `chuboe_mpn_clean` | string | No | Cleaned MPN |
| `Description` | string | No | Description |

**Example:**
```json
{
  "chuboe_offer_line_id": 3000200,
  "chuboe_mpn": "ADS1115IDGST",
  "chuboe_mpn_clean": "ADS1115IDGST",
  "Description": "16-bit ADC, I2C, MSOP-10"
}
```

---

## Migration from ai_writeback

### What Changed

| Aspect | ai_writeback (SQL) | REST API |
|--------|-------------------|----------|
| Write method | `psqlExec(INSERT INTO ai_writeback.table ...)` | `apiPost('table', jsonPayload)` |
| ID assignment | Client-side (9000000+) | Server-side (auto) |
| Auth | PostgreSQL connection (no auth needed) | JWT Bearer token |
| Timestamps | `CURRENT_TIMESTAMP` in SQL | Server-set (or include in payload) |
| Error feedback | `psqlExec()` returns true/false | HTTP status + JSON error body |
| Batch writes | Multiple INSERT statements | `/batch` endpoint |

### What Stays the Same

- **Consumer interfaces:** `writeRFQ()`, `writeOffer()`, `writePricingResult()` — identical signatures
- **Read operations:** All queries against `adempiere` schema still use `psqlQuery` from `db-helpers.js`
- **Field names and values:** Same columns, same type IDs, same enums
- **Validation:** Same input validation in rfq-writer.js and offer-writeback.js

### Code Changes Summary

| Module | Change |
|--------|--------|
| `shared/api-client.js` | **New** — REST API client |
| `shared/rfq-writer.js` | Imports `apiPost` from api-client; replaces `psqlExec` + `getNextId` |
| `shared/offer-writeback.js` | Imports `apiPost` from api-client; replaces `psqlExec` + `getNextId` |
| `shared/api-result-writer.js` | `writeDb()` uses `apiPost`; `isDbAvailable()` checks API connectivity |
| `shared/db-helpers.js` | **Unchanged** — still used for read queries |

---

## Open Questions

1. ~~**API field naming convention:**~~ **RESOLVED (2026-03-31)** — PascalCase required. See [iDempiere Standard Fields](#idempiere-standard-fields-auto-populated) section above. Lowercase/snake_case returns 500 `"Wrong name for column"`.
2. ~~**Auto-populated fields:**~~ **RESOLVED (2026-04-01)** — Per [iDempiere REST API docs](https://bxservice.github.io/idempiere-rest-docs/docs/api-guides/crud-operations/creating-data), server auto-populates: `AD_Client_ID`, `AD_Org_ID`, `IsActive`, `CreatedBy`, `UpdatedBy`, `Created`, `Updated`, `id`, `uid`. Do NOT include these in payloads.
3. ~~**Chuboe custom tables:**~~ **RESOLVED (2026-03-31)** — Yes, `chuboe_*` tables are exposed. `GET /models/chuboe_rfq` works (readable). `POST /models/chuboe_rfq` returns 403 due to role permissions, not table exposure.
4. **Deactivation via API:** Can `apiPut` deactivate records created via iDempiere UI (not just API-created records)?

---

## Current Blocker

**Role 1000056 (`WebService User`) gets 403 "Role does not have access"** on `POST /models/chuboe_rfq` (and presumably all write operations).

**Resolution needed:** Grant write permissions in iDempiere admin: **Role** window → Role `WebService User` (1000056) → **Table Access** tab → add `chuboe_rfq`, `chuboe_rfq_line`, `chuboe_rfq_line_mpn`, `chuboe_vq_line`, `chuboe_offer`, `chuboe_offer_line`, `chuboe_offer_line_mpn`, etc. with read+write access.

**Who:** Requires iDempiere admin (Jake or Chuck) to update the role configuration on the production server.

---

## Discovery Log (Tested Findings)

### 2026-03-31 — Initial API Testing Session

**Connection:**
- Production API confirmed at `http://172.31.28.106:8080/api/v1` (direct internal IP, HTTP)
- Bypasses expired SSL cert on `test.orangetsunami.com`
- `.env` updated with real credentials

**Authentication (two-step flow discovered):**
- Step 1: `POST /auth/tokens` with `userName`/`password` returns pre-auth token + `clients` array
- Step 2: `PUT /auth/tokens` with pre-auth token + `{ clientId, roleId, organizationId }` returns fully authorized token
- Step-1 token alone gets 401 on `/models/` endpoints — must complete Step 2
- Between steps, discovery endpoints available: `GET /auth/roles?client=X`, `GET /auth/organizations?client=X&role=Y`

**Known identity values:**
- Client: `{ id: 1000000, name: "Tsunami" }`
- Role: `{ id: 1000056, name: "WebService User" }`
- Organization: `{ id: 1000000, name: "Tsunami" }`
- User ID returned after Step 2: 1047761

**Field naming:**
- API requires exact PascalCase column names from `ad_column.columnname`
- Lowercase/snake_case rejected with 500 `"Wrong name for column"`
- Table names also PascalCase in `ad_table.tablename` (e.g., `Chuboe_RFQ`)
- Column names queryable: `SELECT c.columnname FROM ad_column c JOIN ad_table t ON ... WHERE t.tablename = 'Chuboe_RFQ'`

**Read access:**
- `GET /models/chuboe_rfq` works — chuboe custom tables are exposed and readable

**Write access:**
- `POST /models/chuboe_rfq` returns 403 `"Role does not have access"`
- Blocker: Role 1000056 needs Table Access permissions for write operations
- Requires iDempiere admin to configure
