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
| C | `Chuboe_MFR_ID[Value]` | **DO NOT USE** | Leave blank - system auto-maps from MFR Text on import |
| D | `Chuboe_MFR_Text` | No | Manufacturer name. **On import, system matches this text against `chuboe_mfr.name` to populate `Chuboe_MFR_ID`** |
| E | `Qty` | **YES** | Quantity available |
| F | `Chuboe_Lead_Time` | No | Lead time - **only if explicitly stated** |
| G | `Chuboe_Package_Desc` | No | Rarely used. Packaging if specified |
| H | `C_Country_ID[Name]` | No | Country of origin |
| I | `Chuboe_Date_Code` | No | Manufacturing date code |
| J | `C_Currency_ID[ISO_Code]` | No | Currency. Blank = USD |
| K | `Description` | No | **Part-specific** notes only (conditions, expiry). NOT source metadata |
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
- **MFR Matching:**
  - **Always use column D** (`Chuboe_MFR_Text`) for manufacturer names
  - **Leave column C blank** - system auto-maps text to MFR ID on import
  - Use canonical names from `mfr-aliases.json` when possible (e.g., "Broadcom" not "BRCM")
- **Description:** Part-specific notes only (e.g., "Ships from HK", "Expires 2026-06-30"). Do NOT put source metadata (e.g., "Benchmark excess")

**Offer Header:** If `Chuboe_Offer_ID[Value]` is provided, populate column A. Otherwise leave blank (will be assigned later).

---

## Manufacturer Matching

**Goal:** Populate `Chuboe_MFR_Text` (column D) with a manufacturer name that matches a `chuboe_mfr.name` value in the database.

**How it works:** On import, the system takes the value in `Chuboe_MFR_Text` and looks it up against `chuboe_mfr.name`. If a match is found, it automatically populates `Chuboe_MFR_ID` with the corresponding record. This is why using canonical names (exactly as they appear in the database) improves match rates.

**IMPORTANT:** Always use column D (`Chuboe_MFR_Text`). Leave column C (`Chuboe_MFR_ID[Value]`) blank — direct ID lookups have client-level visibility issues.

**Alias file:** `mfr-aliases.json` - maps common abbreviations/variants to canonical names.

### Matching Order
1. **Normalize input** - uppercase, trim whitespace
2. **Alias lookup** - check `mfr-aliases.json` to get canonical name
3. **Output** - put the canonical name in column D (`Chuboe_MFR_Text`)
4. **No match** - use the name as-is in column D (system may still match it)

### Example
```
Email says: "TI" or "TEXAS INSTRUMENTS INC"
    ↓
Alias lookup: maps to "Texas Instruments"
    ↓
Output: Chuboe_MFR_Text = "Texas Instruments"
    ↓
On import: System auto-maps to MFR ID
```

### Adding New Aliases
When extraction encounters an unmatched manufacturer abbreviation:
1. Search database: `SELECT value, name FROM adempiere.chuboe_mfr WHERE ad_client_id = 1000000 AND name ILIKE '%keyword%'`
2. If found, add mapping to `mfr-aliases.json` (abbreviation → canonical name)
3. If not found, use the name as-is — system may still match it

### Why This Matters
- System auto-maps text to MFR ID, avoiding client-level lookup issues
- Canonical names improve match rate vs raw abbreviations
- Pre-normalizing enables: analytics by manufacturer, cross-reference with VQs, trend analysis

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

### Step 0: Validate MFR Aliases (if stale)
Check `_last_validated` in `mfr-aliases.json`. If 30+ days old, run validation:
```bash
node "Trading Analysis/Market Offer Uploading/validate-mfr-aliases.js"
```
- If pass: proceeds and updates `_last_validated`
- If failures: fix mismatches before continuing

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

**Uses shared module:** `shared/partner-lookup.js` — see `shared/partner-matching.md` for full documentation.

```javascript
const { resolvePartner } = require('../../shared/partner-lookup.js');

const result = resolvePartner({
  email: senderEmail,
  companyName: companyNameFromSignature,
  partnerType: 'any'
});
// result.search_key, result.name, result.matched, result.tierName
```

