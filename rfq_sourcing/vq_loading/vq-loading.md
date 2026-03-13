# VQ Loading Workflow

Process supplier quote emails into the VQ Mass Upload Template for import into OT (Orange Tsunami / iDempiere).

---

## CRITICAL: Himalaya Pagination

**ALWAYS use `--page-size 500` when listing emails!** Default pagination hides most emails.

```bash
# WRONG - only shows ~10 emails
himalaya envelope list --account vq --folder INBOX

# CORRECT - shows all emails
himalaya envelope list --account vq --folder INBOX --page-size 500
```

---

## Dual-Phase Extraction (MANDATORY)

The rigid parser produces too many errors. **Always use dual-phase extraction + verification.**

---

### Phase 1: Extraction

Split emails into batches and launch extraction agents in parallel.

| Email Count | Extraction Agents | Batch Size |
|-------------|-------------------|------------|
| 1-25        | 1                 | All        |
| 26-50       | 2                 | ~25 each   |
| 51-100      | 4                 | ~25 each   |
| 100+        | 4-6               | ~20-25 each|

**Output:** Save extractions to `YYYY-MM-DD-extractions.json`

---

### Phase 2: Verification (DO NOT SKIP)

Launch verification agents on the **SAME batches** used in Phase 1.

| Email Count | Verification Agents |
|-------------|---------------------|
| 1-25        | 1                   |
| 26-50       | 2                   |
| 51-100      | 4                   |
| 100+        | Match extractors    |

Each verifier must:
1. Re-read the same emails independently
2. Extract quote data fresh (not copy from Phase 1)
3. Compare to Phase 1 extractions
4. Flag all discrepancies (MPN, qty, price, currency, vendor)

**ENFORCEMENT CHECKPOINT:** After extraction completes, ALWAYS say:
> "Extraction complete for X emails. Running verification agents now on the same batches."

If this message doesn't appear, verification was skipped.

---

### Phase 3: Reconciliation

1. Review all discrepancies flagged by verifiers
2. Re-read original emails to determine correct values
3. Fix errors in the extractions JSON
4. Only then generate the ERP-ready CSV

**NEVER generate CSV until verification is done.**

---

### Why This Matters

- **Extraction errors are common:** Price breaks, alternate MPNs, currency confusion
- **Errors are costly:** Wrong data in iDempiere requires manual cleanup
- **Verification catches ~10-15% errors** on average

---

### Process Summary
1. **Phase 1 - Extraction**: N agents extract from N batches in parallel → JSON file
2. **Phase 2 - Verification**: N agents verify the SAME N batches → discrepancy report
3. **Phase 3 - Reconciliation**: Fix discrepancies → generate CSV
4. **Result**: Only verified records go to the output CSV

### Field Reference (VQ Mass Upload Template)

Extract ALL available fields from each quote. Required fields must be present; optional fields capture when available.

| Field | Column Name | Required | Description |
|-------|-------------|----------|-------------|
| **RFQ Search Key** | `RFQ Search Key` | Yes | Matched via MPN lookup (30-day window) |
| **Buyer** | `Buyer` | Yes | **Astute employee who forwarded the email** (from outer From: field) |
| **Forwarder Email** | `forwarder_email` | Yes | Email of Astute employee who forwarded to vq@ (e.g., jake.harris@astutegroup.com) |

