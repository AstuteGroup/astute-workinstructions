# Customer Excess Analysis - STEP 3: Per-message decision tree
#
# This file contains the workflow-specific decision logic for Customer Excess.

For every UID returned, follow the per-message decision tree:
  - Run `read <uid> --workflow excess` to fetch body + parsed forwarded headers + external_sender.

  - **Check for `pending_state` FIRST.** If the `read` JSON includes a `pending_state` object, this message is a reply to a prior `clarify_partner` / `needs_partner` ask sent to Jake. Treat it as a thread continuation:
      * **Reply-directive check (run before merge).** Call `parseSidecarReplyDirective` on the reply body:
        `node -e "const g=require('/home/analytics_user/workspace/astute-workinstructions/shared/workflow-reply-grammars'); console.log(JSON.stringify(g.parseSidecarReplyDirective(\`<body text>\`)))"`
        - `directive: 'DROP'` (operator typed SKIP / DROP / IGNORE / DISCARD on the first non-quoted line) → route `drop_pending` with `{reason: "Operator dropped: <matchedWord>", original_message_id: pending_state.original_message_id}`. The poller clears the sidecar. STOP — do not merge.
        - `directive: 'MERGE'` → continue with the merge logic below.
      * `pending_state.extracted` carries the partial extraction from the original offer email (lines, offerType, partnerName guess, etc.). Jake's reply body supplies the company identification — usually one line of prose ("Customer is Liyijing Electronics") or the structured `PARTNER: <uid> = <BP|name>` directive. The reply does NOT re-quote the parts list.
      * Build the merged extraction by combining `pending_state.extracted` with the partner identification parsed from Jake's reply body. Re-run partner-lookup on the company string he provided.
      * If partner now resolves AND retry_count < 2:
          - Route `load_offer` with the FULL merged payload (lines from pending_state, bpartnerId from the fresh partner-lookup, offerType from pending_state). The poller auto-clears the sidecar on the terminal action.
      * If partner STILL doesn't resolve AND pending_state.retry_count < 2:
          - Re-route `clarify_partner` with a refined hints message (retry_count auto-bumps). The ask still goes to Jake.
      * If `pending_state.retry_count >= 2`:
          - Stop the round-trip. Route `needs_partner` with `{subject, outerFrom, hints: "clarify_partner round-tripped 2x; operator replies haven't resolved the partner — manual triage needed"}` for manual triage.
      * Approval reply messages (subject `RE: [APPROVAL NEEDED] Large Offer <N>`) take precedence over this — see the next bullet — even if `pending_state` is somehow present.

  - **Check subject line.** If subject matches `RE: [APPROVAL NEEDED] Large Offer <searchKey>` (any case):
      * Extract `<searchKey>` from the subject (the token right after "Large Offer ").
      * Read the first non-quoted line of the body. Match (case-insensitive):
          - `yes` / `y` / `approve` / `go` / `proceed` → `approve_large_offer` with `{offer_search_key: "<searchKey>"}`.
          - `yes --max-lines 1000` / `limit 1000` / `cap 1000` → `approve_large_offer` with `{offer_search_key: "<searchKey>", max_lines: 1000}`.
          - `no` / `n` / `reject` / `skip` → `reject_large_offer` with `{offer_search_key: "<searchKey>", reason: <body excerpt or null>}`.
          - Unclear / ambiguous → `needs_review` with `{reason: "approval reply directive unclear: <body excerpt>"}`.
      * Dispatch with `route <uid> <action> --workflow excess --payload '<json>'`. Approval/rejection emails do NOT need partner resolution or line extraction.
      * Skip the remaining steps for this UID.

  - Otherwise (no pending_state, not an approval reply — normal offer flow):
      * If has_attachment is true, run `download-attachments <uid> --workflow excess` and Read the xlsx/csv/pdf attachments. Prefer xlsx > csv > pdf.
      * **SKIP inventory emails entirely:** If subject matches `Task finished: [success] * AST Item Lots Report`, do NOT process this message — skip to the next UID. Leave it unseen in INBOX for the `inventory-fetch-and-parse` workflow.
      * Apply junk filter (Upload MO_*, OOO, bounces, signature-only) → not_offer.
      * Apply partner resolution (subject hint > body hint > forward chain > external sender), excluding IsEmployee BPs.
      * Extract lines from attachment + body. Filter URL-fragment "MPNs".

      **IMAGE ATTACHMENTS (screenshot excess lists):**

      The `read` JSON includes an `images` array. If:
      - Any image has `isLikelyContent: true` (≥20KB, not inline signature), OR
      - Body text is sparse (<50 chars of actual content after stripping signatures)

      Then the excess data may be in an image:

      1. Run: `node /home/analytics_user/workspace/astute-workinstructions/shared/email-workflow-poller.js download-attachments <uid> --workflow excess --include-images`
      2. Use the **Read tool** on each downloaded image path (Claude has vision — you CAN read PNG/JPG files)
      3. Extract MPN, qty, price, MFR, date code from the image just as you would from text
      4. Proceed with the normal routing flow using the extracted data

      * Determine offer type (default Customer Excess 1000000; flip to Broker Stock Offer 1000001 if BP is vendor-only).
      * **Partner-resolution branching (info-requests ALWAYS go to Jake — POLICY 2026-05-14):**
          - Partner resolves → continue to dedup check.
          - Partner does NOT resolve AND lines were extracted AND no `pending_state` exists → route `clarify_partner` with `{subject: <original_subject>, outerFrom: <external_sender_email>, extracted: {lines, offerType, ...everything_else}, hints: "<short description of what was tried>"}`. The handler emails Jake (NOT the external sender), writes a sidecar, and the reply round-trips when Jake answers.
          - Partner does NOT resolve AND lines were NOT extracted (signature-only / unparseable body) → route `needs_partner` (operator triage, no stitching).
      * Run cross-forward dedup SQL check (BP + offer_type + line count + first/last MPN within 6h) → dup_skip if matched.
      * Dispatch with `route <uid> <action> --workflow excess --payload '<json>'` — no --dry-run.
      * The handler will gate analysis-dispatch for offers above LARGE_OFFER_THRESHOLD (default 500 lines) on the customer-excess-analysis route. The offer is written to OT regardless; an approval email is sent to the operator from excess@. You don't do anything special — just route to load_offer as normal. The reply will land in this inbox next tick as the `RE: [APPROVAL NEEDED]` path above.
