# Market Offer Uploading Workflow

Process customer/vendor excess inventory offers from emails into the Offer Mass Upload Template for import into OT (Orange Tsunami / iDempiere).

---

## CRITICAL: Himalaya Pagination

**ALWAYS use `--page-size 500` when listing emails!** Default pagination hides most emails.

```bash
# WRONG - only shows ~10 emails
himalaya envelope list --account excess --folder INBOX

# CORRECT - shows all emails
himalaya envelope list --account excess --folder INBOX --page-size 500
```

---

## Two-Agent Manual Extraction (Recommended)

Same pattern as VQ Loading. Use two-agent workflow for reliable extraction:

### Process
1. **Agent A (Extractor)**: Reads emails, extracts all offer fields (see Field Reference below)
2. **Agent B (Verifier)**: Independently reads same emails, verifies extractions match actual content
3. **Result**: Only verified records are saved

### Field Reference (Market Offer Line Import Template)

**Template file:** `Market Offer Line Import Template.csv`

**CRITICAL: Do not modify the header row. Use exact headers from template.**

| Col | Column Name | Required | Description |
|-----|-------------|----------|-------------|
| A | `Chuboe_Offer_ID[Value]` | If provided | Offer header ID. If given, populate and use for filename |
| B | `Chuboe_MPN` | **YES** | Part number. If multiple MPNs given, split into separate lines |
| C | `Chuboe_MFR_ID[Value]` | No | **Exact MFR name from DB** (e.g., "Texas Instruments"), NOT the code |
| D | `Chuboe_MFR_Text` | No | Leave blank (use col C instead) |
| E | `Qty` | **YES** | Quantity available |
| F | `Chuboe_Lead_Time` | No | Lead time - **only if explicitly stated** |
| G | `Chuboe_Package_Desc` | No | Rarely used. Packaging if specified |
| H | `C_Country_ID[Name]` | No | Country of origin |
| I | `Chuboe_Date_Code` | No | Manufacturing date code |
| J | `C_Currency_ID[ISO_Code]` | No | Currency. Blank = USD |
| K | `Description` | No | Notes, conditions, expiry, special terms |
| L | `IsActive` | **DO NOT USE** | Leave blank |
| M | `Chuboe_MPN_Clean` | **DO NOT USE** | Leave blank |
| N | `Chuboe_CPC` | No | **Customer part number** (their internal PN) |
| O | `PriceEntered` | No | Unit price |
| P | `Chuboe_MOQ` | No | Minimum order quantity |
| Q | `Chuboe_SPQ` | No | Standard pack quantity |

**Key Rules:**
- **Only populate what's explicit:** Do NOT assume or default values. If lead time, date code, price, etc. are not stated in the input, leave those columns blank
- **Multiple MPNs:** If customer lists several MPNs without specifying which they have, create a separate line for EACH MPN (same qty, same customer PN)
- **Customer PN:** Goes in column N (Chuboe_CPC), not Description
- **MFR Matching:** Use exact name from `chuboe_mfr.name` in column C, not the code

**Offer Header:** If `Chuboe_Offer_ID[Value]` is provided, populate column A. Otherwise leave blank (will be assigned later).

---

## Manufacturer Matching (CRITICAL)

**Goal:** Populate `Chuboe_MFR_ID[Value]` (column C) with the **exact MFR name from the database** to enable matching.

**Alias file:** `mfr-aliases.json` - maps common abbreviations/variants to system codes, which we then look up to get the exact name.

### Matching Order
1. **Normalize input** - uppercase, trim whitespace
2. **Alias lookup** - check `mfr-aliases.json` to get system code (e.g., M05844)
3. **Database lookup** - get the exact `name` for that code
4. **Output** - put the exact name in column C (NOT the code)
5. **No match** - leave column C blank

### Example
```
Email says: "TI" or "Texas Instruments" or "TEXAS INSTRUMENTS INC"
    ↓
Alias lookup: all map to code M05844
    ↓
DB lookup: SELECT name FROM chuboe_mfr WHERE value = 'M05844'
    ↓
Output: Chuboe_MFR_ID[Value] = "Texas Instruments"  (the exact name, NOT the code)
```

### Adding New Aliases
When extraction encounters an unmatched manufacturer:
1. Search database: `SELECT value, name FROM adempiere.chuboe_mfr WHERE name ILIKE '%keyword%'`
2. If found, add mapping to `mfr-aliases.json`
3. If not found, leave column C blank

### Why This Matters
- **26M offer lines** currently have no manufacturer match
- System's rigid MFR_Text matching has very low conversion rate
- Pre-matching enables: analytics by manufacturer, cross-reference with VQs, trend analysis

**Notes field usage:**
- **Expiration**: "Offer expires 2026-03-31"
- **Conditions**: "Subject to prior sale", "All or nothing"
- **Location**: "Ships from Hong Kong"

### Commands
```bash
# Get all inbox email IDs
himalaya envelope list --account excess --folder INBOX --page-size 500 | grep -E "^\| [0-9]" | awk -F'|' '{print $2}'

# Read specific email
himalaya message read --account excess --folder INBOX [ID]

# Download attachment
himalaya attachment download --account excess --folder INBOX [ID]
```

### Batch Size
- Process 40 emails per batch (2 agents x 20 emails each)
- Run extraction agents in parallel, then verification agents in parallel

### Skip Rules
- **Empty forward**: No offer data in the body
- **Inquiry only**: Asking about availability, not offering stock
- **Duplicate**: Same partner/part/qty already extracted
- **PDF-only**: Offer data only in attachment, queue for PDF review

**IMPORTANT:** Many emails are forwards from team members. The actual offer data is BELOW the signature block at the top. Always read to the bottom of the email to find the actual offer data.

---

