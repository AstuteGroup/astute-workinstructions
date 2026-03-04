# Session Greeting

At the start of every new conversation, before addressing anything else, always display the following:

1. **Recent Work** — Check the `## Recent Sessions` section in MEMORY.md. Display the 2-4 most recent entries so the user can quickly pick up where they left off. Format as:

> **Recent Work (pick up where you left off):**
> - [list from MEMORY.md Recent Sessions, most recent first]

2. **Available Workflows:**

> **Available Workflows:**
> 1. **Franchise Screening** - Screen RFQs against FindChips to filter low-value parts before broker sourcing (see `rfq_sourcing/franchise_check/franchise-screening.md`)
> 2. **RFQ Sourcing** - Submit RFQs to NetComponents suppliers (see `rfq_sourcing/netcomponents/rfq-sourcing-netcomponents.md`)
> 3. **VQ Loading** - Process supplier quote emails into ERP-ready CSV (see `rfq_sourcing/vq_loading/`)
> 4. **RFQ Loading through AI** - AI-assisted extraction and loading of RFQs from customer emails/documents
> 5. **Market Offer Analysis for RFQs** - Match new RFQs against customer excess and stock offers (see `Trading Analysis/Market Offer Matching for RFQs/market-offer-matching.md`)
> 6. **Quick Quote** - Generate baseline quotes from recent VQs (0-30 days) with margin/GP/rebate pricing logic
> 7. **Seller Quoting Activity** - VQ→CQ→SO funnel analysis by seller (snapshot + 6-month trend)
> 8. **Order/Shipment Tracking** - Look up tracking by COV, SO, MPN, customer PO, or salesperson (see `saved-queries/order-shipment-tracking.md`)
> 9. **Inventory File Cleanup** - Process Infor inventory exports into Chuboe format for iDempiere import (see `Trading Analysis/Inventory File Cleanup/inventory-file-cleanup.md`)

---

## Documentation Standards

When creating or updating workflow documentation, follow the conventions in `CONVENTIONS.md`:
- Workflow docs use descriptive `kebab-case.md` names (e.g., `inventory-file-cleanup.md`, NOT `README.md`)
- Task files go in `tasks/` with `snake_case.md` names
- Keep workflow docs brief; detailed step-by-step instructions belong in `tasks/`
- Session history goes in `MEMORY.md` (4 most recent entries)

---

## Inventory File Cleanup Workflow

**Location:** `~/workspace/astute-workinstructions/Trading Analysis/Inventory File Cleanup/`

Processes Infor ERP inventory exports (AST Item Lots Report) for loading into iDempiere and industry portals.

### Quick Start
```bash
python inventory_cleanup.py "ASTItemLotsReportInputs_*.csv" ./output
```

### What It Does
1. **Clean** - Removes header rows (1-7) and footer (Page x of y, username)
2. **Dedupe** - Removes duplicates based on Item+Lot+Location+Warehouse Name+Site+Date Lot
3. **Split** - Groups by warehouse (W103, W104, W105, etc.) into 14 warehouse groups
4. **Export Chuboe** - Creates `*_chuboe.csv` files for iDempiere import (one per warehouse group)
5. **Export Portal** - Creates consolidated file for NetComponents/IC Source *(template TBD)*

### Output Files
| File | Description |
|------|-------------|
| `*_chuboe.csv` | Chuboe format for iDempiere import (one per warehouse group) |
| `consolidated_portal_*.csv` | Combined file for portal upload *(format TBD)* |
| `inventory_cleaned_*.csv` | Full cleaned/deduped master file |
| `duplicates_*.csv` | Duplicate rows removed (for review) |

### Warehouse Groups
- **Free Stock:** Austin (W104/W112), Stevenage (W102), Hong Kong (W108/W113), Philippines (W109/W114)
- **Consignment:** GE (W103), Taxan (W106), Spartronics (W107), LAM (W118), Eaton (W117) - prices blanked
- **Other:** Franchise Stock (W104+Positronic), LAM Dead (W115), LAM 3PL (W111), Main (MAIN), HK (W105)

### TODO
- [ ] Define NetComponents upload template format
- [ ] Define IC Source upload template format
- [ ] Add portal-specific export transformations

---

## VQ Parser Workflow

**Documentation:** `rfq_sourcing/vq_loading/`
**Code:** `~/workspace/vq-parser/` (to be migrated to rfq_sourcing/vq_loading/)
**Repo:** https://github.com/AstuteGroup/vq-parser (private)

### Email Inbox Setup

**IMPORTANT:** All emails in the VQ inbox (`vq@orangetsunami.com`) are **forwards from team members**, not direct vendor emails.

**Structure of every email:**
1. Team member's forward header (signature block at top)
2. `From:` line showing original vendor sender
3. Vendor's actual response content below

