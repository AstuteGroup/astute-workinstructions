# North Star: Read Before Executing

**THE .MD FILE IS THE SOURCE OF TRUTH. YOUR MEMORY IS NOT.**

Before executing ANY workflow:
1. **USE THE READ TOOL** on the workflow's .md file - do not proceed from memory, context summaries, or prior sessions
2. **FIND THE NUMBERED STEPS** - execute them in order, do not skip steps
3. **FIND THE OUTPUT FORMAT** - use the exact column names, field names, and structure defined in the doc
4. **FIND THE REQUIRED QUERIES** - use the SQL/commands documented, do not improvise

**Why this matters:** Context summaries and memory are lossy. You will forget column names, skip steps, and invent formats that don't match the ERP import template. The .md file has the exact specifications - read it every time.

**This rule applies to:**
- All numbered workflows below
- Any multi-step process with documented specs
- Any output that must match a template or system format

If you catch yourself thinking "I remember how this works" - STOP and read the file instead.

---

# Session Greeting

**TRIGGER:** When you see `SessionStart:startup hook success` in a system-reminder, IMMEDIATELY display the greeting below — do not wait for user input. This allows the user to jump straight into their task.

At the start of every new conversation, before addressing anything else, always display the following:

1. **Recent Work** — Check the `## Recent Sessions` section in MEMORY.md. Display the 2-4 most recent entries so the user can quickly pick up where they left off. Format as:

> **Recent Work (pick up where you left off):**
> - [list from MEMORY.md Recent Sessions, most recent first]

2. **Available Workflows:**

> **Available Workflows:**
> 1. **Franchise Screening** - Screen RFQs against FindChips to filter low-value parts before broker sourcing (see `rfq_sourcing/franchise_check/franchise-screening.md`)
> 2. **RFQ Sourcing** - Submit RFQs to NetComponents suppliers (see `rfq_sourcing/netcomponents/rfq-sourcing-netcomponents.md`)
> 3. **VQ Loading** - Process supplier quote emails into ERP-ready CSV (see `rfq_sourcing/vq_loading/vq-loading.md`)
> 4. **RFQ Loading through AI** - AI-assisted extraction and loading of RFQs from customer emails/documents
> 5. **Market Offer Analysis for RFQs** - Match new RFQs against customer excess and stock offers (see `Trading Analysis/Market Offer Matching for RFQs/market-offer-matching.md`)
> 6. **Quick Quote** - Generate baseline quotes from recent VQs (0-30 days) with margin/GP/rebate pricing logic
> 7. **Seller Quoting Activity** - VQ→CQ→SO funnel analysis by seller (snapshot + 6-month trend)
> 8. **Order/Shipment Tracking** - Look up tracking by COV, SO, MPN, customer PO, or salesperson (see `saved-queries/order-shipment-tracking.md`)
> 9. **Inventory File Cleanup** - Process Infor inventory exports into Chuboe format for iDempiere import (see `Trading Analysis/Inventory File Cleanup/inventory-file-cleanup.md`)
> 10. **Vortex Matches** - Surface VQs/offers under customer targets, stock matches, and market intelligence (see `Trading Analysis/Vortex Matches/vortex-matches.md`)
> 11. **Market Offer Uploading** - Process excess inventory emails into ERP-ready offers (see `Trading Analysis/Market Offer Uploading/market-offer-uploading.md`)
> 12. **BOM Monitoring** - Track BOM risk, commodity analysis, and excess matches (see `Trading Analysis/BOM Monitoring/`)

3. **Review Roadmaps** (planned work):

> **Roadmaps:**
> - `api-integration-roadmap.md` — External APIs (franchise distributors, LLM, future integrations)
> - `rfq_sourcing/sourcing-roadmap.md` — RFQ Sourcing & VQ Processing
> - `Trading Analysis/trading-analysis-roadmap.md` — Vortex Matches, Quick Quote, etc.

4. **Periodic Checks** (every 8 days):

> **Template Candidates:** Check `rfq_sourcing/vq_loading/template-candidates.md`
> - Any vendors with 5+ cumulative quotes? → Review for templateability
> - Show top 3 candidates and their counts
> - Check if structured (table/consistent format) vs free-form (prose) → only structured can be templated

---

## Shared Utilities

**Location:** `shared/`

### CSV Parsing (REQUIRED)

**NEVER use `line.split(',')` for CSV parsing.** It breaks on quoted fields containing commas.

Always use the shared CSV utility:
```javascript
const { readCSVFile } = require('../shared/csv-utils');
const csv = readCSVFile('/path/to/file.csv');

// Filter and aggregate
const filtered = csv.filterByColumn('Warehouse', 'W111');
const total = csv.sumColumn('Lot Cost', row => row[warehouseIdx] === 'W111');
```

See `shared/README.md` for full API.

