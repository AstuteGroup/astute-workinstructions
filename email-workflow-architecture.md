# Email-Driven Workflow Architecture

**Date:** 2026-05-07. **Status:** Authoritative. **Linked from:** `CLAUDE.md`.

This document defines how every email-driven workflow in this codebase is built. Read this before creating any new workflow that polls an inbox.

---

## Core principle

**Workflow logic lives in a `.md` file. Code provides only deterministic primitives.**

A scheduled remote agent (Claude Code routine via `/schedule`) reads the workflow's `.md` as instructions, calls a small set of CLI primitives to interact with the inbox + downstream systems, and applies judgment on every email.

The agent provides what regex + hardcoded code can't: contextual reading, multi-hop forward chains, novel attachment formats, ambiguous senders, edge cases not yet documented. New conventions added to the `.md` take effect the next tick — no code change required.

## Why this exists

Static cron-driven scripts that parse emails with regex have failed in this codebase repeatedly:

- 2026-05-07: customer-excess offer-poller wrote 18 offers to Astute employee BPs because regex `parseForwardedHeaders` grabbed the first `From:` line on multi-hop chains. Subject convention `Upload MO_NNNNN` was undocumented in the regex.
- 2026-03-XX → 2026-05-XX: stockrfq experimented with `claude -p` from cron, failed continuously, was abandoned and reverted to a static daemon (also fragile).

Every regex assumption that fits today's traffic eventually breaks on tomorrow's email format. The agent pattern handles novelty by *reading* rather than *matching*.

## Architecture

```
[/schedule routine, cadence per workflow]
        │
        ▼
   Claude Code (with Read/Bash/Edit tools)
        │
        │  reads workflows/<name>/<name>.md as instructions
        │  calls 3 commands:
        │
        ├─→ shared/email-workflow-poller.js list --workflow <name>
        │     → JSON of unseen envelopes (uid, subject, from, attachment names)
        │
        ├─→ shared/email-workflow-poller.js read <uid> --workflow <name>
        │     → full email JSON: body, parsed forwarded-message headers,
        │       internal-vs-external sender detection, attachment list
        │
        └─→ shared/email-workflow-poller.js route <uid> <action> --workflow <name> --payload <json|file>
              → executes the routing decision via the workflow's action handler;
                moves the email to the action's target folder
```

The agent is the orchestrator. The CLI is plumbing. The `.md` is the contract.

## Components

### 1. `shared/email-workflow-poller.js` (generic CLI)

Owns: IMAP connection (auth from `WORKMAIL_PASS` env), envelope listing, message reading with forwarded-header parsing, action dispatch, folder management.

**Workflow-agnostic.** Takes `--workflow <name>` and looks up the workflow module from `shared/workflow-actions/<name>.js`. Never imports workflow-specific code directly.

### 2. `shared/workflow-actions/<name>.js` (per-workflow module)

Each email-driven workflow has exactly one of these. Exports:

```javascript
module.exports = {
  inbox: 'someinbox@orangetsunami.com',
  notifierConfig: {
    fromEmail: 'someinbox@orangetsunami.com',
    fromName: 'Some Workflow',
  },
  actions: {
    <action_name>: {
      folder: 'TargetFolder',                      // where to move the email after handler runs
      handler: async (payload, ctx) => { ... },    // null if move-only with no side effects
      requires: ['fieldA', 'fieldB'],              // payload validation; throws if missing
      keepsPending: false,                         // optional: true for need_info-style actions (see Reply stitching below)
    },
    // ... more actions
  },
};
```

**Handler signature:**
```javascript
async function handler(payload, ctx) {
  // payload: parsed JSON from --payload flag
  // ctx: {
  //   uid, dryRun, jakeEmail, notifier, log, workflow, inbox,
  //   anchorMessageId,    // Message-ID of thread anchor — use as sidecar key
  //   currentMessageId,   // Message-ID of the message being routed
  //   currentReferences,  // References + In-Reply-To array
  //   pendingSidecar      // sidecar record if one matched this thread, else null
  // }
  // returns: { result: <anything>, ... }   — merged into the route command's JSON output
}
```