**Matching tiers** (in order): exact email → email domain → domain hint → name match.

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

### Step 7: Email Output Files (REQUIRED)
**Send each output file to jake.harris@astutegroup.com for ERP upload.**

Subject format: `[Partner Name]/[Search Key], Market Offer Upload Ready`

```bash
# Single file
node "Trading Analysis/Market Offer Uploading/send-offer-email.js" \
  "output/OFFER_UPLOAD_20260317_Celestica_CMY2.csv" "Celestica" "1001118"

# Batch mode (multiple files)
node "Trading Analysis/Market Offer Uploading/send-offer-email.js" --batch offers.json
```

**Batch JSON format:**
```json
[
  {"csvPath": "output/OFFER_UPLOAD_20260317_Celestica_CMY2.csv", "partnerName": "Celestica", "searchKey": "1001118"},
  {"csvPath": "output/OFFER_UPLOAD_20260317_GE_Healthcare.csv", "partnerName": "GE Healthcare", "searchKey": "1002736"}
]
```

### Step 8: Commit and Push
```bash
cd ~/workspace/astute-workinstructions
git add "Trading Analysis/Market Offer Uploading/"
git commit -m "Add market offers: [partner] [date]"
git push
```

### Step 9: Run RFQ Match Analysis (AUTOMATIC TRIGGER)
**Immediately match the new offers against open RFQs.** This runs against the CSV data — no database import required.

```bash
node "Trading Analysis/Market Offer Matching for RFQs/analyze-new-offers.js" \
  "Trading Analysis/Market Offer Uploading/output/OFFER_UPLOAD_20260317_[Partner].csv"
```

**Output:** `RFQ_Matches_[Partner]_[date].csv` in `Trading Analysis/Market Offer Matching for RFQs/`

**What it does:**
1. Reads MPNs from the just-created offer CSV
2. Queries database for matching RFQs (last 90 days)
3. Calculates opportunity values and coverage
4. Tiers results (TIER_1/2/3) by value and coverage
5. Outputs matches for immediate action

**If matches found:** Review TIER_1 opportunities first — these are high-value, good-coverage matches that warrant immediate follow-up.

---

## Partner Matching Strategy

**Canonical reference:** `shared/partner-matching.md` and `shared/partner-lookup.js`

Uses shared multi-tier matching: exact email → email domain → domain hint → name match.
All tiers filter by `bp.isactive = 'Y'`. See shared docs for details.

---

## Output Files

### File Naming Convention

**IMPORTANT: Each email gets its own file.** Do not consolidate multiple emails into one file.

| Scenario | Filename |
|----------|----------|
| Offer ID provided | `OFFER_UPLOAD_[OfferID].csv` |
| No offer ID | `OFFER_UPLOAD_YYYYMMDD_[Partner].csv` |

**Examples:**
- With offer ID: `OFFER_UPLOAD_1234567.csv`
- Without: `OFFER_UPLOAD_20260311_Honeywell.csv`
- Multiple emails same partner: `OFFER_UPLOAD_20260311_Honeywell.csv`, `OFFER_UPLOAD_20260312_Honeywell.csv`

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
- [x] Email notification to jake.harris@astutegroup.com ✓ `send-offer-email.js`
- [ ] Document offer header creation (chuboe_offer parent record)
- [ ] Define validation rules (required fields, value constraints)
- [x] Build extraction logic for common Excel/CSV formats ✓ `extract-market-offers.js`
- [ ] Add duplicate detection (same partner + MPN within N days)
- [x] Create email folders ✓ Processed created (others: create as needed)
- [x] Integrate with Market Offer Matching workflow ✓ Step 9 triggers `analyze-new-offers.js`

---

## Related

- [VQ Loading](../../rfq_sourcing/vq_loading/vq-loading.md) - Similar workflow for vendor quotes
- [Market Offer Matching for RFQs](../Market%20Offer%20Matching%20for%20RFQs/market-offer-matching.md) - Downstream consumer of uploaded offers
