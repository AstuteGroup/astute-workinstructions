# Master Roadmap

High-level view of all initiatives and projects. Each major area links to its detailed roadmap.

---

## Active Roadmaps

| Area | Roadmap | Status |
|------|---------|--------|
| **Sourcing Automation** | [sourcing-roadmap.md](Trading Analysis/RFQ Sourcing/sourcing-roadmap.md) | Active |

---

## Initiatives

### Now
- [ ] **Sourcing Automation** — Supplier deduplication, no-bid filtering, VQ parsing improvements ([details](Trading Analysis/RFQ Sourcing/sourcing-roadmap.md))
- [ ] **PPV Analysis (Vortex Rebuild)** — Purchase price variance analysis tooling
- [ ] **RFQ Loading through AI** — AI-assisted extraction and loading of RFQs from customer emails/documents ([workflow](Trading Analysis/RFQ Loading/rfq-loading.md), [support workflows](Trading Analysis/trading-analysis-roadmap.md#section-f-rfq-loading-support-workflows))

### Next
- *(add initiatives here)*

### Later
- [ ] **Repo restructure: separate role-agnostic infrastructure from role-specific workflows** — Today, everything lives under `Trading Analysis/` because the buyer/trading-analyst role has been the only consumer. But a lot of what's been built is **infrastructure that any future role would use**: the `shared/` cog layer (franchise-api, mfr-resolver, packaging-lookup, vq-writer, rfq-writer, offer-writeback, cq-writer, api-result-writer, payload-builder when shipped, csv-utils, partner-lookup, etc.), the iDempiere REST writeback path (`api-client`, `api-writeback.md`), the data model doc (`shared/data-model.md`), the cron infrastructure (`enrich-poller`, `vortex-poller`, `api-queue worker`), the email-driven automation pattern (vortex-poller, vq-parser), and the shared cache / pricing envelope storage (`shared/data/api-pricing-cache/`).
  - **Symptom this surfaces today:** when documenting cogs and reference material, we file them under `Trading Analysis/` even when they're not trading-specific. New roles (sales engineering, quality, finance, ops) joining later would either (a) not discover the existing infrastructure, or (b) reach into Trading Analysis paths and create cross-coupling that's hard to untangle.
  - **Direction (not a fixed plan):** lift role-agnostic infrastructure to top-level locations like `infrastructure/`, `platform/`, or keep `shared/` and grow it. Move role-specific workflows under `roles/<role>/` (e.g. `roles/trading-analyst/RFQ Sourcing/`, `roles/quality/...`, `roles/finance/...`). Workflow docs reference shared cogs by stable paths so the migration doesn't break consumer code.
  - **Why "Later":** no second role exists today to motivate the move, and the boundary will be clearer once a second role's first workflow is being scoped — that's the natural moment to do the lift, because we'll be able to see which utilities are *actually* shared vs. only-trading-analyst-shaped. Premature reorganization would invent abstractions for hypothetical needs.
  - **Trigger to act:** any of (1) a second role's first workflow gets scoped, (2) we catch ourselves filing a clearly cross-role utility under `Trading Analysis/` and feeling the friction, (3) external compliance / audit asks who-can-touch-what and the answer requires a structural answer.
  - **Pre-work that's safe to do anytime:** as new shared cogs get built (e.g. C16 payload-builder), file them under `shared/` from day one — never under a workflow folder. The current pattern already does this; just keep enforcing it.
  - **First step when triggered:** audit `shared/` and `scripts/` and tag each file as role-agnostic or role-specific. The role-agnostic set is what eventually moves up. Most current `shared/` files are already role-agnostic by intent — the audit confirms or surfaces exceptions.

### Backlog
- *(add initiatives here)*

---

## How to Use This Roadmap

1. **Master Roadmap** (this file) — High-level view of all initiatives
2. **Area Roadmaps** — Detailed task-level planning for each domain (e.g., `sourcing-roadmap.md`)
3. **Workflow Docs** — Step-by-step operational guides (e.g., `rfq-sourcing-netcomponents.md`)

When adding a new major initiative:
1. Add it to the appropriate priority tier above
2. If it needs detailed planning, create a `<area>-roadmap.md` file
3. Link to it from the Active Roadmaps table

---

*Last updated: 2026-04-08*
