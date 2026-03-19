# Stock RFQ Loading Workflow

Process customer RFQ emails received at `stockRFQ@orangetsunami.com` into the RFQ Import Template for loading into OT (iDempiere).

---

## Email Account

```bash
# List inbox
himalaya envelope list --account stockrfq --folder INBOX --page-size 500

# Read email
himalaya message read --account stockrfq --folder INBOX [ID]

# Download attachment
himalaya attachment download --account stockrfq --folder INBOX [ID]
```

**Himalaya config:** `~/.config/himalaya/config.toml` (account: `stockrfq`)

---

## Template: RFQ Import Template

**File:** `RFQ Import Template.csv`

| Col | Column Name | Required | Population Logic |
|-----|-------------|----------|------------------|
| A | `Chuboe_RFQ_ID[Value]` | Conditional | If user provides RFQ# → use it. If not → populate with customer's BP **search_key** from DB (so user can create the RFQ). If customer not found → `1008499` (Unqualified Broker) |
| B | `Chuboe_CPC` | **YES** | Customer's part code if distinct from MPN. If no distinct CPC exists → use the MPN |
| C | `Chuboe_MFR_Text` | No | Manufacturer name matched to `chuboe_mfr.name` in DB. Use `mfr-aliases.json` for normalization. Same logic as Market Offer Uploading |
| D | `Chuboe_MPN` | **YES** | Manufacturer Part Number from the RFQ |
| E | `Qty` | **YES** | Quantity requested |
| F | `PriceEntered` | No | Customer's **target price** if provided. Leave blank if not stated |
| G | `Description` | No | Part-specific notes. **If customer is Unqualified Broker (1008499):** put the actual customer/company name here |

### Column A Logic (Chuboe_RFQ_ID)

```
IF user provides RFQ# → use RFQ#
ELSE IF customer found in DB → customer BP search_key
ELSE → "1008499" (Unqualified Broker)
```

**Why search_key?** The user needs to create the RFQ in OT first. Having the customer ID lets them quickly create the RFQ and then bulk-import the lines.

### Column B Logic (Chuboe_CPC)

```
IF customer provides a distinct internal part code → use CPC
ELSE → use MPN (same value as column D)
```

### Column C Logic (Chuboe_MFR_Text)

Same as Market Offer Uploading:
1. Normalize input — uppercase, trim whitespace
2. Alias lookup — check `mfr-aliases.json` for canonical name
3. DB lookup if no alias — `SELECT name FROM adempiere.chuboe_mfr WHERE ad_client_id = 1000000 AND name ILIKE '%keyword%'`
4. Output canonical name. If no match, use name as-is

**Alias file:** `../Market Offer Uploading/mfr-aliases.json` (shared)

---

## Customer/Partner Matching (DO NOT SKIP)

**Uses shared module:** `shared/partner-lookup.js` — see `shared/partner-matching.md` for full documentation.

```javascript
const { resolvePartner } = require('../../shared/partner-lookup.js');

const result = resolvePartner({
  email: senderEmail,
  companyName: companyNameFromSignature,
  partnerType: 'any'
});

if (result.matched) {
  // Use result.search_key for Chuboe_RFQ_ID column
} else {
  // Use '1008499' (Unqualified Broker), put company name in Description
}
```

**Fallback:** If no match after all tiers → use `1008499` (Unqualified Broker) and put customer name + email in Description.

---

## Skip / Flag Rules

| Condition | Action |
|-----------|--------|
| Any email with MPN + quantity | **Process** — even broker blasts. Use `1008499` (Unqualified Broker) if customer not in DB |
| Inquiry only (no parts listed) | **Skip** — move to `NotRFQ` |
| Duplicate (same customer + parts already processed) | **Skip** — move to `Duplicates` |
| PDF/attachment only (no inline data) | **Queue** for attachment extraction |
| No extractable part data (pure marketing, newsletters) | **Skip** — move to `Junk` |

### Why we process everything

Every RFQ with a part number represents **activity around that part** — someone in the market wants it. Even if we won't quote a particular sender, capturing the MPN + quantity as an RFQ line gives the trading team visibility into demand. This data feeds into sourcing decisions, pricing intelligence, and inventory positioning.

**Not in the system ≠ junk.** A sender not matching a DB partner just means they're loaded under Unqualified Broker (1008499). The trading team decides whether to quote — that's a business decision, not a data-capture decision. Our job is to make sure the part activity is recorded.

