# RFQ Loading - STEP 3: Per-message decision tree
#
# This file contains the workflow-specific decision logic for RFQ Loading.
# It is composed into the final agent-prompt.txt by generate-agent-prompts.js

For every UID returned, follow the per-message decision tree from the .md:
  - Run `read <uid> --workflow rfq-loading` to fetch body + parsed forwarded headers.
  - **Check for `pending_state` FIRST.** If the `read` JSON includes a `pending_state` object, this message is a reply to a prior `need_info` ask sent to Jake. Treat it as a thread continuation:
      * **Reply-directive check (run before merge).** Call `parseSidecarReplyDirective` on the reply body:
        `node -e "const g=require('/home/analytics_user/workspace/astute-workinstructions/shared/workflow-reply-grammars'); console.log(JSON.stringify(g.parseSidecarReplyDirective(\`<body text>\`)))"`
        - `directive: 'DROP'` (operator typed SKIP / DROP / IGNORE / DISCARD on the first non-quoted line) → route `drop_pending` with `{reason: "Operator dropped: <matchedWord>", original_message_id: pending_state.original_message_id}`. The poller clears the sidecar. STOP — do not merge.
        - `directive: 'MERGE'` → continue with the merge logic below.
      * Jake's reply (or a customer reply he forwarded back) supplies the missing fields (qty, RFQ type, contact, etc.); it does NOT re-quote the original parts list. The parts list lives in `pending_state.extracted` from when we first parsed the original.
      * Build the merged extraction by combining `pending_state.extracted` with whatever new fields the current reply body answers (the items in `pending_state.missing`).
      * Decide routing:
          - If merging produces a complete, loadable RFQ → `enqueue` with the FULL merged payload (lines from pending_state, plus the qty/type/etc. from this reply). ALSO pass `original_message_id: pending_state.original_message_id` so the poller can clean up the sidecar.
          - If still incomplete AND `pending_state.retry_count < 2` → another `need_info` with the updated `extracted` (whatever fields you now have) + the still-`missing` list + `original_message_id: pending_state.original_message_id`. The sidecar is keyed on the anchor and retry_count auto-bumps.
          - If still incomplete AND `pending_state.retry_count >= 2` → `needs_review` (do NOT loop a third time). Pass `original_message_id: pending_state.original_message_id` so the sidecar is cleared.
      * Approval/rejection reply messages (`RE: [APPROVAL NEEDED] Large RFQ <N>`) take precedence over this — see the next bullet — even if `pending_state` is somehow present.
  - **Check subject line.** If subject matches `RE: [APPROVAL NEEDED] Large RFQ <RFQ#>`:
      * Extract `<RFQ#>` from the subject (regex: `Large RFQ\s+(\d+)`).
      * Read the first non-empty, non-quoted line of the body. Ignore quoted-original markers, signature blocks, legal disclaimers.
      * Classify the directive:
          - `yes` / `y` / `approve` / `go` / `proceed` → `approve_large_rfq` with `{rfq_number: <N>}`.
          - `yes --max-lines 1000` / `limit 1000` / `cap 1000` → `approve_large_rfq` with `{rfq_number: <N>, max_lines: 1000}`.
          - `yes --cache-only` / `cache only` / `cache-only` → `approve_large_rfq` with `{rfq_number: <N>, cache_only: true}` — runs enrichment off cached envelopes only, NO live API spend.
          - Combinable, e.g. `yes --cache-only --max-lines 1000` → `{rfq_number: <N>, cache_only: true, max_lines: 1000}`.
          - `no` / `n` / `reject` / `skip` / `decline` → `reject_large_rfq` with `{rfq_number: <N>, reason: <any trailing text>}`.
          - Unclear / ambiguous → `needs_review` with `{reason: "approval reply directive unclear: <body excerpt>"}`.
      * Dispatch with `route <uid> <action> --workflow rfq-loading --payload '<json>'`. Approval/rejection emails do NOT need customer/contact/MFR resolution.
  - Otherwise (no `pending_state`, subject is NOT an approval reply): apply the normal customer-RFQ flow per the .md (Steps 4-9), routing to enqueue / need_info / needs_review / not_rfq.
      * **ATTACHMENTS (XLSX, CSV, PDF, images):** The `read` JSON includes `documents` and `images` arrays. If any attachment exists, OR the body text is sparse (< 50 chars of actual content after stripping signatures), the RFQ data is likely in an attachment:
          1. Run: `node /home/analytics_user/workspace/astute-workinstructions/shared/email-workflow-poller.js download-attachments <uid> --workflow rfq-loading --include-images`
          2. Parse each attachment by type:
             - **XLSX/CSV:** Use the Read tool or parse with node:
               ```javascript
               node -e "const XLSX=require('xlsx'); const wb=XLSX.readFile('/path/to/file.xlsx'); const data=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]); console.log(JSON.stringify(data,null,2));"
               ```
               Look for columns: MPN/Part Number, Qty/Quantity, Mfr/Manufacturer, Description, CPC/Customer Part
             - **PDF:** Use the Read tool — Claude can extract text from PDFs
             - **Images (PNG/JPG):** Use the Read tool — Claude has vision
          3. Extract MPN, qty, customer info from the parsed data just as you would from text
          4. Proceed with the normal flow using the extracted data
      * When routing to `need_info` on an INITIAL message (first round, no prior sidecar), include `{missing: [...], subject, outerFrom: <external_sender_email>, extracted: {lines, bpartnerId-guess, ...whatever you parsed}}`. The handler emails Jake (NOT the external customer — POLICY 2026-05-14, info-requests never go to the external sender) and writes the sidecar. Jake's reply round-trips when he answers.
