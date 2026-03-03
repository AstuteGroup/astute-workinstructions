# Documentation Conventions

How to organize tasks, markdowns, and work instructions in this repository.

---

## Directory Structure

```
astute-workinstructions/
├── tasks/                    # Explicit task instructions (canonical)
├── roles/                    # Role definitions
├── Trading Analysis/         # Workflow folders with descriptive docs
├── rfq_sourcing/            # RFQ sourcing (franchise_check + netcomponents)
├── (vq-parser is a separate repo: AstuteGroup/vq-parser)
├── src/                     # Legacy work instructions
├── CLAUDE.md                # Claude Code session instructions
├── MEMORY.md                # Session tracking (recent work)
└── CONVENTIONS.md           # This file
```

---

## File Types

### Task Files (`tasks/*.md`)

**Purpose:** Canonical, explicit instructions for a specific task.

**Location:** `tasks/` folder

**Naming:** `task_name.md` (snake_case)

**Contents:**
- Step-by-step instructions
- Field mappings and valid values
- Commands and examples
- Database queries if applicable
- Error handling and edge cases

**Examples:**
- `tasks/vq_loading.md`
- `tasks/market_offer_upload.md`

---

### Workflow Documentation (`*/workflow-name.md`)

**Purpose:** High-level overview that references the canonical task file.

**Location:** Inside workflow folder (e.g., `Trading Analysis/Inventory File Cleanup/inventory-file-cleanup.md`)

**Naming:** Use descriptive `kebab-case.md` names that reflect the workflow, NOT generic `README.md`. This ensures files are identifiable when moved, searched, or viewed outside folder context.

**Examples:**
- `inventory-file-cleanup.md` (not `README.md`)
- `market-offer-matching.md` (not `README.md`)
- `franchise-screening.md` (not `README.md`)
- `rfq-sourcing-netcomponents.md` (not `README.md`)

**Contents:**
- Quick start command
- Link to task file for details
- Brief overview of what the workflow does
- Related workflows

**Keep it short.** Detailed instructions belong in `tasks/`.

---

### Role Definitions (`roles/*.md`)

**Purpose:** Define responsibilities and capabilities for a role.

**Location:** `roles/` folder

**Naming:** `role_name.md` (snake_case)

---

### Tool Folders (with code)

**Purpose:** Contain automation code plus workflow documentation.

**Location:** Root level (e.g., `rfq_sourcing/`)

**Structure:**
```
tool_folder/
├── workflow-name.md    # Descriptive workflow doc (not README.md)
├── src/ or python/     # Source code
├── config.js           # Configuration
└── output/             # Generated files
```

---

### Session Memory (`MEMORY.md`)

**Purpose:** Track recent work sessions for context continuity.

**Location:** Repository root

**Contents:**
- Recent Sessions (4 most recent)
- Workflow Index
- Key file references

**Updated:** At end of each session or when meaningful progress is made.

---

## When to Create What

| Situation | Create |
|-----------|--------|
| New repeatable task with specific steps | `tasks/task_name.md` |
| New workflow with automation | Folder + `workflow-name.md` referencing task |
| New workflow without automation | `Trading Analysis/Name/workflow-name.md` referencing task |
| New role | `roles/role_name.md` |
| Ad-hoc analysis or one-time work | Don't document (or note in MEMORY.md) |

---

## Linking Convention

READMEs should link to task files:

```markdown
See **[tasks/vq_loading.md](../../tasks/vq_loading.md)** for detailed instructions.
```

Task files should be self-contained and not require reading other files.

---

## Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Task files | `snake_case.md` | `vq_loading.md` |
| Workflow docs | `kebab-case.md` (descriptive) | `inventory-file-cleanup.md` |
| Workflow folders | Title Case | `VQ Loading/` |
| Tool folders | `snake_case` | `rfq_sourcing/` |
| Role files | `snake_case.md` | `data_entry_specialist.md` |

**Important:** Never name workflow docs `README.md`. Use descriptive names that identify the content without relying on folder context.

---

## Updates

When modifying a workflow:
1. Update `tasks/*.md` with instruction changes
2. Update the workflow doc (`workflow-name.md`) if overview changes
3. Update `MEMORY.md` with session summary
4. Commit and push to GitHub