The handler does whatever the action implies — `enqueue` to a queue, `writeOffer` to OT, `sendEmail` to a customer, `breadcrumb` for audit. The poller handles folder moves and JSON output formatting.

### 3. `<workflow folder>/<name>.md` (the agent's instructions)

Plain prose telling the agent how to do the work. Should cover:

- Inbox + cadence
- The 3 CLI commands and their JSON shapes (link to architecture doc)
- The routing-action contract (when to use each, with payload examples)
- Decision logic — how to extract data, how to resolve partners, how to detect duplicates, when to ask vs. proceed
- Error / edge-case handling

The .md is read fresh by the agent every tick. Updates take effect immediately.

### 4. `/schedule` routine (the cadence)

Configured via Claude Code's `/schedule` skill. Runs the agent on a schedule with a prompt like:

```
Process all unseen messages in the rfqloading inbox per
Trading Analysis/RFQ Loading/rfq-loading.md.
```

The routine prompt should be terse — reference the .md, not duplicate it.

## Reply stitching (automatic)

If a workflow ever has to ask the sender for missing details ("what RFQ type is this?", "what's the quantity?"), the customer's reply almost never re-quotes the original parts list — they just answer the question. Without stitching, the agent reading the reply sees the answer but no parts to attach it to, and dead-ends in `needs_review`.

**The poller solves this by default.** Any workflow gets reply-stitching for free.

### How it works

1. **First touch (initial routing).** Agent reads an email, partially extracts but is missing required fields. It routes `need_info` with payload that includes `extracted: { ...whatever_was_parsed }` + `missing: [...]`. The poller writes a sidecar at `~/workspace/.<workflow>-pending/<sanitized-anchor-msg-id>.json` containing the partial extraction + the missing-fields list + `retry_count: 0`. The auto-reply's `Reply-To` is the workflow inbox, so the customer's reply lands back in this inbox.
2. **Customer reply lands.** Next tick, `cmdRead` parses the new message, sees `In-Reply-To` / `References` matching a sidecar, and attaches the sidecar to the returned JSON as `pending_state`.
3. **Agent sees both.** Agent reads the message JSON, finds `pending_state`. Treats `pending_state.extracted` as already-known. Merges with the current reply body. Routes to `enqueue` (or another action) with the FULL merged payload, including `original_message_id: pending_state.original_message_id`.
4. **Auto-cleanup.** Poller clears the sidecar on any terminal action (anything except actions declared `keepsPending: true`).

### What workflows need to do

- **Declare `keepsPending: true`** on the action(s) that exist to ask the sender for more info (the only actions that should keep state alive across ticks).
- **In the `need_info`-style handler**, write the sidecar via `shared/workflow-pending-state.js`:
  ```javascript
  const pending = require('../workflow-pending-state');
  pending.writeSidecar(ctx.workflow, ctx.anchorMessageId, {
    original_uid: ctx.uid,
    original_subject: subject,
    original_recipient: recipient,
    extracted: payload.extracted || {},
    missing: payload.missing || [],
  });
  ```
- **In the agent prompt**, instruct: if `pending_state` is present on a read, merge `pending_state.extracted` with the current body before extracting; cap retries at `pending_state.retry_count >= 2` (escalate to `needs_review` instead of looping); pass `original_message_id: pending_state.original_message_id` on continuations.

### What workflows do NOT need to do

- Lookup, hydration, or cleanup of sidecars — the poller handles all of it transparently.
- Thread-anchor calculation — the poller resolves it via payload → existing sidecar → current Message-ID.
- Workflows without a need_info-style action: nothing changes; sidecar lookup is a no-op (nothing to find).

### Reference

- Helper: `shared/workflow-pending-state.js` (write / read / findByReferences / clear / listSidecars)
- Reference implementation: `shared/workflow-actions/rfq-loading.js` `action_need_info` + the stitch-merge block in `Trading Analysis/RFQ Loading/agent-prompt.txt`

---

## How to add a new email-driven workflow