**The only true skip** is emails with zero extractable part data (marketing, newsletters, general inquiries with no MPNs).

---

## End-to-End Workflow (REQUIRED STEPS)

**Every step must be completed in order. Do not skip steps.**

### Step 1: Fetch Emails
```bash
himalaya envelope list --account stockrfq --folder INBOX --page-size 500
```
- List all unprocessed emails in INBOX
- Note email IDs for processing

### Step 2: Read and Categorize Emails
- Read each email body (and attachments if needed)
- Categorize: **Process** / **NotRFQ** / **Duplicate**
- If it has an MPN + quantity, it gets processed — even broker blasts (see "Why we don't junk broker RFQs" above)

### Step 3: Extract RFQ Line Items (Two-Agent Validation)
- **Agent A (Extractor):** Reads emails, extracts: MPN, Qty, MFR, CPC (if distinct), target price (if given), customer name/email
- **Agent B (Verifier):** Independently reads same emails, verifies extractions
- Resolve discrepancies by re-reading the email

### Step 4: Resolve Customer IDs (CRITICAL - DO NOT SKIP)
For each email's sender:
1. Extract sender email domain
2. Look up in DB using domain-based partner matching query
3. If found → record `search_key`
4. If NOT found → use `1008499`, record customer name for Description

### Step 5: MFR Matching
For each manufacturer in the extracted data:
1. Check `mfr-aliases.json` for canonical name
2. If no alias, search DB: `SELECT name FROM adempiere.chuboe_mfr WHERE ad_client_id = 1000000 AND name ILIKE '%keyword%'`
3. If new alias found, add to `mfr-aliases.json`

### Step 6: Generate Output CSV
- **One consolidated file per run** (not per email)
- Filename: `RFQ_UPLOAD_YYYYMMDD.csv`
- Template format: 7 columns matching `RFQ Import Template.csv`
- Populate `Chuboe_RFQ_ID[Value]` with RFQ# (if given) or customer search_key
- Populate Description with customer name if using Unqualified Broker (1008499)

**Output location:** `Trading Analysis/Stock RFQ Loading/output/`

### Step 7: Route and Move Emails
```bash
# Move processed emails (includes broker RFQs loaded as 1008499)
himalaya message move --account stockrfq --folder INBOX Processed [IDs...]
```

| Condition | Folder |
|-----------|--------|
| Processed (any email with MPN+qty, including brokers) | `Processed` |
| Not an RFQ (no parts data) | `NotRFQ` |
| Needs manual review | `NeedsReview` |

### Step 8: Email Output File
Send consolidated CSV to jake.harris@astutegroup.com.

Subject: `Stock RFQ Upload Ready - YYYY-MM-DD`

### Step 9: Commit and Push
```bash
git -C ~/workspace/astute-workinstructions add "Trading Analysis/Stock RFQ Loading/"
git -C ~/workspace/astute-workinstructions commit -m "Add stock RFQ upload: YYYY-MM-DD"
git -C ~/workspace/astute-workinstructions push
```

---

## Cadence

Steady inflow, not high volume. Process on a regular cadence (TBD — daily? every few days?). Consolidate all emails from a run into one output file.

---

## Future: Direct Database Write-Back

Currently outputs CSV for manual import. Future state: write RFQ lines directly to the database, eliminating the template step. This will require:
- [ ] INSERT permissions on RFQ tables
- [ ] RFQ header auto-creation (or API call)
- [ ] Validation rules matching iDempiere business logic

---

## TODO
- [x] Get RFQ Import Template ✓ `RFQ Import Template.csv`
- [x] Configure `stockRFQ@orangetsunami.com` in Himalaya ✓
- [ ] Create email folders (Processed, Junk, NotRFQ, NeedsReview) in stockRFQ mailbox
- [ ] Build email notification script (like market offer `send-offer-email.js`)
- [ ] Define cadence with user
- [ ] Add common junk sender domain list for auto-skip
- [ ] Direct database write-back (future)

---

## Related

- [Market Offer Uploading](../Market%20Offer%20Uploading/market-offer-uploading.md) — Sister workflow, same MFR matching and partner lookup patterns
- [VQ Loading](../../rfq_sourcing/vq_loading/vq-loading.md) — Similar two-agent extraction pattern
- MFR Aliases: `../Market Offer Uploading/mfr-aliases.json` (shared)
