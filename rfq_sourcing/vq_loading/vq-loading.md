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
1. **Agent A (Extractor)**: Reads emails, extracts MPN/qty/price/dc/vendor with source quotes
2. **Agent B (Verifier)**: Independently reads same emails, verifies extractions match actual content
3. **Result**: Only verified records are saved (100% accuracy vs 78% with single agent)

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

### Output
- `verified-extractions-all.json` - Full results with stats
- `verified-extractions-all-enriched.csv` - With vendor_search_key and rfq_number

### Post-Extraction: Move to Processed
After extracting quotes from emails, move them to Processed folder:
```bash
# Move specific email IDs to Processed
himalaya message move --account vq --folder INBOX Processed 6944 6950 6951 ...

# Verify counts
himalaya envelope list --account vq --folder INBOX --page-size 500 | grep -c "^|"
himalaya envelope list --account vq --folder Processed --page-size 500 | grep -c "^|"
```

### Skip Rules
- **No-bid**: Vendor explicitly declined to quote (skip)
- **Target price request**: Vendor asking for price, no actual quote (skip)
- **Empty forward**: No vendor response in the body (skip)
- **PDF-only**: Quote data only in attachment, queue for PDF review (needs_review)
- **Duplicate**: Same vendor/part/price already extracted (skip)

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

| File | Description |
|------|-------------|
| `output/uploads/VQ_UPLOAD_*.csv` | Ready for iDempiere import |
| `output/uploads/VQ_UNKNOWN_*.csv` | Records missing RFQ assignment |
| `output/needs-review.json` | Queue of partials & high-cost items |
| `output/archive/` | Processed source CSVs |
| `data/vendor-cache.json` | Learned email→vendor mappings |

---

## Vendor Matching Strategy

1. **Exact email match** in `ad_user.email`
2. **Vendor cache lookup** (`data/vendor-cache.json`)
3. **Domain-based lookup** (e.g., velocityelec.com → Velocity Electronics)
4. **Sender name fuzzy match** in `c_bpartner.name`
5. **LLM inference** (requires `ANTHROPIC_API_KEY` in `.env`)

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
