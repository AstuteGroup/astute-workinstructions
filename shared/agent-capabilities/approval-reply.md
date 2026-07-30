# Large Document Approval Reply Capability
#
# Include this capability for workflows that gate large documents
# (>N lines) with operator approval emails.

**Check subject line.** If subject matches `RE: [APPROVAL NEEDED] {{APPROVAL_DOC_TYPE}} <{{APPROVAL_ID_FIELD}}>` (any case):
* Extract `<{{APPROVAL_ID_FIELD}}>` from the subject ({{APPROVAL_ID_EXTRACTION_HINT}}).
* Read the first non-quoted line of the body. Match (case-insensitive):
    - `yes` / `y` / `approve` / `go` / `proceed` → `{{APPROVAL_APPROVE_ACTION}}` with `{{{APPROVAL_ID_JSON_FIELD}}: "<{{APPROVAL_ID_FIELD}}>"}`.
{{#if APPROVAL_MAX_LINES_SUPPORT}}
    - `yes --max-lines 1000` / `limit 1000` / `cap 1000` → `{{APPROVAL_APPROVE_ACTION}}` with `{{{APPROVAL_ID_JSON_FIELD}}: "<{{APPROVAL_ID_FIELD}}>", max_lines: 1000}`.
{{/if}}
{{#if APPROVAL_CACHE_ONLY_SUPPORT}}
    - `yes --cache-only` / `cache only` / `cache-only` → `{{APPROVAL_APPROVE_ACTION}}` with `{{{APPROVAL_ID_JSON_FIELD}}: "<{{APPROVAL_ID_FIELD}}>", cache_only: true}` — runs enrichment off cached envelopes only, NO live API spend.
    - Combinable, e.g. `yes --cache-only --max-lines 1000` → `{{{APPROVAL_ID_JSON_FIELD}}: "<{{APPROVAL_ID_FIELD}}>", cache_only: true, max_lines: 1000}`.
{{/if}}
    - `no` / `n` / `reject` / `skip`{{#if APPROVAL_DECLINE_EXTRA}} / `{{APPROVAL_DECLINE_EXTRA}}`{{/if}} → `{{APPROVAL_REJECT_ACTION}}` with `{{{APPROVAL_ID_JSON_FIELD}}: "<{{APPROVAL_ID_FIELD}}>", reason: <any trailing text>}`.
    - Unclear / ambiguous → `needs_review` with `{reason: "approval reply directive unclear: <body excerpt>"}`.
* Dispatch with `route <uid> <action> --workflow {{WORKFLOW_KEY}} --payload '<json>'`. Approval/rejection emails do NOT need {{APPROVAL_SKIP_FIELDS}}.
{{#if APPROVAL_SKIP_REMAINING}}
* Skip the remaining steps for this UID.
{{/if}}
