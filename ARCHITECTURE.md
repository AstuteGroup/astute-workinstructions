# Architecture: Workflows & Shared Cogs

How workflows connect to shared modules ("cogs") and each other. **Read this before building anything new.**

---

## Shared Cogs (`shared/`)

Reusable modules used by 2+ workflows. Full API docs in `shared/README.md`.

| Cog | Purpose | Key Function |
|-----|---------|-------------|
| **franchise-api.js** | Call all 7 franchise distributor APIs (DigiKey, Arrow, Rutronik, Future, Newark, TTI, Master). Returns standardized stock + pricing. API data = confirmed → captures VQ lines. | `searchAllDistributors(mpn, qty)` |
| **market-data.js** | Query DB for VQ history, sales history (broker vs customer), market offers, RFQ demand. All pricing intelligence from the system. | `getAllMarketData(mpn)` |
| **mfr-lookup.js** | Resolve manufacturer names → canonical `chuboe_mfr.name`. Aliases file (165+) → DB lookup → cache. | `normalizeMfr(name)` |
| **partner-lookup.js** | Resolve email/company → iDempiere business partner. 4-tier matching. | `resolvePartner({ email, companyName })` |
| **csv-utils.js** | CSV parsing with proper quoting. Never use `line.split(',')`. | `readCSVFile(path)` / `writeCSVFile(path, headers, rows)` |

### Data Flow

```
External Sources                    Shared Cogs                      System (iDempiere)
─────────────────                   ───────────                      ──────────────────
Emails (Himalaya)  ───────┐
                          ├──→  partner-lookup.js  ──→  BP match (search_key)
Customer/vendor info  ────┘

MFR names from emails ────────→  mfr-lookup.js     ──→  Canonical MFR name

DigiKey, Arrow, etc.  ────────→  franchise-api.js   ──→  Stock + pricing + VQ lines
(7 distributor APIs)              │
                                  └──→  [VQ capture files for import]

DB (read-only)  ──────────────→  market-data.js     ──→  VQ history, sales, offers, demand

CSV files  ───────────────────→  csv-utils.js       ──→  Parsed/written data
```

---

## Workflows & Which Cogs They Use

### 1. Stock RFQ Loading
**Path:** `Trading Analysis/Stock RFQ Loading/`
**Purpose:** Customer RFQ emails → RFQ Import Template + Suggested Resale

| Step | Cog Used | Output |
|------|----------|--------|
| Extract email | Himalaya CLI (`--account stockrfq`) | Email body + attachments |
| Match customer | **partner-lookup.js** | BP search_key or 1008499 (Unqualified) |
| Match MFR | **mfr-lookup.js** | Canonical MFR name |
| Generate RFQ CSV | **csv-utils.js** | `RFQ_UPLOAD_YYYYMMDD.csv` |
| Market check | **franchise-api.js** | Franchise stock + pricing across 7 distributors |
| System check | **market-data.js** | VQ, sales, offers, demand data |
| Suggested resale | `suggested-resale.js` (local) | Market-based pricing |
| VQ capture | **franchise-api.js** `writeVQCapture()` | `*_Franchise_VQ.csv` |

### 2. VQ Loading
**Path:** `rfq_sourcing/vq_loading/`  |  **Code:** `~/workspace/vq-parser/`
**Purpose:** Supplier quote emails → VQ Mass Upload Template