## End-to-End Workflow (REQUIRED STEPS)

**Every step must be completed in order. Do not skip steps.**

### Step 1: Fetch Emails
```bash
himalaya envelope list --account excess --folder INBOX --page-size 500
```
- List all unprocessed emails in INBOX
- Note email IDs for processing

### Step 2: Extract Offer Data (Two-Agent Validation)
- Agent A extracts all fields from emails/attachments
- Agent B independently verifies extractions
- Resolve discrepancies (re-read email if agents disagree)
- Record: MPN, Qty, Price, Currency, Date Code, Manufacturer, Partner Email, Notes

### Step 3: Resolve Partner IDs (CRITICAL - DO NOT SKIP)
**Output CSV requires `partner_search_key` for ERP import.**

```sql
-- Look up partner search_key by email domain
SELECT DISTINCT
  LOWER(SUBSTRING(au.email FROM POSITION('@' IN au.email) + 1)) as domain,
  bp.value as search_key,
  bp.name,
  bp.isactive
FROM adempiere.ad_user au
JOIN adempiere.c_bpartner bp ON au.c_bpartner_id = bp.c_bpartner_id
WHERE bp.isactive = 'Y'
AND LOWER(au.email) LIKE '%domain.com%';
```

**Matching order:**
1. Exact email match in `ad_user.email`
2. Domain-based fallback (extract `@domain.com`, find any partner with that domain)
3. **Only use ACTIVE partners** (`bp.isactive = 'Y'`)

**If partner not found:** Flag as `NEEDS-PARTNER`, do not include in ERP-ready output.

### Step 4: Determine Offer Type
| Type | Description | Use Case |
|------|-------------|----------|
| Customer Excess | Customer selling their surplus | Most common - customer with excess inventory |
| Vendor Stock | Supplier broadcasting stock | Vendor pushing available inventory |
| Market Intel | Pricing info, no actual offer | For reference only |

### Step 5: Generate Output Files
| File | Contents |
|------|----------|
| `YYYY-MM-DDTHH-MM-SS-extracted.csv` | All extractions with categories |
| `YYYY-MM-DDTHH-MM-SS-erp-ready.csv` | Clean offers with `partner_search_key`, ready for import |
| `needs-partner.csv` | Complete offers missing partner setup |

**Output location:** `Trading Analysis/Market Offer Uploading/output/`

### Step 6: Route and Move Emails
```bash
# Move processed emails
himalaya message move --account excess --folder INBOX Processed [IDs...]
```

| Condition | Folder |
|-----------|--------|
| Complete offer + partner found | `Processed` |
| Complete offer + partner NOT_FOUND | `NeedsPartner` |
| Inquiry only / no offer | `NotOffer` |
| Incomplete (missing data) | `NeedsReview` |

### Step 7: Commit and Push
```bash
cd ~/workspace/astute-workinstructions
git add "Trading Analysis/Market Offer Uploading/"
git commit -m "Add market offers: [partner] [date]"
git push
```

---

## Partner Matching Strategy

**IMPORTANT: Use domain-based matching, NOT exact email matching.**

**IMPORTANT: Only match ACTIVE partners (`bp.isactive = 'Y'`).** Inactive partner search_keys will not be recognized by iDempiere on import.

Partner contacts change frequently. A quote from `john@examplecorp.com` should match Example Corp even if only `purchasing@examplecorp.com` is in the database.

### Matching Order
1. **Exact email match** in `ad_user.email` (fast path)
2. **Domain-based fallback** - extract `@domain.com` and find any partner with that domain
3. **Active filter** - only return partners where `bp.isactive = 'Y'`
4. Return `NOT_FOUND` only if no active domain match exists

---

## Output Files

### File Naming Convention
| Scenario | Filename |
|----------|----------|
| Offer ID provided | `OFFER_UPLOAD_[OfferID].csv` |
| No offer ID | `OFFER_UPLOAD_YYYYMMDD_[Partner].csv` |

**Examples:**
- With offer ID: `OFFER_UPLOAD_1234567.csv`
- Without: `OFFER_UPLOAD_20260311_Honeywell.csv`

### Output Files
| File | Location | Description |
|------|----------|-------------|
| `OFFER_UPLOAD_*.csv` | `output/` | Offer Mass Upload Template format, ready for iDempiere |
| `needs-partner.csv` | `output/` | Complete offers needing partner setup first |

---

## CRITICAL: search_key vs c_bpartner_id

**ALWAYS use `search_key` (c_bpartner.value), NEVER use `c_bpartner_id` (database primary key).**

The upload template column `Business Partner Search Key` expects the **search_key** value.

---

## Flags and Notes

| Flag | Meaning |
|------|---------|
| `[PARTIAL - needs: partner, qty]` | Missing required fields |
| `[PARTNER NOT IN DB: Name]` | Partner not matched to iDempiere |
| `[EXPIRED]` | Offer has passed expiration date |

---

## TODO
- [x] Get ERP upload template specification (exact column names/formats) ✓ `Market Offer Line Import Template.csv`
- [ ] Document offer header creation (chuboe_offer parent record)
- [ ] Define validation rules (required fields, value constraints)
- [ ] Build extraction logic for common Excel/CSV formats
- [ ] Add duplicate detection (same partner + MPN within N days)
- [ ] Create email folders (Processed, NeedsPartner, NeedsReview, NotOffer)
- [ ] Integrate with Market Offer Matching workflow (auto-refresh after upload)

---

## Related

- [VQ Loading](../../rfq_sourcing/vq_loading/vq-loading.md) - Similar workflow for vendor quotes
- [Market Offer Matching for RFQs](../Market%20Offer%20Matching%20for%20RFQs/market-offer-matching.md) - Downstream consumer of uploaded offers