**CRITICAL - Buyer Field:**
- The Buyer is the **Astute employee** who forwarded the VQ email, NOT the customer contact from the RFQ
- Look at the outer `From:` field: `From: Jake Harris <jake.harris@astutegroup.com>`
- Extract the email address and name from this field
- Do NOT use names from the RFQ record (those are customer contacts like "MohanRaj Somasundaram")
- Common buyers: Jake Harris, Ed Harkins, Tracy Xie, Roberto Orozco
| **Vendor** | `Business Partner Search Key` | Yes | Vendor search_key from domain-based lookup |
| **Contact** | `Contact` | No | Vendor contact name |
| **MPN** | `MPN` | Yes | **Customer's requested MPN** (from RFQ, NOT vendor's alternate) |
| **Manufacturer** | `MFR Text` | No | Manufacturer name (TI, Infineon, etc.) |
| **Quantity** | `Quoted Quantity` | Yes | Quoted quantity available |
| **Cost** | `Cost` | Yes | Unit price |
| **Currency** | `Currency` | No | Blank = USD. Only specify for EUR, GBP, other |
| **Date Code** | `Date Code` | No | Manufacturing date code (e.g., 2024, 24+) |
| **MOQ** | `MOQ` | No | Minimum order quantity |
| **SPQ** | `SPQ` | No | Standard pack quantity |
| **Packaging** | `Packaging` | No | Reel, Tube, Tray, Bulk, Cut Tape |
| **Lead Time** | `Lead Time` | No | Default: "stock". Only specify if vendor quotes specific lead time |
| **COO** | `COO` | No | Country of origin - use **full name** (China, Taiwan, Malaysia, United States, etc.) NOT ISO codes |
| **RoHS** | `RoHS` | No | **Yes** / **No** / **Not Applicable** / blank (NOT Y/N) |
| **Vendor Notes** | `Vendor Notes` | No | Alternate MPNs, no-bid reasons, conditions |

**COO Reference (ISO → iDempiere Name):**
| Code | Use This Name |
|------|---------------|
| CN | China |
| TW | Taiwan |
| MY | Malaysia |
| US | United States |
| JP | Japan |
| KR | Korea Republic of |
| DE | Germany |
| MX | Mexico |
| TH | Thailand |
| PH | Philippines |
| SG | Singapore |
| HK | Hong Kong |
| IN | India |

**⚠️ COO vs Shipping Terms - DO NOT CONFUSE:**
- **COO** = where parts were **manufactured** (e.g., "Made in China", "COO: Taiwan")
- **Shipping terms** = where parts **ship from** (NOT COO)

| Term | Meaning | Is it COO? |
|------|---------|------------|
| EXW Israel | Ex Works Israel (pickup location) | **NO** |
| FOB Hong Kong | Free on Board HK (shipping point) | **NO** |
| FCA Germany | Free Carrier Germany | **NO** |
| Stock in HK | Warehouse location | **NO** |
| COO: China | Country of Origin | **YES** |
| Made in Japan | Manufacturing origin | **YES** |

**Rule:** Only populate COO if the vendor explicitly states manufacturing origin. Shipping location ≠ COO.

**RoHS Field Values (lookup field - use exact names):**
| Vendor Says | Use This Value |
|-------------|----------------|
| RoHS, ROHS compliant, Pb-free, Lead-free | **Yes** |
| Non-RoHS, Leaded, Not RoHS | **No** |
| Unknown, not stated | (leave blank) |

**Vendor Notes field usage:**
- **Alternate MPN** (CRITICAL - MUST BE FIRST): When vendor quotes a different MPN than requested, put "Quoted MPN: [vendor's MPN]" as the **FIRST thing** in Vendor Notes. The MPN field MUST contain the customer's original RFQ MPN - this is how iDempiere links the VQ to the RFQ.
- **No-bid reasons**: When qty=0 and price=0, capture why: "No-bid - out of stock", "No-bid - cannot source"
- Special conditions: Lead time details, MOQ notes, pricing tiers

**⚠️ Alternate MPN - CRITICAL:**
If the MPN field doesn't match an RFQ MPN, iDempiere will reject the line with:
> "Could not associate VQ with CPC based on MPN"

**Example:**
- RFQ requested: `LM2903AVQDR`
- Vendor quoted: `LM2903AVQDRG4Q1` (with suffix)
- **MPN field:** `LM2903AVQDR` ← RFQ MPN (required for linking)
- **Vendor Notes:** `Quoted MPN: LM2903AVQDRG4Q1` ← vendor's MPN (first in notes)

**Common mismatches:**
- Vendor adds suffix: `LT3080EDD-1` vs RFQ `LT3080EDD-1#TRPBF`
- Vendor drops suffix: `MSP430F149IPM` vs RFQ `MSP430F149IPMG4`
- Alternate/substitute part: completely different MPN

**No-bid records:**
- Set Quantity = 0, Cost = 0
- Leave Lead Time blank (not "stock")
- Capture reason in Vendor Notes