**Why this matters:**
- The `envelope.from` will always be the team member (e.g., Jake Harris), not the vendor
- Vendor identification must parse the forwarded `From:` header or email body
- Quote data is in the forwarded content below the signature block
- Attachments (PDFs) contain most actual quote data

**Current forwarders:** Jake Harris
**Future:** Other team members may forward quotes - parser handles any forwarder

### Full Workflow (follow these steps in order)

**Step 1: Fetch & Parse**
```bash
node vq-parser/src/index.js fetch
```
- Pulls emails from INBOX via IMAP
- **Templates first** - known vendor formats auto-extracted (trusted)
- **No template match** → queued for LLM/manual extraction
- No rigid parser - it produces garbage data that looks complete but is wrong

**Step 2: Consolidate**
```bash
node vq-parser/src/index.js consolidate
```
- Merges all VQ_*.csv into single upload file
- Flags incomplete records: `[PARTIAL - needs: qty/price/both]`, `[HIGH_COST]`
- Failed emails → move to NeedsReview folder
- Output: `VQ_UPLOAD_[timestamp].csv`

**Step 3: Update Parser Failure Tracker** ← IMPORTANT
After consolidation, update `data/parser-failure-tracker.json`:
- For each PARTIAL record, increment that vendor's `failureCount`
- Note failure type (garbage_mpn, missing_fields, etc.)
- This tracks **rigid parser failures** to prioritize future parser improvements
- Review tracker weekly/bi-weekly to identify template opportunities

**Step 4: Generate NeedsReview JSON**
```bash
node vq-parser/src/index.js needs-review-export
```
- Dumps NeedsReview folder emails to `needs-review.json` with full bodies
- **Created once per session** - all batch extraction reads from this file

**Step 5: Batch Extraction (Manual Recovery)**
For each batch:
1. Identify remaining partials in upload CSV
2. Match to emails in `needs-review.json` by MPN
3. Extract missing qty/price using regex patterns
4. Append extracted records to upload file
5. Repeat until diminishing returns

**Extraction filters:**
- Skip if qty appears in MPN (MPN bleeding)
- Skip if price > $200 (likely error)
- Skip garbage MPNs (UUIDs, random alphanumeric strings)

**Step 6: Categorize Remaining Failures**
After batch extraction plateaus, categorize what's left:

| Category | Action |
|----------|--------|
| RFQ Forwards | SKIP - outbound RFQs, not quotes |
| Target Price Requests | SKIP - no quote data |
| NO-BID Responses | SKIP - vendor declined |
| Attachment-Only | CHECK PDF/Excel if time permits |
| Legitimate Partials | Leave for manual review |

**Step 7: NeedsReview Folder Validation**
```bash
himalaya envelope list --account vq --folder NeedsReview
```
- Cross-reference remaining emails against extracted records
- Move successfully extracted emails → Processed folder
- Final pass on any missed quotes

**Step 8: Split Output Files**
Create two separate files:
- **READY** - Complete records (no PARTIAL flags) → ERP import
- **PARTIALS_REVIEW** - Incomplete records → manual review

**Step 9: Final Export**
```bash
cp VQ_UPLOAD_*_READY.csv ~/workspace/astute-workinstructions/Trading\ Analysis/
git add && git commit && git push
```

### IMAP Folder Flow
```
INBOX → [fetch] → Success → Processed
              → Fail → stays in INBOX

INBOX → [consolidate] → Failed emails → NeedsReview

NeedsReview → [batch extract success] → Processed
           → [skip/no-bid] → stays in NeedsReview
```

### RFQ Matching (14-Day Window)
When a vendor quote comes in, the parser matches it to an RFQ in the system:

1. **Exact MPN match** - Search recent RFQs (last 14 days) for exact MPN
2. **Email extraction** - Extract original MPN from NetComponents email format
3. **Fuzzy match** - Progressively trim MPN characters to find partial match
4. **Subject line** - Extract MPN from email subject as last resort
5. **No match** → Flag as `[NEEDS_RFQ - no match in 14 days]` for manual review

**Output format:**
- `chuboe_mpn` = RFQ's MPN (what's in the system)
- `chuboe_note_public` = "Quoted MPN: xxx" if vendor quoted different part
- `chuboe_rfq_id` = RFQ number (the `value` field, not database ID)

**Why 14 days?** Vendor responses typically arrive within 1-2 weeks. Old RFQs with thousands of parts would otherwise catch unrelated quotes via partial matching.

### Vendor Identification
**IMPORTANT:** Always use `search_key` (c_bpartner.value) for vendor identification, NOT `c_bpartner_id`.
- `search_key` is the business-facing identifier used for all lookups in iDempiere
- `c_bpartner_id` is the internal database primary key (different number)
- Output CSV column: `vendor_search_key`

### Vendor Matching
1. Exact email match in `ad_user.email`
2. Vendor cache lookup (`data/vendor-cache.json`)
3. Domain-based lookup (e.g., velocityelec.com → Velocity Electronics)
4. Sender name fuzzy match in `c_bpartner.name`

