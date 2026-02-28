# Session Greeting

At the start of every new conversation, before addressing anything else, always display the following:

1. **Recent Work** — Check the `## Recent Sessions` section in MEMORY.md. Display the 2-4 most recent entries so the user can quickly pick up where they left off. Format as:

> **Recent Work (pick up where you left off):**
> - [list from MEMORY.md Recent Sessions, most recent first]

2. **Available Workflows:**

> **Available Workflows:**
> 1. **Franchise Screening** - Screen RFQs against FindChips to filter low-value parts before broker sourcing
> 2. **RFQ Sourcing** - Submit RFQs to NetComponents suppliers (single part or batch from iDempiere RFQ)
> 3. **VQ Loading** - Process supplier quote emails into ERP-ready CSV (see `~/workspace/vq-parser/`)
> 4. **Market Offer Analysis for RFQs** - Match new RFQs against customer excess and stock offers (includes pricing & valuation logic)
> 5. **Quick Quote** - Generate baseline quotes from recent VQs (0-30 days) with margin/GP/rebate pricing logic
> 6. **Seller Quoting Activity** - VQ→CQ→SO funnel analysis by seller (snapshot + 6-month trend)
> 7. **Order/Shipment Tracking** - Look up tracking by COV, SO, MPN, customer PO, or salesperson (see `saved-queries/order-shipment-tracking.md`)

---

## VQ Parser Quick Reference

**Location:** `~/workspace/vq-parser/`

**Commands:**
```bash
# Fetch new emails from INBOX and process
node vq-parser/src/index.js fetch

# Reprocess all emails in Processed folder (uses current IDs)
node vq-parser/scripts/batch-reprocess.js --folder Processed

# Consolidate CSVs into upload-ready files
node vq-parser/src/index.js consolidate
```

**Vendor Matching Strategy:**
1. Exact email match in `ad_user.email`
2. Domain-based lookup (e.g., velocityelec.com → Velocity Electronics)
3. Sender name fuzzy match in `c_bpartner.name`
4. LLM inference (requires `ANTHROPIC_API_KEY` in `.env`)

**Output:** `vq-parser/output/uploads/VQ_UPLOAD_*.csv`

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