### Commands
```bash
# Get all inbox email IDs
himalaya envelope list --account vq --folder INBOX --page-size 500 | grep -E "^\| [0-9]" | awk -F'|' '{print $2}'

# Read specific email
himalaya message read --account vq --folder INBOX [ID]
```

### Batch Size
- Process 40 emails per batch (2 agents × 20 emails each)
- Run extraction agents in parallel, then verification agents in parallel

### Batch Summary & Timing
At the end of each extraction batch, record:
```
Batch: [batch number]
Emails processed: [count]
Records extracted: [count]
No-bids: [count]
Skipped: [count] (duplicates, empty forwards, etc.)
Start time: [HH:MM]
End time: [HH:MM]
Duration: [X minutes]
```

At end of session, summarize total:
```
Session Summary:
Total emails: [count]
Total records: [count]
Total no-bids: [count]
Total processing time: [X minutes]

Vendor match rate: [X]% ([matched]/[total])
RFQ match rate: [X]% ([matched]/[total])

Top vendors by quote volume:
1. [Vendor Name] - [count] quotes
2. [Vendor Name] - [count] quotes
3. [Vendor Name] - [count] quotes
```

### Vendor Frequency Tracking

→ **See Step 7 in End-to-End Workflow.** This is a required step, not optional reference.

### Output
- `vq-upload-ready.csv` - VQ Mass Upload Template format, ready for iDempiere import
- `needs-vendor.csv` - Complete quotes missing vendor setup (add vendor first, then re-consolidate)
- `vq-upload-ready-tracking.csv` - Source tracking info (emailId, vendor_email for debugging)

### Post-Extraction & Folder Routing

→ **See Step 6 in End-to-End Workflow.** This is a required step, not optional reference.

### Vendor-Missing Workflow

**During extraction (going forward):**
1. After extracting a complete quote, check if vendor exists in database (domain-based lookup)
2. If vendor NOT_FOUND → Move email to `NeedsVendor` folder (not Processed)
3. Add record to `needs-vendor.json` report

**After extraction session:**
```bash
# View vendor-missing report
cat vq_loading/needs-vendor.json | jq '.records[] | {vendor_email, vendor_name, mpn}'

# After adding vendors to iDempiere:
# 1. Re-run consolidation to update vendor_search_key
node consolidate-extractions.js

# 2. Move resolved emails from NeedsVendor → Processed
himalaya message move --account vq --folder NeedsVendor Processed [IDs...]
```

**Report file:** `needs-vendor.json` - Lists all complete quotes missing vendor setup. High priority for review since quote data is complete.

### Skip Rules
- **No-bid**: Vendor explicitly declined to quote
- **Target price request**: Vendor asking for price, no actual quote
- **Empty forward**: No vendor response in the body
- **PDF-only**: Quote data only in attachment, queue for PDF review
- **Duplicate**: Same vendor/part/price already extracted

**IMPORTANT:** All emails are forwards from team members. The vendor response is BELOW the signature block at the top. Always read to the bottom of the email to find the actual quote data.

---

## End-to-End Workflow (REQUIRED STEPS)

**Every step must be completed in order. Do not skip steps.**

### Step 1: Fetch Emails
```bash
node ~/workspace/vq-parser/src/index.js fetch
```
- Pulls emails from INBOX via IMAP
- Generates session file: `data/sessions/YYYY-MM-DDTHH-MM-SS-inbox.json`
- Templates auto-extract known vendor formats

### Step 2: Extract Quote Data (Dual-Phase - DO NOT SKIP VERIFICATION)

**Follow the Dual-Phase Extraction process above. This is 3 phases, not 1:**

1. **Phase 1 - Extraction:** Launch N extraction agents based on email count (see table above)
2. **Phase 2 - Verification:** Launch N verification agents on SAME batches, compare results
3. **Phase 3 - Reconciliation:** Fix discrepancies before proceeding

**CHECKPOINT:** You must see this message before proceeding to Step 3:
> "Extraction complete for X emails. Running verification agents now on the same batches."

If verification was skipped, STOP and run it before generating any output.

### Step 3: Resolve Vendor IDs (CRITICAL)
**Do not skip this step.** Output CSV requires `vendor_search_key` for ERP import.