### Parser Failure Tracking
**File:** `data/parser-failure-tracker.json`

Tracks cumulative rigid parser failures by vendor (keyed by search_key) to prioritize improvements:
- Increments on every PARTIAL (even if later recovered via batch extraction)
- Review weekly/bi-weekly to identify high-failure vendors
- When vendor has significant failures, create vendor-specific template

**Failure types:**
- `garbage_mpn` - Parser extracts random strings instead of MPNs
- `missing_fields` - Could not extract qty and/or price
- `table_parsing` - HTML table structure not parsed correctly
- `mpn_bleeding` - Numbers from MPN bleed into qty/price
- `attachment_only` - Quote data only in PDF/Excel attachment
- `missing_vendor` - Sender email not matched to vendor in DB

### Future Enhancements (Not Yet Implemented)
- **Vendor-specific templates** - Custom parsing for high-failure vendors
- **Attachment parsing** - PDF/Excel quote extraction
- **LLM fallback** - AI extraction for low-confidence parses

**Output:** `vq-parser/output/uploads/VQ_UPLOAD_*_READY.csv`

Then proceed to address the user's message if they included one.

## Session Logging

At the end of each session (or when meaningful progress is made), update the `## Recent Sessions` section in MEMORY.md with a brief summary of what was worked on and the current status. Keep only the 4 most recent entries — drop the oldest when adding a new one.

---

# Astute Analytics Environment

## Business Context

Astute is a semiconductor brokerage specializing in electronic component distribution and supply chain services. Our core business involves:

- **Procurement**: Purchasing electronic components from various sources
- **Quality Assurance**: Testing components for quality and authenticity to ensure supply chain integrity
- **Distribution**: Selling verified parts to OEMs, contract manufacturers, and other resellers
- **Value-Added Services**: Providing supply chain services for peripheral commodities including board-level components

This database contains operational data supporting these business functions.

---

# Environment Constraints

You are operating as a restricted user (`analytics_user`) with limited permissions. Read this entire file before taking any actions.

## Database Access

- **Database**: `idempiere_replica`
- **Access level**: READ-ONLY (SELECT queries only)
- **Connection**: Run `psql` directly (no password needed, database auto-selected)
- **Schemas available**: `adempiere`, `intermediate`, `intermediate_dev`, `mart`, `mart_dev`

You CANNOT run INSERT, UPDATE, DELETE, DROP, CREATE, or any other data-modifying commands. They will fail with "permission denied."

### Example Queries

```bash
# Simple query
psql -c "SELECT COUNT(*) FROM ad_client;"

# Query with output to file
psql -c "SELECT * FROM ad_client;" -o ~/workspace/results.csv

# Interactive session
psql
```

## File System Access

- Working directory: ~/workspace (you start here automatically)
- Write access: ONLY within ~/workspace
- Read access: Limited to world-readable files
- You CANNOT cd to other directories (restricted shell)
- Save all output files to ~/workspace

## Available Commands

You only have access to these commands:
- psql - PostgreSQL client
- claude - This CLI
- node, npm, npx - Node.js runtime and package manager
- ls, cat, head, tail - View files
- grep, sort, wc - Process text
- mkdir, cp, mv, rm - Manage files in workspace
- curl, wget - Fetch data from URLs
- git - Version control

Commands like sudo, apt, vim, nano, ssh, python are NOT available.

## Node.js / JavaScript

Node.js v22 is available along with npm and npx. You can:

- Write and run JavaScript/TypeScript files with `node script.js`
- Install npm packages in ~/workspace (package.json is already initialized)
- Use **Playwright** (pre-installed) for browser automation and web scraping
- Install any npm libraries as needed with `npm install <package>`

### Playwright

Playwright is pre-installed with Chromium. Use it for web scraping, automation, and testing.

```javascript
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('https://example.com');
  console.log(await page.title());
  await browser.close();
})();
```

## File Output Default

Unless otherwise instructed, all saved/output files should be:
1. Copied to `~/workspace/astute-workinstructions/Trading Analysis/`
2. Committed and pushed to GitHub after saving

## Best Practices

1. Always write output files to ~/workspace
2. Use psql -o filename.csv to save query results
3. For large queries, add LIMIT clauses to preview data first
4. Use \dt schemaname.* in psql to list tables in a schema
5. Use \d tablename in psql to see table structure
6. **When creating new folders**: Always add a `.gitkeep` placeholder file so the folder is tracked in git and visible on GitHub immediately. Then commit and push.

## What You Cannot Do

- Modify any database records
- Access other databases
- Install system software (but you CAN install npm packages)
- Access system files or other users' directories
- Change system configurations

This is an analytics and development environment. Focus on SELECT queries, data analysis, and building JavaScript-based tools.
