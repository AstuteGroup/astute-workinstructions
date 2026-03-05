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

### Extraction Philosophy

**CRITICAL: NO EXTRACTION SCRIPTS**

We do NOT use regex-based extraction scripts. They produce garbage data that looks complete but is wrong:
- Wrong manufacturers assigned to parts
- Quantities extracted from zip codes or phone numbers
- Prices extracted from minimum order values
- MPNs extracted from random alphanumeric strings

**Only two extraction methods are allowed:**
1. **Templates** - Pre-built extractors for known vendor formats (high confidence, structured)
2. **Manual extraction in Claude session** - Claude reads emails with human-level understanding and extracts data

The difference: Claude understands that "26k @ .22ea" means qty=26,000 and price=$0.22, not qty=22 and price=$250 (from "$250 min order" later in email). Scripts cannot make these judgments.

### Full Workflow (follow these steps in order)

**Step 1: Fetch**
```bash
node vq-parser/src/index.js fetch
```
- Pulls emails from INBOX via IMAP
- **Templates** - known vendor formats auto-extracted (trusted)
- **No template match** → stays in INBOX for manual extraction
- No-bids detected and recorded (qty=0, price=0)
- Fetch report generated with metrics

**Step 2: Export for Manual Extraction**
```bash
node vq-parser/scripts/export-all-emails.js
```
- Exports all INBOX emails to `data/all-emails-export.json`
- This file is read by Claude for manual extraction

**Step 3: Manual Extraction in Claude Session**

Claude reads emails from the export file and extracts:
- MPN, Qty, Price, Date Code, Manufacturer
- Vendor name and email
- Notes (lead time, MOQ, conditions)

Process:
1. Claude reads batches of 20-30 emails
2. Presents extracted data in table format for user review
3. User approves or corrects
4. Claude writes approved records to VQ_MASTER.csv
5. Repeat until all emails processed

**What to skip during extraction:**
- No-bids (vendor explicitly declined to quote)
- Target price requests (vendor asking for price, no quote data)
- Empty forwards (no vendor response in the body)
- Duplicates (same vendor, same part, same quote already extracted)

**IMPORTANT:** All emails are forwards from team members. The vendor response is BELOW Jake's signature block. Always read to the bottom of the email to find the actual quote.

**Step 4: Categorize Remaining**

| Category | Action |
|----------|--------|
| NO-BID responses | Record with qty=0, reason in notes |
| Attachment-only (PDF) | Queue for PDF review |
| Incomplete quotes | Flag as PARTIAL |
| Spam/irrelevant | Skip |

**Step 5: Final Export**
```bash
node vq-parser/src/index.js export --exclude-partials
```
- Exports clean records (no PARTIAL flags) for ERP import
- Copy to `astute-workinstructions/Trading Analysis/`
- Commit and push

### IMAP Folder Flow
```
INBOX → [fetch] → Template match → Processed
              → No-bid detected → Processed
              → No template → stays in INBOX (for manual extraction)

INBOX → [manual extraction in Claude] → Extracted → Processed
                                      → Skip/spam → delete or leave

NeedsReview → only used for emails that need human decision
```

### RFQ Matching (30-Day Window)
When a vendor quote comes in, the parser matches it to an RFQ in the system:

1. **Exact MPN match** - Search recent RFQs (last 30 days) for exact MPN
2. **Email extraction** - Extract original MPN from NetComponents email format
3. **Fuzzy match** - Progressively trim MPN suffix characters (up to 4) to find partial match
4. **Subject line** - Extract MPN from email subject as last resort
5. **No match** → Flag as `[NEEDS_RFQ - no match in 30 days]` for manual review
6. **Fallback** - 60-day window if no match in 30 days

**Output format:**
- `chuboe_mpn` = RFQ's MPN (what's in the system)
- `chuboe_note_public` = "Quoted MPN: xxx" if vendor quoted different part
- `chuboe_rfq_id` = RFQ number (the `value` field, not database ID)

**Why 30 days?** Vendor responses can take 2-4 weeks. The 60-day fallback catches slower responses.

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

### Fetch Reporting
**File:** `data/fetch-report.json`

Tracks metrics for each fetch run:
- Total emails processed
- Template matches (auto-extracted)
- No-bids detected
- Needs manual review
- Vendor not matched (emails from unknown vendors)
- RFQ not matched (quotes for parts not in recent RFQs)

History kept in `data/fetch-history.json` (last 20 runs).

### Template Development
When a vendor sends many quotes with consistent format, create a template:
- Templates live in `vq-parser/src/parser/templates/`
- Each template extracts MPN, Qty, Price, Date Code from that vendor's format
- Templates are high-confidence, trusted extractions

### PDF Review Queue
PDFs that can't be auto-processed are queued for manual review:
- Queue file: `data/pdf-review-queue.json`
- In Claude session, read PDF content and extract data manually
- No OCR scripts - Claude reads the PDF directly

**Output:** `vq-parser/output/VQ_MASTER.csv`

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