```sql
-- Look up vendor search_key by email
SELECT u.email, bp.value as search_key, bp.name, bp.isactive
FROM adempiere.ad_user u
JOIN adempiere.c_bpartner bp ON u.c_bpartner_id = bp.c_bpartner_id
WHERE bp.isvendor = 'Y' AND bp.isactive = 'Y'
AND LOWER(u.email) LIKE '%domain.com%';
```

**Matching order:**
1. Exact email match in `ad_user.email`
2. Domain-based fallback (extract `@domain.com`, find any vendor with that domain)
3. Vendor cache lookup (`data/vendor-cache.json`)
4. **Only use ACTIVE vendors** (`bp.isactive = 'Y'`)

**If vendor not found:** Flag as `NEEDS-VENDOR`, do not include in ERP-ready output.

### Step 4: Match to RFQs
- Match extracted MPNs to open RFQs (30-day window)
- Use fuzzy matching if exact match fails (trim suffix chars)
- Flag unmatched as `[NEEDS_RFQ - no match in 30 days]`

### Step 5: Generate Output Files
| File | Contents |
|------|----------|
| `YYYY-MM-DD-extracted.csv` | All extractions with categories (QUOTE, SKIP, NO-BID, etc.) |
| `YYYY-MM-DD-erp-ready.csv` | Clean quotes with `vendor_search_key`, ready for import |
| `YYYY-MM-DD-routing.json` | **Email routing decisions** (which emails go to which folder) |
| `needs-vendor.csv` | Complete quotes missing vendor setup |

**Routing file format** (generated during extraction):
```json
{
  "sessionId": "2026-03-12",
  "generatedAt": "2026-03-12T15:30:00.000Z",
  "moves": {
    "Processed": ["7868", "7845", "7844"],
    "NeedsVendor": ["7847"],
    "NoBid": ["7846", "7843"],
    "NeedsReview": ["7840"]
  },
  "summary": {
    "total": 7,
    "Processed": 3,
    "NeedsVendor": 1,
    "NoBid": 2,
    "NeedsReview": 1
  }
}
```

**Routing rules:**
| Condition | Folder |
|-----------|--------|
| Complete quote + vendor found | `Processed` |
| Complete quote + vendor NOT_FOUND | `NeedsVendor` |
| No-bid / target price request | `NoBid` |
| Incomplete (missing data) / can't extract | `NeedsReview` |
| Skip (empty forward, duplicate) | `Processed` |

### Step 6: Route and Move Emails (REQUIRED)
**Do not skip.** Emails must be moved out of INBOX after extraction.

```bash
# Review routing decisions first (dry run)
node ~/workspace/vq-parser/scripts/route-emails.js --dry-run data/routing/YYYY-MM-DD-routing.json

# Execute the moves
node ~/workspace/vq-parser/scripts/route-emails.js data/routing/YYYY-MM-DD-routing.json

# Or use --latest to process most recent routing file
node ~/workspace/vq-parser/scripts/route-emails.js --latest
```

**CHECKPOINT:** Session is not complete until routing is executed. The hourly fetch will keep re-reporting emails that aren't moved.

### Step 7: Update Vendor Frequency Tracking (REQUIRED)
**Do not skip.** This identifies high-volume vendors for template development.

1. Count vendors from **session output file** (not database):
   ```bash
   # From the session upload CSV, count by Business Partner Search Key
   cut -d',' -f3 [session]-upload.csv | tail -n +2 | sort | uniq -c | sort -rn
   ```

2. Update `rfq_sourcing/vq_loading/template-candidates.md` with cumulative counts

3. Flag vendors with **5+ cumulative quotes** as template priorities

4. For priority vendors, pull sample emails to analyze format consistency

**Why this matters:** Templates eliminate manual extraction. A vendor sending 10 quotes/week = 40/month of manual work that could be automated.

### Step 8: Move Actioned Emails to Processed (REQUIRED)
**Do not skip.** Emails in NeedsReview, NoBid, and NeedsVendor must be moved to Processed after being actioned.

**When to move:**
| Folder | Action Required | Then Move to Processed |
|--------|-----------------|------------------------|
| **NeedsReview** | Extract PDF/attachment data, add to ERP-ready CSV | Yes |
| **NoBid** | No action needed (info only) | Yes (after noting) |
| **NeedsVendor** | Add vendor to iDempiere, re-run consolidation | Yes |

