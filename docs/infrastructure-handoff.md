# Infrastructure Handoff Document

**Purpose:** This document provides context for AI assistants (Claude Desktop, ChatGPT, etc.) connecting to this repository via GitHub. It explains the overall infrastructure, what's visible via GitHub vs. what requires direct server access, and how different tools can collaborate.

---

## Repository Overview

**Repository:** `AstuteGroup/astute-workinstructions`

This is the central codebase for Astute Group's trading operations automation. It contains:

- **Workflow documentation** — step-by-step processes for RFQ loading, VQ purchasing, inventory cleanup, etc.
- **Shared modules** (`shared/`) — reusable JavaScript libraries for database queries, API writes, email parsing, Excel generation
- **Cron job registry** (`cron-jobs.js`) — scheduled automation tasks
- **Agent instructions** (`CLAUDE.md`) — operating procedures for the Claude Code CLI agent
- **Session history** (`MEMORY.md`) — recent work and terminology reference

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         GITHUB REPOSITORY                            │
│                   (astute-workinstructions)                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │ CLAUDE.md   │  │  shared/    │  │  Trading    │  │   docs/     │ │
│  │ MEMORY.md   │  │  (modules)  │  │  Analysis/  │  │  (guides)   │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                │ git pull
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      LINUX SERVER (analytics_user)                   │
│                                                                      │
│  ~/workspace/                                                        │
│  ├── astute-workinstructions/  ← git repo (synced with GitHub)      │
│  ├── [temp files, one-offs]    ← NOT in git                         │
│  ├── .env                      ← credentials (gitignored)           │
│  └── .cron-sentinels/          ← runtime state                      │
│                                                                      │
│  ┌──────────────────┐    ┌──────────────────┐                       │
│  │ PostgreSQL       │    │ iDempiere REST   │                       │
│  │ (idempiere_      │    │ API (OT writes)  │                       │
│  │  replica - R/O)  │    │ 172.31.7.239     │                       │
│  └──────────────────┘    └──────────────────┘                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Tool Capabilities Matrix

| Capability | Claude Code CLI | GitHub-Connected Tools |
|------------|-----------------|------------------------|
| Read repository files | Yes | Yes |
| Read temp/working files outside repo | Yes | **No** |
| Query PostgreSQL database | Yes | **No** |
| Write to OT via REST API | Yes | **No** |
| Run Node.js scripts | Yes | **No** |
| Execute cron jobs | Yes | **No** |
| Process emails | Yes | **No** |
| Generate Excel/send emails | Yes | **No** |
| Review code and architecture | Yes | Yes |
| Suggest code changes | Yes | Yes |

---

## Key Directories

### `shared/` — Reusable Modules

Core infrastructure code:

| Module | Purpose |
|--------|---------|
| `api-client.js` | REST API client for OT writes |
| `db.js` | PostgreSQL connection pool |
| `rfq-writer.js` | Creates RFQs in OT |
| `vq-writer.js` | Creates VQ lines |
| `offer-writeback.js` | Creates offers |
| `mfr-lookup.js` | Manufacturer name resolution |
| `mpn-normalization.js` | MPN matching logic |
| `csv-utils.js` | CSV parsing |
| `email-workflow-poller.js` | Email inbox polling |

### `Trading Analysis/` — Workflow Documentation

Each workflow has a `.md` file with:
- Step-by-step numbered instructions
- Required inputs and outputs
- SQL queries and API calls
- Output format specifications

Key workflows:
- `RFQ Loading/rfq-loading.md`
- `RFQ Sourcing/vq_loading/vq-loading.md`
- `Quick Quote/quick-quote.md`
- `Inventory File Cleanup/inventory-file-cleanup.md`

### `docs/` — Reference Documentation

- `workflow-catalog.md` — master list of all 26+ workflows
- `environment.md` — server setup and credentials
- `data-model.md` — database schema reference (in `shared/`)

---

## Database Schema (Key Tables)

The system uses iDempiere with custom Chuboe tables:

| Table | Purpose |
|-------|---------|
| `chuboe_rfq` | Request for Quote header |
| `chuboe_rfq_line` | RFQ line items |
| `chuboe_rfq_line_mpn` | MPN/MFR details per line |
| `chuboe_vq_line` | Vendor quotes |
| `chuboe_cq_line` | Customer quotes |
| `chuboe_offer` | Offer header |
| `chuboe_offer_line` | Offer line items |
| `c_bpartner` | Business partners (customers/vendors) |
| `chuboe_mfr` | Manufacturers |

**Important:** The database replica is READ-ONLY. All writes go through the REST API.

---

## Terminology

| Term | Meaning |
|------|---------|
| OT | Orange Tsunami — internal name for the iDempiere ERP system |
| RFQ | Request for Quote (customer asking for pricing) |
| VQ | Vendor Quote (supplier response) |
| CQ | Customer Quote (our response to customer) |
| MPN | Manufacturer Part Number |
| CPC | Customer Part Code (customer's internal part number) |
| BP | Business Partner (customer or vendor) |
| MFR | Manufacturer |
| POV | Purchase Order for Vendor |

---

## How to Collaborate

### If you're reviewing code or architecture:

1. You have full access to all tracked files via GitHub
2. Reference specific files using paths like `shared/api-client.js` or `Trading Analysis/RFQ Loading/rfq-loading.md`
3. Suggest changes, but note that execution happens via Claude Code CLI

### If you're asked about a workflow:

1. Check `docs/workflow-catalog.md` for the list of available workflows
2. Read the specific workflow's `.md` file for detailed steps
3. Note: You cannot execute workflows — you can only review and discuss them

### If you're asked about data or queries:

1. Reference `shared/data-model.md` for schema documentation
2. You can suggest SQL queries, but cannot run them
3. For query results, the user must run them via Claude Code CLI

---

## What's NOT in This Repository

The following exist on the server but are NOT tracked in git:

- **Credentials** (`.env`) — database connection strings, API keys
- **Runtime state** — cron sentinels, API queue, logs
- **Temporary files** — one-off scripts, data exports, email attachments
- **Generated outputs** — Excel files, reports

If you need information about these, ask the user to check via Claude Code CLI.

---

## Recent Activity

See `MEMORY.md` for the most recent work sessions. This is updated regularly and provides context on what's been worked on lately.

---

*Last updated: 2026-08-06*
