# Pending State / Reply Stitching Capability
#
# Include this capability for workflows that support multi-round conversations
# via sidecar state (clarify_partner, need_info, etc.)

**Check for `pending_state` FIRST.** If the `read` JSON includes a `pending_state` object, this message is a reply to a prior {{PENDING_STATE_ACTIONS}} ask sent to {{PENDING_STATE_RECIPIENT}}. Treat it as a thread continuation:

* **Reply-directive check (run before merge).** Call `parseSidecarReplyDirective` on the reply body:
  `node -e "const g=require('/home/analytics_user/workspace/astute-workinstructions/shared/workflow-reply-grammars'); console.log(JSON.stringify(g.parseSidecarReplyDirective(\`<body text>\`)))"`
  - `directive: 'DROP'` (operator typed SKIP / DROP / IGNORE / DISCARD{{#if PENDING_DROP_EXTRA_WORDS}} / {{PENDING_DROP_EXTRA_WORDS}}{{/if}} on the first non-quoted line) → route `drop_pending` with `{reason: "Operator dropped{{#if PENDING_DROP_SUFFIX}} {{PENDING_DROP_SUFFIX}}{{/if}}: <matchedWord>", original_message_id: pending_state.original_message_id}`. The poller clears the sidecar. STOP — do not merge.
  - `directive: 'MERGE'` → continue with the merge logic below.

{{PENDING_STATE_MERGE_LOGIC}}

* **Retry cap:** If `pending_state.retry_count >= 2`, route `{{PENDING_RETRY_CAP_ACTION}}` with reason "{{PENDING_RETRY_CAP_REASON}}" — don't loop forever.
* Pass `original_message_id: pending_state.original_message_id` on the continuation route so the poller can clear the right sidecar.