**Commands:**
```bash
# Move specific emails after actioning
himalaya message move -f 'NeedsReview' 'Processed' [ID1] [ID2] [ID3]
himalaya message move -f 'NoBid' 'Processed' [ID1] [ID2]
himalaya message move -f 'NeedsVendor' 'Processed' [ID1]

# Check folder counts
himalaya envelope list -f 'NeedsReview' --page-size 500 | wc -l
himalaya envelope list -f 'NoBid' --page-size 500 | wc -l
himalaya envelope list -f 'NeedsVendor' --page-size 500 | wc -l
```

**CHECKPOINT:** Session is fully complete when:
- All INBOX emails routed (Step 6)
- All NeedsReview PDFs extracted and merged
- All actioned folders emptied to Processed (this step)

---

## Quick Start (Reference Only)

```bash
# 1. Fetch emails and run template extraction (for known vendors)
node ~/workspace/vq-parser/src/index.js fetch

# 2. Manual extraction in Claude session for remaining emails
himalaya envelope list --account vq --folder INBOX --page-size 500
# Extract → save to JSON files in vq_loading/

# 3. Consolidate all extractions into upload-ready CSV
node ~/workspace/astute-workinstructions/rfq_sourcing/vq_loading/consolidate-extractions.js
```

**Output:** `vq-upload-ready.csv`

---

## Vendor Templates

Templates auto-extract quotes from known vendor formats. Located in `~/workspace/vq-parser/templates/`:

| Template | Vendor | Domains |
|----------|--------|---------|
| `velocity.js` | Velocity Electronics | velocityelec.com |
| `chip1.js` | Chip 1 Stop | chip1.com |
| `j2-sourcing.js` | J2 Sourcing | j2sourcing.com |
| `semitech.js` | Semitech Semiconductor | semitech.net |
| `akira-global.js` | Akira Global | akiraglobal.com |

**Template flow:**
1. `fetch` command runs template engine on incoming emails
2. Template matches by sender domain + content patterns
3. Matched emails → auto-extracted → moved to Processed
4. Unmatched emails → stay in INBOX for manual extraction

**Adding new templates:** When a vendor sends many quotes with consistent format, create a new template in `~/workspace/vq-parser/templates/`. Each template exports:
- `TEMPLATE_ID` - unique identifier
- `VENDOR_DOMAINS` - array of email domains
- `matches(emailBody)` - returns true if email matches this vendor
- `extract(emailBody)` - extracts MPN, qty, price, date code, etc.

---

## Workflow Steps

### 1. Rigid Parser (First Pass)
Extracts structured data from emails using regex patterns:
- MPN, Quantity, Cost, Lead Time, Date Code
- Vendor resolution (email → DB lookup → LLM inference)
- RFQ resolution (MPN → iDempiere RFQ lookup)

### 2. Partial Extraction Queue
Records missing required fields (price, qty, vendor) are queued for review:
- Queue file: `output/needs-review.json`
- Stores raw email body for re-extraction

### 3. High-Cost Flagging
Records with unit cost >= $1,000 are automatically flagged:
- Added to review queue with `HIGH_COST` flag
- Note added: `[HIGH_COST: $X - verify]`
- **Action:** Verify against franchise data or email context

### 4. Second Pass Extraction
```bash
node ~/workspace/vq-parser/scripts/extract-pass2.js
```
Uses aggressive pattern matching on queued partials.

### 5. Vendor Cache Application
```bash
node ~/workspace/vq-parser/scripts/apply-vendor-cache.js
node ~/workspace/vq-parser/scripts/merge-to-upload.js
```
Applies learned vendor mappings and merges to final upload.

---

## Output Files

| File | Location | Description |
|------|----------|-------------|
| `vq-upload-ready.csv` | `vq_loading/` | VQ Mass Upload Template format, ready for iDempiere |
| `needs-vendor.csv` | `vq_loading/` | Complete quotes needing vendor setup first |
| `vq-upload-ready-tracking.csv` | `vq_loading/` | Source tracking (emailId, vendor_email) |