1. **Create `shared/workflow-actions/<name>.js`** — start by copying `_template.js` (TODO: create one). Define inbox, notifier config, and routing actions with handlers.
2. **Create `<area>/<name>/<name>.md`** — describe the workflow. Reference this architecture doc for the CLI contract.
3. **Set up IMAP folders** in the inbox: `Processed`, plus whatever the workflow needs (`NeedsReview`, `NeedInfo`, `NotRFQ`, etc.).
4. **Create a `/schedule` routine** pointing at the workflow doc.
5. **Test on-demand first:** `node shared/email-workflow-poller.js list --workflow <name>` and run a few `route` calls by hand before letting the routine fire.

That's the entire flow. No new poller code, no new cron entries, no static scripts.

## What this pattern is NOT

- **Not for cron-triggered enrichment** that doesn't read email — e.g., `mfr-reconciler` scanning DB rows nightly. Static node scripts are fine for those (no email = no judgment-heavy parsing).
- **Not for purely deterministic file-driven workflows** — e.g., `inventory-cleanup` parsing a known-format Infor xlsx. If the format is stable and contractual, a static parser is appropriate.
- **Not for ad-hoc one-shot scripts** — `oneoffs/` continues to be the home for one-time corrections.

If the workflow involves "read an email and decide what to do with it," it belongs in this pattern. If it's "transform a known input into a known output," it can stay static.

## Migration status

| Workflow | Inbox | Pattern | Status |
|---|---|---|---|
| RFQ Loading (general) | rfqloading@ | Agent (`/schedule`) | Live, working |
| Customer Excess | excess@ | Agent module built | **Phase 1 done 2026-05-08** — `shared/workflow-actions/excess.js` + agent operating instructions in workflow .md. Awaiting `/schedule` cutover + static-pipeline deletion. |
| Stock RFQ Loading | stockRFQ@ | Agent module built | **Phase 1 done 2026-05-08** — `shared/workflow-actions/stockrfq.js` + agent operating instructions in workflow .md. Awaiting `/schedule` cutover + static-daemon deletion. |
| VQ Loading | vq@ | Static cron | **Migration target** |
| Vortex Matches | vortex@ | Static cron | **Stays static — exception documented below** |

After migration is complete, the static-cron versions of email-driven workflows are **deleted**, not deprecated. The only path that remains is the agent pattern.

### Documented exception: Vortex Matches

Vortex stays on a static poller. **Why:** Vortex is inbox-driven *request/response* — operator forwards an RFQ to `vortex@`, expects an enriched matches reply within a minute. `/schedule` minimum cadence (every 5–30 min) makes the worst-case round-trip 30 min, which fails the operational expectation. The static poller's near-instant turnaround is load-bearing for how it's used.

**Revisit triggers:** if `/schedule` gains sub-minute or event-driven cadence, OR if Vortex's parsing logic gets hit by the same novel-format failures that took out customer-excess on 2026-05-07, migrate.

The exception is itself in the workflow's .md so anyone touching Vortex sees it; it's not buried here.

## What NOT to do

- ❌ Add a cron entry that invokes `claude -p` directly. (See Stock RFQ Loading's March 2026 experiment — it failed continuously.)
- ❌ Add a cron entry that runs a static node script polling an inbox. (See excess-poller — current pattern, current bug source.)
- ❌ Add workflow-specific email parsing helpers in `shared/`. (Helpers go on the workflow's actions module or in `shared/email-workflow-poller.js` if they're truly generic.)
- ❌ Mix the patterns — don't put part of an email-workflow in agent code and part in a static script.

## Reference

- **First implementation:** `Trading Analysis/RFQ Loading/rfq-loading-poller.js` (legacy single-file poller; superseded by generalized `shared/email-workflow-poller.js`)
- **Generalized poller:** `shared/email-workflow-poller.js`
- **Workflow modules:** `shared/workflow-actions/`
- **Workflow docs:** `<area>/<name>/<name>.md` (e.g., `Trading Analysis/RFQ Loading/rfq-loading.md`)
- **Claude Code routine setup:** `/schedule` skill — configures the scheduled remote agent
