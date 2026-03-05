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

## Two-Agent Manual Extraction (Recommended)

The rigid parser produces too many errors. Use this two-agent workflow for reliable extraction:

### Process
1. **Agent A (Extractor)**: Reads emails, extracts all quote fields (see Field Reference below)
2. **Agent B (Verifier)**: Independently reads same emails, verifies extractions match actual content
3. **Result**: Only verified records are saved

### Field Reference (VQ Mass Upload Template)

Extract ALL available fields from each quote. Required fields must be present; optional fields capture when available.

| Field | Column Name | Required | Description |
|-------|-------------|----------|-------------|
| **RFQ Search Key** | `RFQ Search Key` | Yes | Matched via MPN lookup (30-day window) |
| **Buyer** | `Buyer` | Yes | Person who sent RFQ (usually Jake Harris) |
| **Vendor** | `Business Partner Search Key` | Yes | Vendor search_key from domain-based lookup |
| **Contact** | `Contact` | No | Vendor contact name |
| **MPN** | `MPN` | Yes | Part number being quoted |
| **Manufacturer** | `MFR Text` | No | Manufacturer name (TI, Infineon, etc.) |
| **Quantity** | `Quoted Quantity` | Yes | Quoted quantity available |
| **Cost** | `Cost` | Yes | Unit price |
| **Currency** | `Currency` | No | Blank = USD. Only specify for EUR, GBP, other |
| **Date Code** | `Date Code` | No | Manufacturing date code (e.g., 2024, 24+) |
| **MOQ** | `MOQ` | No | Minimum order quantity |
| **SPQ** | `SPQ` | No | Standard pack quantity |
| **Packaging** | `Packaging` | No | Reel, Tube, Tray, Bulk, Cut Tape |
| **Lead Time** | `Lead Time` | No | Default: "stock". Only specify if vendor quotes specific lead time |
| **COO** | `COO` | No | Country of origin (CN, TW, MY, US, etc.) |
| **RoHS** | `RoHS` | No | Y/N - RoHS compliance status |
| **Vendor Notes** | `Vendor Notes` | No | Alternate MPNs, no-bid reasons, conditions |

**Vendor Notes field usage:**
- **No-bid reasons** (IMPORTANT): When qty=0 and price=0, capture why: "No-bid - out of stock", "No-bid - cannot source", "No-bid - price too high"
- Alternate part numbers: "Quoted MPN: ABC123" (when vendor quotes different MPN)
- Special conditions: Lead time details, MOQ notes, pricing tiers

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
```

### Output
- `vq-upload-ready.csv` - VQ Mass Upload Template format, ready for iDempiere import
- `needs-vendor.csv` - Complete quotes missing vendor setup (add vendor first, then re-consolidate)
- `vq-upload-ready-tracking.csv` - Source tracking info (emailId, vendor_email for debugging)

### Post-Extraction: Move to Processed
After extracting quotes from emails, move them to Processed folder:
```bash
# Move specific email IDs to Processed
himalaya message move --account vq --folder INBOX Processed 6944 6950 6951 ...

# Verify counts
himalaya envelope list --account vq --folder INBOX --page-size 500 | grep -c "^|"
himalaya envelope list --account vq --folder Processed --page-size 500 | grep -c "^|"
```

### Folder Routing
| Condition | Folder | Action |
|-----------|--------|--------|
| Complete quote + vendor found | `Processed` | Ready for upload |
| Complete quote + vendor NOT_FOUND | `NeedsVendor` | Add vendor to iDempiere first |
| No-bid / target price request | `NoBid` | Record with qty=0, price=0 |
| Incomplete quote (missing data) | `NeedsReview` | Fix data issues, then re-route |
| Skip (auto-ack, web-link only) | `INBOX` or delete | No action needed |

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

## Quick Start (Rigid Parser - Legacy)

```bash
# 1. Process new emails from VQ inbox
node ~/workspace/vq-parser/src/index.js fetch

# 2. Reprocess all emails in Processed folder (fresh run)
node ~/workspace/vq-parser/scripts/batch-reprocess.js --folder Processed

# 3. Consolidate CSVs into upload-ready files
node ~/workspace/vq-parser/src/index.js consolidate
```

**Output:** `~/workspace/vq-parser/output/uploads/VQ_UPLOAD_*.csv`

**WARNING:** Rigid parser has high error rate. Use two-agent manual extraction for accuracy.

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

Vendor contacts change frequently. A quote from `sal@prismelectronics.net` should match Prism Electronics even if only `salessupport@prismelectronics.net` is in the database. The database typically has `sales@`, `rfq@`, or specific contacts registered, but vendors often send quotes from other personal emails at the same domain.

### Matching Order (consolidate-extractions.js)
1. **Exact email match** in `ad_user.email` (fast path)
2. **Domain-based fallback** - extract `@domain.com` and find any vendor with that domain
3. Return `NOT_FOUND` only if no domain match exists

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