**Legacy (vq-parser):**
| File | Description |
|------|-------------|
| `output/uploads/VQ_UPLOAD_*.csv` | Rigid parser output (legacy) |
| `output/needs-review.json` | Queue of partials & high-cost items |
| `data/vendor-cache.json` | Learned email→vendor mappings |

---

## CRITICAL: search_key vs c_bpartner_id

**ALWAYS use `search_key` (c_bpartner.value), NEVER use `c_bpartner_id` (database primary key).**

These are DIFFERENT numbers:
| Vendor | c_bpartner_id | search_key |
|--------|---------------|------------|
| Cyclops Electronics | 1000491 | 1002495 |
| Atlantic Semiconductor | 1000453 | 1002457 |
| Velocity Electronics | 1000036 | 1001036 |

The upload template column `Business Partner Search Key` expects the **search_key** value.

**Parser fix (field-mapper.js:304):**
```javascript
const bpId = vendorResult.search_key || vendorResult.c_bpartner_id || '';
```

**Vendor cache stores both:** Check `data/vendor-cache.json` - each entry has both `c_bpartner_id` and `search_key`. Always use `search_key` for output.

**If you see mismatched data:** Old records created before this fix may have c_bpartner_id values. These need to be converted to search_key before upload.

---

## Vendor Matching Strategy

**IMPORTANT: Use domain-based matching, NOT exact email matching.**

**IMPORTANT: Only match ACTIVE vendors (`bp.isactive = 'Y'`).** Inactive vendor search_keys will not be recognized by iDempiere on import.

Vendor contacts change frequently. A quote from `sal@prismelectronics.net` should match Prism Electronics even if only `salessupport@prismelectronics.net` is in the database. The database typically has `sales@`, `rfq@`, or specific contacts registered, but vendors often send quotes from other personal emails at the same domain.

### Matching Order (consolidate-extractions.js)
1. **Exact email match** in `ad_user.email` (fast path)
2. **Domain-based fallback** - extract `@domain.com` and find any vendor with that domain
3. **Active filter** - only return vendors where `bp.isactive = 'Y'`
4. Return `NOT_FOUND` only if no active domain match exists

### Database Query (Domain-Based)
```sql
SELECT DISTINCT
  LOWER(SUBSTRING(au.email FROM POSITION('@' IN au.email) + 1)) as domain,
  bp.value as search_key
FROM adempiere.ad_user au
JOIN adempiere.c_bpartner bp ON au.c_bpartner_id = bp.c_bpartner_id
WHERE bp.value NOT LIKE 'USE %'
```

### Why This Matters
- Vendors often use personal emails (`sal@`, `john@`) not registered in DB
- DB typically has `sales@`, `rfq@`, or specific contacts
- Same company = same vendor_search_key, regardless of which employee emailed

---

## Flags and Notes

| Flag | Meaning |
|------|---------|
| `[PARTIAL - needs: price, qty]` | Missing required fields |
| `[HIGH_COST: $X - verify]` | Unit cost >= $1,000, needs verification |
| `[VENDOR NOT IN DB: Name]` | Vendor not matched to iDempiere |
| `Quoted MPN: X (RFQ MPN: Y)` | MPN differs from RFQ request |
| `[$X PO min]` | Calculated unit price from PO minimum |

---

## Review Queue Commands

```bash
# View queue stats
node -e "const q = require('./src/queue/needs-review-queue'); console.log(q.getQueueStats())"

# View high-cost items
node -e "const q = require('./src/queue/needs-review-queue'); console.log(q.getHighCostItems())"

# Clear completed items
node -e "const q = require('./src/queue/needs-review-queue'); q.clearCompleted()"
```

---

## Configuration

**Environment:** `~/workspace/vq-parser/.env`
```
ANTHROPIC_API_KEY=sk-...   # For LLM vendor inference
OUTPUT_DIR=./output        # Output directory
```

**Threshold:** High-cost flagging at $1,000 (`HIGH_COST_THRESHOLD` in `needs-review-queue.js`)

---

## Related

- [vq-parser repo](https://github.com/AstuteGroup/vq-parser) (private)
- [Market Offer Matching for RFQs](../Market%20Offer%20Matching%20for%20RFQs/README.md)
- [Quick Quote](../Quick%20Quote/)