| Step | Cog Used |
|------|----------|
| Fetch emails | Himalaya CLI (`--account excess`) |
| Match vendor | **partner-lookup.js** |
| Match MFR | **mfr-lookup.js** (via vq-parser's mfr-lookup.js — to be migrated) |
| Parse quotes | vq-parser extraction + verification |
| Generate VQ CSV | Template-specific output |

### 3. Market Offer Uploading
**Path:** `Trading Analysis/Market Offer Uploading/`
**Purpose:** Excess inventory emails → Market Offer Import CSV

| Step | Cog Used |
|------|----------|
| Extract email | Himalaya CLI |
| Match partner | **partner-lookup.js** |
| Match MFR | **mfr-lookup.js** (alias file lives here: `mfr-aliases.json`) |
| Generate offer CSV | **csv-utils.js** |

### 4. Market Offer Analysis (RFQ → Offers)
**Path:** `Trading Analysis/Market Offer Matching for RFQs/`
**Purpose:** Match new RFQs against existing offers

| Step | Cog Used |
|------|----------|
| Get new RFQs | **market-data.js** `getRFQDemand()` |
| Match against offers | **market-data.js** `getMarketOffers()` |
| Calculate opportunity | Local logic |

### 5. Quick Quote
**Path:** `Trading Analysis/Quick Quote/`
**Purpose:** Baseline quotes from recent VQs with margin/GP logic

| Step | Cog Used |
|------|----------|
| Get VQ costs | **market-data.js** `getVQHistory()` |
| Get sales history | **market-data.js** `getSalesHistory()` |
| Franchise ceiling | **franchise-api.js** (planned) |
| Pricing logic | Local (min margin, min GP, fat margin fallback) |

### 6. Franchise Screening
**Path:** `rfq_sourcing/franchise_check/`
**Purpose:** Pre-screen RFQs against franchise distribution before broker sourcing

| Step | Cog Used |
|------|----------|
| Check franchise stock | **franchise-api.js** |
| Screening decision | Local (stock vs demand, opportunity value) |
| FindChips fallback | `main.js` (scraped data — availability only, not VQ) |

### 7. Vortex Matches
**Path:** `Trading Analysis/Vortex Matches/`
**Purpose:** Surface VQs/offers under customer targets

| Step | Cog Used |
|------|----------|
| RFQ demand | **market-data.js** `getRFQDemand()` |
| VQ matches | **market-data.js** `getVQHistory()` |
| Offer matches | **market-data.js** `getMarketOffers()` |

### 8. RFQ Sourcing (NetComponents)
**Path:** `rfq_sourcing/netcomponents/`
**Purpose:** Submit RFQs to NetComponents suppliers

| Step | Cog Used |
|------|----------|
| Franchise pre-screen | **franchise-api.js** (via Franchise Screening) |
| Source submission | `main.py` (Python — separate toolchain) |

### 9. Inventory File Cleanup
**Path:** `Trading Analysis/Inventory File Cleanup/`
**Purpose:** Infor exports → Chuboe format for iDempiere

| Step | Cog Used |
|------|----------|
| Parse inventory CSV | **csv-utils.js** |
| Clean/dedupe/split | `inventory_cleanup.py` (Python) |

### 10–13. Other Workflows
- **Seller Quoting Activity** — DB queries (could use market-data.js)
- **Order/Shipment Tracking** — DB queries (standalone)
- **BOM Monitoring** — Planned (will use market-data.js + franchise-api.js)
- **LAM Kitting Reorder** — DB queries + email (standalone)

---

## Adding New Workflows

1. **Check `shared/README.md`** for existing cogs
2. **If a cog doesn't exist** but the capability is needed by 2+ workflows → build it in `shared/`
3. **If extending a cog** → update `shared/README.md` and this doc
4. **Workflow-specific logic** stays in the workflow directory
5. **The cog never knows about the workflow** — it provides data, the workflow decides what to do with it

---

## External Dependencies

| System | Access | Used By |
|--------|--------|---------|
| iDempiere (PostgreSQL) | Read-only via `psql` | market-data.js, partner-lookup.js, mfr-lookup.js |
| DigiKey API | OAuth2 | franchise-api.js |
| Arrow API | API key | franchise-api.js |
| Rutronik API | API key | franchise-api.js |
| Future Electronics API | License key | franchise-api.js |
| Newark/Farnell API | API key | franchise-api.js |
| TTI API | API key | franchise-api.js |
| Master Electronics API | API key | franchise-api.js |
| Himalaya (IMAP) | Email accounts | Stock RFQ, VQ Loading, Market Offers |
| FindChips (scraped) | Browser automation | Franchise Screening (availability only) |
| GitHub | Push access | All output files |

---

*Last updated: 2026-03-19*
