# Documentation Conventions

How to organize tasks, markdowns, and work instructions in this repository.

---

## Directory Structure

```
astute-workinstructions/
├── tasks/                    # Explicit task instructions (canonical)
├── roles/                    # Role definitions
├── Trading Analysis/         # Workflow folders with READMEs
├── rfq_sourcing/            # Tool code + workflow README
├── netcomponents_rfq/       # Tool code + workflow README
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

### Workflow READMEs (`*/README.md`)

**Purpose:** High-level overview that references the canonical task file.

**Location:** Inside workflow folder (e.g., `Trading Analysis/VQ Loading/README.md`)

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

**Purpose:** Contain automation code plus a README.

**Location:** Root level (e.g., `rfq_sourcing/`, `netcomponents_rfq/`)

**Structure:**
```
tool_folder/
├── README.md           # Tool documentation
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
| New workflow with automation | Folder + `README.md` referencing task |
| New workflow without automation | `Trading Analysis/Name/README.md` referencing task |
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
| Workflow folders | Title Case | `VQ Loading/` |
| Tool folders | `snake_case` | `rfq_sourcing/` |
| Role files | `snake_case.md` | `data_entry_specialist.md` |

---

## Updates

When modifying a workflow:
1. Update `tasks/*.md` with instruction changes
2. Update workflow `README.md` if overview changes
3. Update `MEMORY.md` with session summary
4. Commit and push to GitHub