---

## Documentation Standards

When creating or updating workflow documentation, follow the conventions in `CONVENTIONS.md`:
- Workflow docs use descriptive `kebab-case.md` names (e.g., `inventory-file-cleanup.md`, NOT `README.md`)
- Task files go in `tasks/` with `snake_case.md` names
- Keep workflow docs brief; detailed step-by-step instructions belong in `tasks/`
- Session history goes in `MEMORY.md` (4 most recent entries)
- **Roadmaps** for planned work go in `*-roadmap.md` files — see CONVENTIONS.md for schema

**When planning future work:** Read the area's roadmap first (`rfq_sourcing/sourcing-roadmap.md`, `Trading Analysis/trading-analysis-roadmap.md`), then add items there — not inline in MEMORY.md. The roadmap is the source of truth for planned improvements.

**CRITICAL: Keep CLAUDE.md in sync**
- When updating ANY workflow .md file, also update CLAUDE.md to reference it correctly
- CLAUDE.md should point to detailed docs, NOT duplicate them inline
- This prevents stale/incomplete workflows in CLAUDE.md that diverge from the authoritative source
- The detailed .md file is the single source of truth; CLAUDE.md just references it

**CRITICAL: Explicit Numbered Steps Required**
All workflow documentation MUST include an "End-to-End Workflow" section with:
- **Numbered steps** (Step 1, Step 2, etc.) that must be completed in order
- **"Do not skip"** callouts for critical steps (e.g., database lookups, validation)
- **Explicit outputs** for each step (what file/data is produced)
- **Commands or queries** for steps requiring system interaction

Why: Reference sections (like "Vendor Matching Strategy") get skipped when following a workflow. Numbered steps force sequential execution and prevent missed steps. If a step is important enough to document, it's important enough to number.

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

## VQ Loading Workflow

**BEFORE STARTING:** Read the full workflow documentation at `rfq_sourcing/vq_loading/vq-loading.md`

This includes:
- **Two-Agent Validation** (REQUIRED) - Extractor agent + Verifier agent
- Field reference for VQ Mass Upload Template
- Vendor matching strategy (domain-based, not exact email)
- Session file workflow
- Skip rules and categorization

**Code:** `~/workspace/vq-parser/`
**Repo:** https://github.com/AstuteGroup/vq-parser (private)

**Quick commands:**
```bash
# Fetch emails and generate session file
node vq-parser/src/index.js fetch

# List sessions
node vq-parser/src/index.js sessions --list
```

---

## Quick Quote Workflow

**Documentation:** `Trading Analysis/Quick Quote/quick-quote.md`
**Output:** `Trading Analysis/Quick Quote/output/`

### When User Requests Quick Quote

**ALWAYS follow these steps in order:**

1. **Read the documentation** - Read `Trading Analysis/Quick Quote/quick-quote.md` to get current pricing parameters

2. **State the defaults** - Confirm with user:
   > "Quick Quote defaults: 15% min margin, $250 min GP/line, 30% fat margin fallback, 30-day VQ window. Using these for [Customer]?"

3. **Check for overrides** - Ask if customer has special terms:
   - Different margin requirements?
   - Rebate arrangements?
   - Contract pricing rules?

4. **Execute** - Run the SQL query and export to CSV

5. **Summarize results** - Show count of UNDER/OVER/VERIFY QTY lines and highlight best opportunities

### Pricing Parameters (from quick-quote.md)

| Parameter | Default | Formula |
|-----------|---------|---------|
| Min Margin | 15% | `cost / 0.85` |
| Min GP | $250/line | `cost + $250/qty` |
| Floor Price | Higher of above | `MAX(cost/0.85, cost+$250/qty)` |
| Fat Margin Threshold | 35% | If target margin > 35%, use fallback |
| Fat Margin Fallback | 30% | `cost / 0.70` |
| VQ Window | 30 days | Only recent quotes |
| Date Code Cutoff | 2022+ | Reject older unless blank/lead time |

### Priority Hierarchy for Suggested Resale

1. Same-customer PPV sale → use that price
2. Same-customer Shortage sale → use that price
3. Same-customer losing CQ → undercut by formula
4. Other-customer sale → split the difference
5. Target margin ≤35% → use target price
6. Target margin >35% → use 30% margin fallback

---

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

**CRITICAL: Active Records Only**
Always filter by `isactive = 'Y'` unless explicitly told otherwise. Most iDempiere tables have an `isactive` column — inactive records are soft-deleted and should be excluded from all queries by default.

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

---

## Collaboration Style

Don't just execute requests — actively contribute ideas, alternatives, and feedback. Flag potential issues, suggest better approaches (technical or conceptual), and share observations even when not asked. The user values "unknown unknowns" — things they wouldn't know to ask about. Provide this feedback naturally throughout the session, not just when prompted.
