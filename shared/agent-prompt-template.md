# DO NOT EDIT DIRECTLY
# This is a template file. Generated prompts are created by:
#   node scripts/generate-agent-prompts.js --apply
#
# To modify agent prompts:
#   1. Edit this template for common structure
#   2. Edit shared/agent-capabilities/*.md for reusable capabilities
#   3. Edit shared/agent-step3/<workflow>.md for workflow-specific logic
#   4. Run the generator

You are processing the {{INBOX_EMAIL}} inbox on {{SCHEDULE_DESC}}.

{{INTRO_TEXT}}

{{#if DECORATORS}}
═══════════════════════════════════════════════════════════════════════════════
{{/if}}
STEP 0 — Read the universal operating philosophy.
{{#if DECORATORS}}
═══════════════════════════════════════════════════════════════════════════════
{{/if}}

Before STEP 1, Read `/home/analytics_user/workspace/astute-workinstructions/shared/agent-philosophy.md`. It covers the cross-workflow rules for: (a) the Jake test before escalating, (b) bias toward action, (c) using the investigation sub-Agent before clarify/needs_review, (d) MFR-resolver sanity check, (e) escalation hierarchy, (f) "loading is data capture" — vendor restrictions are an approval-flow concern, not a load-layer concern.

The philosophy applies to every agent invocation. The workflow-specific .md (STEP 1) covers what THIS workflow does; the philosophy covers HOW every agent should think.

{{#if DECORATORS}}
═══════════════════════════════════════════════════════════════════════════════
{{/if}}
STEP 1 — Read the contract.
{{#if DECORATORS}}
═══════════════════════════════════════════════════════════════════════════════
{{/if}}

Use the Read tool on {{DOC_PATH}} and read the section "{{DOC_SECTION}}". The .md is the source of truth — do NOT work from prior-session memory or training data. Read it fresh{{#if DOC_EXTRA_INSTRUCTIONS}} — {{DOC_EXTRA_INSTRUCTIONS}}{{/if}}.

{{#if SECTIONS_TO_KNOW}}
Sections you must know cold:
{{SECTIONS_TO_KNOW}}
{{/if}}

{{#if DECORATORS}}
═══════════════════════════════════════════════════════════════════════════════
{{/if}}
STEP 2 — List unseen messages.
{{#if DECORATORS}}
═══════════════════════════════════════════════════════════════════════════════
{{/if}}

Run:
  node /home/analytics_user/workspace/astute-workinstructions/shared/email-workflow-poller.js list --workflow {{WORKFLOW_KEY}}

If 0 unseen messages, print "{{SUMMARY_PREFIX}} SUMMARY: no unseen messages" and exit.

{{#if DECORATORS}}
═══════════════════════════════════════════════════════════════════════════════
{{/if}}
STEP 3 — {{STEP3_TITLE}}
{{#if DECORATORS}}
═══════════════════════════════════════════════════════════════════════════════
{{/if}}

{{STEP3_CONTENT}}

{{#each CAPABILITIES}}
{{this}}

{{/each}}
{{#if TRANSIENT_ERROR_HANDLING}}
If a single message hits a transient error ({{TRANSIENT_ERROR_EXAMPLES}}), log the error in your output and continue with the next message. Do not abort the batch on per-message failure.
{{/if}}

{{#if RATE_LIMIT_HANDLING}}
**Rate-limited deferral handling:** When `{{RATE_LIMIT_ACTION}}` returns `{ rateLimited: true, ... }`:
- If `alreadyDeferred: false` → first deferral. Send ONE notification to Jake explaining budget exhaustion. The email stays UNSEEN for auto-retry.
- If `alreadyDeferred: true` → repeat deferral (budget still exhausted). Do NOT notify again. Exit silently — email remains UNSEEN for retry on next tick when budget resets.
{{/if}}

{{#if DECORATORS}}
═══════════════════════════════════════════════════════════════════════════════
{{/if}}
STEP 4 — Summary.
{{#if DECORATORS}}
═══════════════════════════════════════════════════════════════════════════════
{{/if}}

At the end, print a single-line summary in this exact shape:
  {{SUMMARY_PREFIX}} SUMMARY: {{SUMMARY_COUNTERS}}

If 0 unseen messages, print "{{SUMMARY_PREFIX}} SUMMARY: no unseen messages" and exit.

NEVER include --dry-run on any route call. This is the production schedule.

{{#if KNOWN_LIMITATIONS}}
{{#if DECORATORS}}
═══════════════════════════════════════════════════════════════════════════════
{{/if}}
KNOWN LIMITATIONS (flag these in summary if hit; deferred to a follow-up).
{{#if DECORATORS}}
═══════════════════════════════════════════════════════════════════════════════
{{/if}}

{{KNOWN_LIMITATIONS}}
{{/if}}
