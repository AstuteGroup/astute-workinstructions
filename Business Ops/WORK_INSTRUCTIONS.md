# Work Instruction

## TOC

- [Summary](#summary)
- [Document Maintenance Guidelines](#document-maintenance-guidelines)
- [CRITICAL: No Real User or Company Data](#critical-no-real-user-or-company-data)
- [DRY](#dry)
- [Progressive Conformance](#progressive-conformance)
- [Me, We, Enterprise](#me-we-enterprise)
- [Documentation Style](#documentation-style)
- [Content Selection Guidelines](#content-selection-guidelines)
  - [What to Include](#what-to-include)
  - [What to Exclude](#what-to-exclude)
  - [Decision Framework](#decision-framework)
  - [Media Selection](#media-selection)
- [README](#readme)
  - [Purpose](#purpose)
  - [Structure](#structure)
  - [When to Create a README](#when-to-create-a-readme)
  - [Subdirectory README](#subdirectory-readme)
- [Work Instruction Types](#work-instruction-types)
  - [Principles](#principles)
  - [Roles](#roles)
  - [Tasks](#tasks)
  - [Tools](#tools)
  - [Example: Training-Enriched Role Documentation](#example-training-enriched-role-documentation)
- [Why Markdown](#why-markdown)
- [Markdown Document Structure](#markdown-document-structure)
- [Markdown Task Lists](#markdown-task-lists)
  - [Simple Task List Example](#simple-task-list-example)
  - [Hierarchical Task List Example](#hierarchical-task-list-example)
- [Document Naming Convention](#document-naming-convention)
- [Directory Structure](#directory-structure)
- [Tags](#tags)
- [Notes Warnings Tips References and Comments](#notes-warnings-tips-references-and-comments)

## Summary

The purpose of this document is to help the team write clear, concise and conformant work instructions. Reference this document when making changes to any work instructions in any repository. Adhere to the following 'Document Maintenance Guidelines' section.

## Document Maintenance Guidelines

The following are core principles of maintaining clear, concise anti-fragile and conformant work instructions:

- **DRY, Clear and concise**: Remove redundancy, focus on essential information and reference related information by name
- **Word Liability**: Every word is a liability that must be maintained over time — if you cannot name the question a sentence answers, delete it
- **Progressive Conformance**: Standards evolve — meet them in the content you touch, fix cheap gaps in the document you touched, and report rather than silently fix or rewrite non-conformance found elsewhere
- **Documentation Style**: Get to the point, discuss the big picture, share appropriate details and stay friendly
- **Consider AI in Content Creation**: Create material that can be directly applied and electrified by AI
- **Prioritize references over examples**: If work instructions exist, reference them (do not repeat them)
- **Avoid line number references**: Use searchable string references (e.g., "see Parameters Record Pattern")
- **Prefer search terms over file references**: use searchable string references instead direct file references when appropriate
- **Skills reference skills, not READMEs**: Reference another skill by its name (the frontmatter `name`) — a README exists to help maintain a repo's work instructions, so anything an actor needs to succeed belongs in a skill
- **Avoid numbered cross-references**: Reference sections by name, not number (e.g., "see UUID Pattern" not "see Pattern 13") - numbered references break when content is reordered
- **Current references only**: Remove historical context and deprecated approaches
- **Maintain TOC**: Update the table of contents when adding or removing major sections and only include ## and ### sections

## CRITICAL: No Real User or Company Data

⚠️ **Never include actual company names, email addresses, user credentials, or real employee information in work instructions that will be committed to public repositories.**

**Always use fictional/generic placeholders:**

| Safe Replacement | Use For |
|----------------|---------|
| `ACME` | Company/tenant names |
| `example.com` | Email domains |
| `user@example.com` | Email addresses |
| `[CLIENT_ID]` | Numeric identifiers |
| `[SET_PASSWORD]` | Password examples |

**Why this matters:** Public repositories expose work instructions to the world. Real data creates attack surface (valid domains for phishing, username patterns, system IDs) and violates privacy. Generic examples communicate patterns without risk.

**When in doubt:** Use `example.com` for emails/domains, `ACME` for company names, and bracket placeholders like `[CLIENT_ID]` for numeric identifiers.

## DRY

Go to great effort to "Don't Repeat Yourself" (DRY). Be kind, clear and concise.

## Progressive Conformance

The purpose of this section is to decide how much of an existing document must meet the current standard when you change it.

This is important because these standards evolve, and documents written before a principle existed do not update themselves. Read literally, "conform to work instructions" turns every small edit into a repo-wide audit; ignored entirely, non-conformance becomes permanent and the standard becomes fiction. So conformance expands over time, guided by how close the gap sits to the change you are making:

| Scope | Expectation |
|-------|-------------|
| The content you are changing | Meet current standards — not optional |
| The rest of the document you touched | Fix cheap, low-risk gaps such as frontmatter, naming, or a stale cross-reference; a larger rewrite is a judgment call, not a duty |
| Any other document | Leave it alone |

**Name what you do not fix.** When you notice non-conformance outside your change, say so when you report the change so the knowledge is not lost, and let the owner decide whether it earns its own effort. Silent tolerance and unrequested rewrites are both failures.

Expect older documents to lag. A gap in one is work not yet done — never a pattern to copy or a precedent to cite.

## Me, We, Enterprise

The purpose of this section is to offer a shared way to talk about who a work instruction is for, so you can meet a reader where they are.

This is a consideration rather than a rule. The idea is young and will evolve alongside our tooling, so treat it as vocabulary worth holding in mind while you write.

- **me** — someone says "I want to think about the following ...". Consider a personal repo, where an idea can be rough and still be useful. See the `personal-repo` skill for what belongs in one.
- **we** — a `wi-*` repo. This is how we share skills, and it is where most work instructions live.
- **enterprise** — today every actor sees every skill we share; as the infrastructure evolves, a role's world will shrink to the skills that role needs.

Writing a me-scope idea so it could move to `wi-*` later is a kindness to your future self rather than an obligation.

## Documentation Style

Our goal is to speak to all operating styles in a way they wish to be communicated with. The following is a framework for accomplishing this goal.

- **Get the point**: Start with the phrase "The purpose of this ... is to ...". By simply stating this phrase, you will lower the tension of driving style users.
- **Big Picture**: Follow the purpose with "... is important because ...". By explaining "what's in it for them", we lower the tension of expressive style users.
- **Details**: After stating the what "point" and the why "picture", supply the needed details as is appropriate. By supplying appropriate details, we lower the tension of analytical style users.
- **Friendly**: Stay people friendly. Almost everyone likes it when we are friendly.

## Content Selection Guidelines

The purpose of this section is to help you decide what content to include or exclude from work instructions.

This is important because of **Word Liability** — every word costs future maintenance effort. Write the minimum needed for success.

### What to Include

Include content that is **specific to your organization**:
- Your vocabulary and terminology
- Your specific process variations
- Your system configurations and settings
- Your role definitions and boundaries
- Your approval workflows and authorities
- Your specific business rules and policies

### What to Exclude

Exclude content that is **general knowledge or industry standard**:
- General concepts (e.g., "what is an invoice")
- Industry standard processes (e.g., "how accounting works")
- Tool vendor documentation (e.g., "how to use a spreadsheet")
- Widely available tutorials (e.g., "how to write markdown")

### Decision Framework

When writing, ask yourself:
1. **Is this unique to our organization?** → Include it
2. **Could AI answer this from general knowledge?** → Exclude it
3. **Does this explain HOW we do it differently?** → Include it
4. **Does this explain WHAT something is generally?** → Exclude it

### Media Selection

Choose media based on long-term maintenance cost:

**Words (preferred)**
- Use for: Processes, policies, rules, definitions
- Benefits: Easy to maintain, search, version, and AI-process
- Update frequency: Frequent updates manageable

**Pictures (use sparingly)**
- Use for: Complex spatial relationships, UI layouts when unavoidable
- Drawbacks: Outdated quickly, not easily searchable, harder to version
- Update frequency: Only if rarely changes

**Videos (avoid unless critical)**
- Use for: One-time events/scenarios like initial launch demonstrations
- Drawbacks: Highest maintenance cost, most difficult to search or version
- Update frequency: Often impractical to maintain

## README

README documents serve a specific purpose in work instruction documentation: **concepts and discovery, not implementation details**.

### Purpose

**Focus on the "why" and "when", not the "how":**
- Module/directory purpose and organizational integration
- Conceptual overview of what problem it solves
- Quick start examples showing typical usage patterns
- Links to detailed work instructions (roles, tasks, tools)

**Implementation details belong in work instructions:**
- Detailed step-by-step procedures → Task documents
- Specific tool usage and parameters → Tool documents
- Responsibilities and boundaries → Role documents

### Structure

```markdown
# [Directory/Module Name]

Brief description of purpose and integration (2-3 sentences).

## Quick Start

[Simple example showing most common usage]

## Work Instructions

- [Link to relevant role documents]
- [Link to relevant task documents]
- [Link to relevant tool documents]

## Related Documentation

[Links to external references or related modules]
```

### When to Create a README

**Every `wi-*` repository has a README at its root** — always, even when the repo holds a single work instruction. The root README exists so anyone (human or AI) can tell at a glance why the repo exists and where to go next. Keep it short: the repo name, a one- to two-sentence purpose, and links to the work instructions it contains.

Beyond the required root README, add a README inside a subdirectory only when that subdirectory needs its own conceptual grouping, quick-start, or navigation help — see [Subdirectory README](#subdirectory-readme).

Don't add a README that would only restate the root README, duplicate a work instruction's summary, or describe a self-explanatory structure.

### Subdirectory README

The purpose of subdirectory READMEs is to prevent parent READMEs from becoming too large by moving detailed content into focused child documents.

This is important because it keeps navigation simple while preserving access to detailed information when needed.

**Scope:** this guidance governs README trees — directories a human browses, where following a link costs nothing. It does not apply to a tool skill's artifact directories (`scripts/`, `templates/`, `examples/`), where `SKILL.md` remains the single entry point. See [Where Skill Content Belongs](#where-skill-content-belongs).

**When to create a subdirectory README:**
- Parent README exceeds 200 lines
- Subdirectory has significantly different scope than parent
- Subdirectory needs detailed context that would clutter parent

**Parent-Child relationship:**
- **Parent README**: Overview and references to subdirectories
- **Child README**: Detailed content specific to subdirectory
- Parent references child: "See [subdirectory/README.md](subdirectory/README.md) for details"
- Child does NOT reference parent (hierarchy is one-way)

**DRY principle:**
- Do not repeat content between parent and child
- Parent provides overview, child provides details
- Child assumes reader has read parent context

**Subdirectory README content:**
- Specific purpose of this subdirectory (why was it created)
- How it differs from sibling directories
- Structure and organization within subdirectory

## Work Instruction Types

An actor is any entity that assumes a role: human, AI agent, or service.

All work instructions describe processes fulfilled by actors:

- **Principles** - immutable rules that govern execution
- **Roles** - responsibilities and boundaries for any actor
- **Tasks** - actions performed by one or more actors
- **Tools** - resources used to perform tasks

Write documentation that helps any actor understand and execute effectively.

### Principles

Principles describe organization-wide immutable rules that all actors must respect.

The purpose of a principles document (also called a constitution) is to define what must always be true across the organization. This is important because principles provide the foundation that roles, tasks, and tools build upon.

Principles differ from other work instruction types:
- **Principles** = organization-level truths (always true, regardless of actor or action)
- **Roles** = actor-level guardrails (boundaries for a specific actor type)
- **Tasks** = action-level prerequisites (what must be true before this action)

**Structure of a principles document:**

```markdown
# [Organization/Domain] Principles

## Core Principles

### I. [Principle Name]
[What must always be true]
[Why this principle exists]

### II. [Principle Name]
...

## Governance

[How principles are amended]

**Version**: X.Y | **Ratified**: YYYY-MM-DD
```

**Include organization-specific information:**
- Non-negotiable constraints (what must always be true)
- Quality thresholds (measurable standards that apply universally)
- Amendment process (how principles evolve over time)

### Roles

Roles describe the contract between an actor and the organization.

The role work instruction defines boundaries that dictate the extent an actor can augment, automate, or change tasks and tools.

**Include organization-specific information:**
- Authority boundaries and escalation thresholds
- Your vocabulary and terminology (not general definitions)
- Common request patterns and expected responses
- Scope limitations (what's outside this role)

### Tasks

Tasks describe what and how an actor performs an action.

Many task work instructions require the use of tools. You will be tempted to include tool instructions in your tasks. **Don't do it!** If you have a task that depends on a tool, reference the tool work instruction so that someone can find the dedicated instructions when needed.

**Best practice example:**
> Find open orders using the ERP => (reference to tool page)

In this example:
- State the destination using general breadcrumb navigation
- Do not include screenshots or pictures
- Do not explain how to find or navigate the ERP
- Simply describe the path and link to the tool work instructions

**Include organization-specific information:**
- Decision points where clarification is needed (your business rules)
- Edge case handling specific to your organization
- Prerequisites and assumptions to verify before acting
- Confidence thresholds (when to confirm vs. proceed)

### Tools

Tools describe the physical and digital resources, systems, and technologies used to execute tasks.

The biggest challenge with tool instructions is finding the minimum documentation needed to create success. Error on the side of writing less and test your work instructions. You can always write more later.

**Naming conventions for tool references:**

Be consistent with how you refer to tool objects:

- **Capitalize window/menu names, lowercase "window"**
  - Example: Sales Order window
  - Example: Payment Term window

- **Use quotes for specific items** when there is potential for confusion
  - Example: Payment Term window => "Net 10" record
  - Example: Status field => "Approved" option

- **Use breadcrumbs for multi-step navigation**
  - Example: ERP => Sales Order window => Line subtab => Process toolbar => Copy Lines process
  - Pattern: System => Window => Tab => Section => Action

**What to include in tool documents:**
- How to launch or access the tool
- Navigation patterns within the tool
- Key interface elements and their purpose
- Common operations and workflows
- Tool-specific configurations

**Include organization-specific information:**
- Your system configurations and customizations
- Common error states and what they mean in your context
- How to translate technical outputs to non-technical language

#### Tool Skill Structures

Tool skills (the documents deployed by `wi-base/refresh-skills.sh` into `.opencode/skills/` and `.pi/skills/`) support two structures. Pick the simplest one that fits.

**1. Single-file skill (default)**

Use when the tool documentation stands alone with no companion files.

```
wi-{scope}/
└── {skill-name}-tool.md
```

**2. Directory skill (with artifacts)**

Use when the skill ships helper scripts, sample configs, or other artifacts that travel with the documentation.

```
wi-{scope}/
└── {skill-name}-tool/
    ├── SKILL.md
    ├── scripts/
    │   └── helper.py
    ├── references/
    │   └── error-codes.md
    └── examples/
        └── sample.yaml
```

Key rules:
- The directory name carries the `-tool` suffix (this is how `refresh-skills.sh` recognizes it as a skill).
- The skill document inside is always named `SKILL.md`.
- Supporting artifacts live in flat subdirectories one level deep (e.g., `scripts/`, `references/`, `examples/`). Avoid deeper nesting — see [Directory Structure](#directory-structure).
- `scripts/` holds runnable artifacts; `references/` holds documentation an actor reads on demand. See [Where Skill Content Belongs](#where-skill-content-belongs).

**Choosing between the two:**

| Choose single-file when... | Choose directory when... |
|----------------------------|--------------------------|
| Pure documentation with no companion files | The skill includes runnable scripts referenced by the doc |
| All examples fit inline in code blocks | The skill ships sample data or configuration files |
| No artifacts to version alongside the doc | Grouping artifacts with the doc adds clarity |

Both forms use the same frontmatter (see [Tool Frontmatter Standards](#tool-frontmatter-standards) below).

#### Where Skill Content Belongs

The purpose of this section is to decide what belongs in `SKILL.md` versus a companion file.

This is important because skills are *loaded*, not browsed. Only a skill's `description` stays in context; an actor must choose to read `SKILL.md`, then choose again to read anything deeper. Every hop is a decision that can be skipped — and an actor who finds `SKILL.md` apparently complete will invent a flag rather than go looking for the real one. A README is read by a human who follows links at no cost, so the parent/child split that suits README trees is the wrong instinct here.

**`SKILL.md` must stand alone for the primary use cases.** An actor that reads only `SKILL.md` should complete the common paths correctly, including how to invoke any bundled script and the flags those paths require. Scripts live in `scripts/` for maintainability — that is a code-organization choice, not a documentation boundary. Documenting how to run them is not duplication.

**Split by how often content is needed, not by where the files live.**

| Keep in `SKILL.md` | Move to `references/` |
|--------------------|-----------------------|
| Primary use cases and their commands | Exhaustive flag or option matrices |
| Flags the common paths require | Troubleshooting and rare error states |
| Invariants and rules an actor must respect | Deep background or protocol detail |
| Where artifacts live and how to run them | Large samples and fixtures |

**Name the trigger, not just the file.** When you do split, state *when* to read further — "read `references/errors.md` when a call returns 4xx" — rather than leaving a bare pointer. A pointer without a condition is routinely ignored.

**Size is the signal to split.** Under roughly 500 lines, prefer one self-sufficient `SKILL.md`. Past that, move the least-used material into `references/` and keep the entry point tight.

> ⚠️ **Warning** - Do not put a README inside a skill's `scripts/` that restates how to use the scripts. That content belongs in `SKILL.md`, and the script's own `--help` header serves anyone at a terminal. A third copy drifts out of date.

#### Skill Description

The purpose of this section is to write a skill `description` that gets the skill loaded at the right moment.

This is important because the description is the only part of a skill always in context (see [Where Skill Content Belongs](#where-skill-content-belongs)). It is not a title — it is the trigger an actor matches against a situation. A description that states only *what* a tool does is read and passed over by the actor who does not recognize their problem as the one it solves.

**Name the situation, then the mechanism.**

| Weak (what only) | Strong (situation first) |
|------------------|--------------------------|
| "Run a pi sub-agent in a detached tmux session under a persisted session id." | "Hand a task to a pi sub-agent running in a detached tmux session — use when work is long-running, output-heavy, or splits into independent pieces worth running in parallel." |

Carry three things, in this order:

- **The trigger** — "use when ...", stated as the need or symptom, not the feature.
- **The actor's own words** — the phrasing someone would actually type, including synonyms ("audit" and "review" mean the same request).
- **The boundary** — when sibling skills look alike, say which wins ("for anything you watch yourself, use pi-headless-tui").

Keep it to one to three sentences: it costs context on every request. This is [Documentation Style](#documentation-style) compressed — point, then why, and no details.

#### Tool Frontmatter Standards

Tool skills require YAML frontmatter for AI skill indexing. Add frontmatter at the top of every `*-tool.md` file or `*-tool/SKILL.md` file.

**Frontmatter Structure:**

```yaml
---
name: {kebab-case-identifier}
description: {one-line-purpose-statement}
compatibility: opencode
metadata:
  type: tool
  original_file: {filename}.md
  category: {functional-category}
  scope: {scope-identifier}
---
```

**Field Definitions:**

| Field | Description | Example |
|-------|-------------|---------|
| `name` | Kebab-case identifier matching filename minus `-tool.md` | `idempiere-rest-api`, `metabase-api` |
| `description` | Situation-first summary: what the tool does *and* when to reach for it — see [Skill Description](#skill-description) | "REST API patterns for authentication..." |
| `compatibility` | Always `opencode` | `opencode` |
| `metadata.type` | Always `tool` | `tool` |
| `metadata.original_file` | Path of the source document inside the `wi-*` directory. For single-file skills this is the filename; for directory skills this is `{skill-name}-tool/SKILL.md` | `idempiere-rest-api-tool.md` or `nws-tx-alerts-api-tool/SKILL.md` |
| `metadata.category` | Functional category (e.g., integration, debugging, data, backup) | `integration` |
| `metadata.scope` | Maps to wi-* directory name | `idempiere`, `metabase`, `linux`, `incus` |

**Scope Mapping:**

| Directory | Scope Value |
|-----------|-------------|
| `wi-idempiere-admin/*` | `idempiere` |
| `wi-idempiere-oeig/*` | `idempiere` |
| `wi-metabase/*` | `metabase` |
| `wi-incus/*` | `incus` |
| `wi-linux/*` | `linux` |

**Example:**

```yaml
---
name: idempiere-rest-api
description: REST API patterns for authentication, CRUD operations, nested record creation, process execution, and query filtering in iDempiere
compatibility: opencode
metadata:
  type: tool
  original_file: idempiere-rest-api-tool.md
  category: integration
  scope: idempiere
---
```

> **📝 Note** - Roles and tasks may have frontmatter in the future for expanded skill support.

### Example: Training-Enriched Role Documentation

Here's how organization-specific training information enhances work instructions:

**Role Example - AP Clerk:**

```markdown
# AP Clerk Role

The purpose of this role is to process accounts payable invoices from receipt through payment.

**Authority Boundaries:**
- Approve invoices up to $5,000
- Invoices $5,000-$10,000 require supervisor approval
- Invoices >$10,000 require manager approval

**Organization Vocabulary:**
- "Held invoice" = invoice pending additional information
- "Process invoice" = match to PO, verify amounts, approve, schedule payment

**Common Requests:**
- "Where's invoice #123?" → Check ERP status, provide current state
- "Rush this payment" → Verify authority, escalate if >$5,000
```

This example shows organization-specific content (YOUR approval thresholds, YOUR terminology, YOUR escalation rules) rather than general concepts.

## Why Markdown

The purpose of this section is to explain why markdown is the preferred format for work instructions.

This is important because markdown works everywhere and ensures your words remain accessible and usable indefinitely.

**Mass utilization:**
- **Web** - Renders beautifully in browsers and documentation sites
- **Terminal** - Readable in command-line interfaces and text editors
- **Code** - Native format in development environments and version control
- **AI** - Easily processed by language models and automation tools
- **Plain text** - Future-proof, tool-independent, always accessible

**Key benefits:**
- Human-readable in raw form (no special tools required)
- Machine-readable for automation and AI processing
- Version control friendly (git tracks changes clearly)
- Platform independent (works on any operating system)
- Zero lock-in (never trapped in proprietary formats)

Avoid formats like Word documents or Google Docs that trap your content in specific tools. Markdown keeps your words free and universally accessible.

## Markdown Document Structure

The purpose of this section is to establish proper heading hierarchy in markdown documents.

This is important because correct structure ensures documents are scannable, navigable, and accessible.

**Document Structure:**
- `#` (H1) = Document title (one per page on the first line)
- `##` (H2) = Major sections
- `###` (H3) = Subsections
- This hierarchy makes documents scannable and navigable

As a general rule, include a 'Table of Contents' or TOC as the first `##` (H2). Here is a quick script to help visualize in list form the current TOC of any markdown document:

```
./toc.sh <file.md>
```

## Markdown Task Lists

Task lists are a common tool when creating work instructions. Humans understand them. AI understands them. Use them to articulate clear and concise steps, dependencies, and completion criteria for any process or workflow.

### Simple Task List Example

In Markdown, you create task lists by doing the following:

- [ ] start with a bullet '-' for unordered lists or a '1.'
- [ ] follow the bullet with brackets '[ ]'

The above is a bulleted (unordered) list. Here is how you create a numbered list where the numbers will auto-increment when viewed in a markdown format:

1. [ ] First item
1. [ ] Second item
1. [ ] Third item

> **📝 Note** - this example needs to be replaced with an existing reference to confirm with the above guidelines.

### Hierarchical Task List Example

There are times when a task list item needs a sub task.

Here is an example illustrating how to extract an invoice from email
- [ ] Check for PDF attachments
- [ ] Parse email body if no attachment
- [ ] Extract key fields
  - [ ] Invoice number
  - [ ] Amount
  - [ ] Due date

> **📝 Note** - this example needs to be replaced with an existing reference to confirm with the above guidelines.

## Document Naming Convention

Here are guidelines for naming work instruction files:

- Case and format:
  - Begin the file name with the most dominant word. 
  - Adjectives should go next.
  - The work instruction type (role, task, tool) should go last.
  - Example: 'invoice-ap-email-to-document-process-task.md'
  - This convention ensures like documents appear next to each other in an alphabetical list.
- use all lower case and '-' instead of spaces. This practice ensures quick and easy processing on all platforms.
- Tool skills that need supporting artifacts use a directory with the same `-tool` suffix (no `.md`) containing a `SKILL.md` file. See [Tool Skill Structures](#tool-skill-structures).
  - Example: `nws-tx-alerts-api-tool/` containing `SKILL.md` and a `scripts/` subdirectory.

## Directory Structure

**Default: prefer flat structure.** Place work instructions directly in their `wi-*` directory with no sub-directories. Here is why:

- You can search for key terms using `ls *some-term*` with no additional complexity or recursive search.
- You can see all documents in one place.
- A directory hierarchy only has one dimension. There are times when a document belongs in two or more places.
- Use tags in your markdown to assign multiple organization strategies to a single file.
- Tags are easy to identify and reason about.

**Exception: tool skills that ship artifacts.** Some tool skills include supporting files (helper scripts, configuration samples, data fixtures) that travel with the skill. In that case, package the skill as a directory using the `-tool` suffix — see [Tool Skill Structures](#tool-skill-structures) for the layout.

**Avoid nested labyrinths.** When a tool skill is packaged as a directory:

- Keep subdirectories one level deep (e.g., `scripts/`, `examples/`). The skill should still feel flat.
- If you find yourself nesting further, reconsider whether the content belongs as a separate skill, in another repository, or as inline documentation.
- Do not introduce subdirectories for tasks, roles, or principles documents — those remain flat in their `wi-*` directory.

## Tags

There are times when you need to need to tag to the bottom of a work instruction as belonging to a group or concept. Use the tagging convention to 'tag' the document with a key term. Here is an example where you can tag a document as belonging to multiple roles.

```md
This is a sample work instruction with a bunch of details.

Tags: #role-ap-clerk #role-ap-manager
```
## Notes Warnings Tips References and Comments

Here is the guide for calling special boxes that draw attention to important information:

```md
> 📝 **Note** - Additional information
> ⚠️ **Warning** - Potential issues
> 💡 **Tip** - Best practices
> 🔗 **Reference** - Links to other instructions
> 💬 **Comment** - Discussion points or feedback
```
