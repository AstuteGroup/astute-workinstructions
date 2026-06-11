# Session Greeting Procedure

**TRIGGER:** When you see `SessionStart:startup hook success` in a system-reminder, IMMEDIATELY display the greeting below — do not wait for user input. This allows the user to jump straight into their task.

At the start of every new conversation, before addressing anything else, always display the following:

---

## 1. Recent Work

Check the `## Recent Sessions` section in MEMORY.md. Display the 2-4 most recent entries so the user can quickly pick up where they left off. Format as:

> **Recent Work (pick up where you left off):**
> - [list from MEMORY.md Recent Sessions, most recent first]

---

## 2. Available Workflows

Display the workflow catalog. See `docs/workflow-catalog.md` for the full list with descriptions.

> **Available Workflows:** (26 workflows — see `docs/workflow-catalog.md` for details)

Then list the workflow names with their doc paths.

---

## 3. Roadmaps

> **Roadmaps:**
> - `api-integration-roadmap.md` — External APIs (franchise distributors, LLM, future integrations)
> - `Trading Analysis/RFQ Sourcing/sourcing-roadmap.md` — RFQ Sourcing & VQ Processing
> - `Trading Analysis/trading-analysis-roadmap.md` — Vortex Matches, Quick Quote, etc.

---

## 4. Periodic Checks (every 8 days)

> **Template Candidates:** Check `Trading Analysis/RFQ Sourcing/vq_loading/template-candidates.md`
> - Any vendors with 5+ cumulative quotes? → Review for templateability
> - Show top 3 candidates and their counts
> - Check if structured (table/consistent format) vs free-form (prose) → only structured can be templated

---

## 5. Deferred Work

Read `~/workspace/deferred-work.md` and surface any **open** items (skip the `## Done` section). Display them in a single block, sorted with 🟢 ready items first, then 🟡 future-dated, then ⏸️ event-driven, then 🅿️ parked. For each item show only the title + the "Ready when" hint — operator can drill into the file for details. Format:

> **Deferred Work (active backlog):**
> - 🟢/🟡/⏸️/🅿️ **{title}** — *ready: {when}*
> - ...

If `deferred-work.md` doesn't exist or has no open items, skip this section silently.

---

## 6. Cron Pause Check

Check if `~/workspace/.cron-paused` or `~/workspace/.cron-agents-paused` exists.

### If `.cron-paused` exists (everything paused)

Use AskUserQuestion to prompt:

```
Question: "Background jobs are paused to save your token budget. Want to turn them back on?"
Header: "Crons"
Options:
  - "Keep paused" / "I have manual work to do — keep the budget for this session"
  - "Resume utilities only" / "Turn on cheap background jobs (vortex, mfr-reconciler, etc.) but keep Claude agents off"
  - "Resume everything" / "Turn on all background jobs including the 5 Claude agents"
```

Based on answer:
- **Keep paused:** Do nothing, continue session
- **Resume utilities only:** Run `rm ~/workspace/.cron-paused` then `touch ~/workspace/.cron-agents-paused`, confirm "Utilities will start running. Agents stay off."
- **Resume everything:** Run `rm ~/workspace/.cron-paused` and `rm ~/workspace/.cron-agents-paused` (if exists), confirm "All background jobs resuming. Emails from the last 2 days will process over the next few hours."

### If only `.cron-agents-paused` exists (utilities running, agents paused)

Use AskUserQuestion:

```
Question: "The 5 Claude agents are paused but utility jobs are running. Want to turn the agents back on?"
Header: "Agents"
Options:
  - "Keep agents off" / "Save tokens for manual work"
  - "Resume agents" / "Turn on excess, stockrfq, rfqloading, vq-loading agents"
```

Based on answer:
- **Keep agents off:** Do nothing
- **Resume agents:** Run `rm ~/workspace/.cron-agents-paused`, confirm "Agents resuming. Queued emails will process shortly."

### If neither file exists

Skip this section silently (crons running normally).

---

## 7. Cron Drift Check

Run `node ~/workspace/astute-workinstructions/scripts/check-cron-drift.js`. If it reports anything other than `✓ OK`, surface the issues at the top of the greeting under **Cron drift detected:** so the operator sees them before starting work. If clean, do not mention it.

The drift check covers:
- Raw cron lines bypassing cron-runner
- Registry entries missing from crontab
- Orphan sentinels
- Jobs gone stale (>2× cadence since last success)

---

## 8. Workflow Parity Check

Run `node ~/workspace/astute-workinstructions/scripts/check-workflow-parity.js --quiet`. If it exits non-zero (drift between `shared/workflow-registry.js` and the actual handler/cron code), surface the output at the top of the greeting under **Workflow drift detected:** — this means a recent change to one email-driven workflow wasn't propagated.

If exit 0 (no drift, possibly some declared gaps), do not mention it.

Full report any time via `node ~/workspace/astute-workinstructions/scripts/check-workflow-parity.js` (no `--quiet`) — shows the gap list too. See `email-workflow-architecture.md` § Parity enforcement for the contract.

---

## Bucket A Note

Rate-limited API retries live separately in `~/workspace/.deferred-api-queue.json` and run via the worker `~/workspace/scripts/process-api-queue.js` on cron (`*/30 * * * *`, installed 2026-04-08).

On exhausted items the worker emails the operator (`jake.harris@Astutegroup.com` by default, override via `OPERATOR_EMAIL` env var). On successful retries the worker cascades — other pending items with the same `kind` get fast-tracked.

The greeting should NOT surface Bucket A items routinely — they run autonomously. Only mention Bucket A in the greeting if:
- `crontab -l` is missing the entry
- The cron log shows recent failures
- The queue has growing `exhausted` items that the operator hasn't been emailed about (e.g., notifier was broken)
