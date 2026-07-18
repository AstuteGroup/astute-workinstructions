# Deferred Work — Active Backlog

Things that came up but aren't urgent enough to do right now. Operator reviews at session start, picks what to action this week.

## How this file works

- **Bucket B** items live here (human-driven, "should we do this" decisions)
- **Bucket A** items (rate-limited API retries — same call, blocked on rate limit / quota) live in `~/workspace/.deferred-api-queue.json`. Run via `node ~/workspace/scripts/process-api-queue.js` on cron (`*/30 * * * *`, installed 2026-04-08). On exhausted items the worker emails the operator. On successful retries it cascades — other pending items with the same `kind` get fast-tracked. Verify cron is installed with `crontab -l`. The earlier docstring claim that "cron is blocked by rbash" was wrong; cron works fine here, as evidenced by the existing vortex-poller, lam-kitting-runner, and inventory-cleanup cron jobs in the same crontab.
- **Long-term roadmap items** live in the `*-roadmap.md` files under `astute-workinstructions/` — those are the deeper backlog. Items move between this file and the roadmap as urgency changes.

**Format per item:**
- One markdown checklist entry
- Status emoji prefix: 🟢 ready / 🟡 future-dated / ⏸️ event-driven / 🅿️ parked
- **Why blocked:** the reason it's not happening right now
- **Ready when:** date / event / "whenever" — when it becomes actionable
- **How:** the concrete action when ready
- **Created / source:** date + which session/workstream surfaced it

Mark done by checking the box and moving the item to the "Done (recent)" section. Periodically prune the done section.

The SessionStart greeting reads this file and surfaces all open items, sorted by readiness.

---

## Open

### Active workstreams (next session pickup)

- [ ] 🟢 **RESUME: Broker Stock Offer Duplicate MPN Cleanup** *(opened 2026-07-10)*
  - **Context:** iDempiere bean callout on `chuboe_offer_line` auto-creates `chuboe_offer_line_mpn` sub-records. Our `offer-writeback.js` was ALSO writing them (when `writeMpnRecords: true`), causing duplicates. Discovered 2026-07-07.
  - **Scope:** 3 offer types had duplicates (past 9 months):
    - ~~Customer Excess: 112,414~~ ✅ DONE (118,718 deactivated)
    - ~~Franchise Stock Offers: 112,743~~ ✅ DONE (113,117 deactivated)
    - **Broker Stock Offer: 639,522** ← IN PROGRESS
  - **Progress:** Check with: `node -e "const {psqlQuery}=require('/home/analytics_user/workspace/astute-workinstructions/shared/db-helpers'); console.log(psqlQuery('SELECT COUNT(*) FROM chuboe_offer_line_mpn WHERE isactive = \\\'N\\\' AND created >= NOW() - INTERVAL \\\'9 months\\\'')); "`
  - **Why resumable:** Script accepts `--offset=N` to skip already-processed records.
  - **Ready when:** Every session until complete.
  - **How to resume:**
    1. Get current deactivated count for Broker Stock Offer:
       ```bash
       node -e "const {Pool}=require('pg'); const p=new Pool({host:'/var/run/postgresql',database:'idempiere_replica'}); p.query(\"SELECT COUNT(*) FROM chuboe_offer_line_mpn olm JOIN chuboe_offer_line ol ON olm.chuboe_offer_line_id=ol.chuboe_offer_line_id JOIN chuboe_offer o ON ol.chuboe_offer_id=o.chuboe_offer_id JOIN chuboe_offer_type ot ON o.chuboe_offer_type_id=ot.chuboe_offer_type_id WHERE olm.isactive='N' AND ot.name='Broker Stock Offer' AND olm.created >= NOW() - INTERVAL '9 months'\").then(r=>{console.log('Already deactivated:',r.rows[0].count); p.end()});"
       ```
    2. Run dedup with offset (replace OFFSET with count from step 1):
       ```bash
       node /home/analytics_user/workspace/astute-workinstructions/scripts/dedup-direct.js "Broker Stock Offer" --apply --offset=OFFSET
       ```
    3. Monitor: `grep "Processed:" <logfile> | tail -1`
  - **Total target:** 639,522 duplicate pairs to deactivate
  - **Script:** `astute-workinstructions/scripts/dedup-direct.js`
  - **Root cause fix:** `offer-writeback.js` now has `writeMpnRecords: false` by default (2026-07-07)

- [ ] 🟢 **PRIORITY: Inventory Cleanup Burst Fix Validation** *(opened 2026-06-21, MONDAY)*
  - **Context:** Inventory cleanup was failing 70× due to burst limit (600/5min) aborting chunked writes mid-way, creating 407 garbage partial offers since June 15. Root cause: when burst limit hit, `offer-writeback.js` returned `partialWrite: true` immediately instead of waiting for the burst window to clear.
  - **Fix applied:** Changed chunked mode to WAIT for burst window to clear (poll every 30s, max 30 min) instead of aborting. This allows large batch jobs (~5000 lines) to complete over ~45 minutes by waiting through multiple burst windows.
  - **Cleanup done:**
    - Deactivated all 407 partial offers from June 15-21
    - Reactivated June 1 complete offers (11 warehouses, 4,991 lines)
    - Paused inventory-cleanup job (`.inventory-cleanup-paused` + sentinel set to 2099)
  - **Why waiting:** Need to validate fix works before re-enabling automation.
  - **Ready when:** Monday 2026-06-22 (scheduled inventory run day)
  - **How:**
    1. Remove pause: `rm ~/workspace/.inventory-cleanup-paused`
    2. Reset sentinel: Update `~/workspace/.cron-sentinels/inventory-cleanup.json` with `nextDue: "2026-06-22T11:00:00.000Z"`
    3. Let cron run at 11:00 UTC Monday, OR manually test with `--force`
    4. Monitor logs: `tail -f /tmp/inventory-cleanup.log`
    5. Verify: Should see "Waiting for budget..." messages, then "Budget cleared after Xs", then complete all 11 warehouses
    6. If success: Job should exit 0, sentinel advances to June 29
  - **Files:**
    - Fix: `shared/offer-writeback.js` (lines 385-451, wait-and-retry logic)
    - Sentinel: `~/.cron-sentinels/inventory-cleanup.json`
    - Pause file: `~/.inventory-cleanup-paused`
  - **Rollback if broken:** Re-create pause file, investigate logs

- [ ] 🟢 **VQ Loading: Support .eml/.msg attachments for batch quote loading** *(opened 2026-06-12, operator request)*
  - **Context:** Operator has many broker quote emails to load as VQs. Current workflow requires forwarding each email individually to `vq@`. Operator asked if they could attach multiple emails (.eml or .msg files) to a single email and have them all processed. Current system does NOT support this — it processes one email = one quote entity, and attachment handling is limited to PDF/Excel/CSV within a single email.
  - **Why blocked:** Feature doesn't exist. Operator flagged as "priority for next week" (2026-06-12).
  - **Ready when:** 2026-06-16 (next week) or whenever operator picks this up.
  - **Scope / How:**
    1. **Phase 1: .eml parsing** — Add `.eml` to the attachment type detection in `vq-parser/src/attachment/downloader.js`. Use `mailparser` npm package (or similar) to parse .eml files into structured email objects (From, Subject, Body, nested attachments).
    2. **Phase 2: Multi-email handler** — Modify `processAttachments()` in `vq-parser/src/attachment/index.js` to detect when attachments are .eml files. For each .eml, extract the email body and run the existing quote extraction logic (template matching + LLM extraction).
    3. **Phase 3: .msg support** — Add `.msg` parsing using `msg-reader` or similar npm package (Outlook MSG format). Same flow as .eml — parse to structured email, extract body, run extraction.
    4. **Phase 4: Routing adjustments** — Each .eml/.msg attachment becomes a separate extraction result. Routing decisions (Processed/NeedsVendor/NeedsReview) should apply per-attachment, not per-wrapper-email. May need a "batch wrapper" folder routing concept.
  - **Estimated effort:** 4-6 hours for Phase 1+2 (eml), +2 hours for Phase 3 (msg). Phase 4 depends on operator's preferred UX.
  - **Dependencies:**
    - `npm install mailparser` (for .eml)
    - `npm install @nicktomlin/msg-reader` or similar (for .msg — note: .msg parsing libs are less mature than .eml)
  - **Alternative considered:** Operator could use IMAP drag-and-drop to move emails directly into vq@ INBOX, bypassing attachment approach. Works but requires IMAP client access.
  - **Files to modify:**
    - `vq-parser/src/attachment/downloader.js` — add .eml/.msg type detection
    - `vq-parser/src/attachment/index.js` — add .eml/.msg parsing handlers
    - `vq-parser/src/attachment/eml-parser.js` (new file)
    - `vq-parser/src/attachment/msg-parser.js` (new file)
    - Possibly `vq-parser/src/index.js` fetch flow if batch routing changes needed
  - **Created / source:** 2026-06-12 session, operator request for batch loading efficiency.

- [ ] 🟢 **VQ Loading: Add automatic reply detection for "note vendor in VQ notes"** *(opened 2026-05-26 during Nordisk unknown-vendor implementation)*
  - **Context:** Built the infrastructure to allow VQ loading when vendor BP doesn't exist in OT by storing vendor name in `Chuboe_Note_User` instead (using a placeholder BP). Works when called with `unknownVendorPlaceholderBpId` parameter. **Not yet wired into automatic reply detection** — operator must manually invoke the test script or add the parameter to the payload. Future workflow: when operator replies to a `needs_vendor` escalation with "note vendor in VQ notes" / "load without BP" / "store as note", the agent should auto-detect and retry the load with the placeholder BP flag enabled.
  - **Why blocked:** operator requested "flag for later (tomorrow)" on 2026-05-26 to focus on cron pause/resume planning.
  - **Ready when:** tomorrow (2026-05-27) or whenever operator wants to finish the Nordisk case automation.
  - **How:**
    1. Read `Trading Analysis/RFQ Sourcing/vq_loading/agent-prompt.txt` reply-stitching section (§ 3.2 or wherever `needs_vendor` sidecar replies are parsed)
    2. Add pattern matching for phrases: "note vendor in vq notes", "load without bp", "store as note", "note in notes", "vendor in notes"
    3. When detected, extract the vendor name from the sidecar's `vendor_name` field and re-dispatch `load_vq` with `unknownVendorPlaceholderBpId` set to `UNKNOWN_VENDOR_PLACEHOLDER_BP_ID` constant (defined in `shared/workflow-actions/vq-loading.js`)
    4. Test with a mock reply to one of the Nordisk sidecar files
  - **Prerequisite:** Operator must create the placeholder BP in OT first (instructions in `shared/workflow-actions/vq-loading.js` lines 40-64) and set the `UNKNOWN_VENDOR_PLACEHOLDER_BP_ID` constant
  - **Files changed:** `shared/workflow-actions/vq-loading.js` (implemented), `shared/vq-writer.js` (implemented), `shared/load-bulk-summary.js` (implemented), `Trading Analysis/RFQ Sourcing/vq_loading/agent-prompt.txt` (needs reply detection logic)
  - **Created / source:** 2026-05-26 session, git commit `599ba3c`

- [ ] 🟢 **Hung `himalaya` process accumulation — add a reaper and/or timeout wrapper** *(opened 2026-05-26, surfaced during a live "VQ loader killing OT" incident)*
  - **Context:** Colleague reported a VQ loader "killing OT." Investigation found OT prod was healthy (API 404 at root in 61ms), but THIS analytics box was at **load average 40.7** sustained 15+ min. Cause: **65 orphaned `himalaya attachment download` processes** across the `vq`, `rfqloading`, and `stockrfq` inboxes — abandoned email-attachment fetches from past Claude sessions that hung mid-download and were never reaped. They held **469% aggregate CPU** (≈4.7 cores). Oldest had been spinning **~82 days**; newest ~17 days. Parent shells were dead `/tmp/claude-*-cwd` interactive shells. Killed all 65 (`ps … | grep "[h]imalaya" | awk '{print $1}' | xargs -r kill -9`) → count→0, CPU freed; load decaying. Because VQ/RFQ/Stock loaders all run *through* himalaya, the symptom looked like "the VQ loader is thrashing." No actual VQ-loader node process was running.
  - **Why blocked:** operator said "save this for discussion later" (2026-05-26). Incident itself resolved; this is the *prevention*.
  - **Ready when:** any future session — operator wants to discuss approach before building.
  - **How (decide with operator):**
    1. **Cron reaper (leaning toward this — belt-and-suspenders):** small registered cron job that kills any `himalaya` process older than ~10 min. Follow the Resilience Checklist + `cron-jobs.js` flow. Covers all call sites at once, including ad-hoc interactive ones.
    2. **Timeout wrapper at the call sites:** wrap every himalaya invocation in `timeout 120 himalaya …` (in the shared email-fetch helper) so a stuck fetch self-terminates. Cleaner per-call but only covers code paths that go through the helper — misses ad-hoc/interactive calls (which is exactly what accumulated here).
    3. Probably do both: wrapper for the common path + reaper as the safety net.
  - **Created / source:** 2026-05-26 live incident triage.

- [ ] 🟢 **stockrfq/poller: writeRFQ failure during OT outage silently loses the RFQ AND traps it against recovery (false `loaded` breadcrumb)** *(opened 2026-05-26, surfaced during stockrfq cron tick UIDs 5040+5041)*
  - **Context:** OT REST API flapped again 2026-05-26 ~11:17–11:22 UTC (curl probe http_code=000, ~20s connect timeout, then recovered to 404). Two real RFQs routed `load_rfq` during the dead window: UID 5040 (Zhengxin/qq.com, MCP6001T-I/OT ×350K, Unqualified Broker) and UID 5041 (ElecDif/HoldElec BP 1001212, MAX690AMJA ×25). **Both were recovered and written this tick** → searchKeys `1135625` (rfqId 1145040) and `1135626` (rfqId 1145041), verified in DB. This item is the *systemic fix*, not the recovery.
  - **The bug (two compounding failures):**
    1. `rfq-writer.writeRFQ` returns `{rfqId:null, linesWritten:0, errors:['Failed to insert RFQ header: fetch failed']}` **without throwing** when OT is unreachable. `email-workflow-poller.cmdRoute` only escalates on a *thrown* handler error (it does `process.exit(1)` on throw); a returned-errors result is treated as success → the message is **moved to `Processed`** and drops out of the unseen queue. Demand signal lost with no retry.
    2. `doWriteRFQ` writes a `loaded` breadcrumb **unconditionally** even when `rfqId===null`/`errorCount>0`. `breadcrumbs.hasMessageIdAlreadyLoaded()` matches any `event:'loaded'` regardless of rfqId — so the next time the email is seen, `action_load_rfq`'s Message-ID dedup guard returns `already_processed:true` and `dup_skip`s it. The failed RFQ is now **unrecoverable via normal re-poll.** (Recovery this tick required manually renaming the two false breadcrumbs `loaded`→`load-failed-fetch`, then re-invoking the handler with the captured payloads.)
  - **Why blocked:** non-urgent now (today's two RFQs are in OT), but this WILL silently drop RFQs on every future OT blip. Same root outage as the UID 5029 item below.
  - **Ready when:** any future session.
  - **How (pick the cheap wins first):**
    1. **Don't write a `loaded` breadcrumb on failure** — in `doWriteRFQ`, if `result.rfqId==null || result.errors.length`, write `event:'load-failed'` (NOT `loaded`) so the dedup guard never suppresses a recovery re-write. One-line fix, highest leverage.
    2. **Poller should treat returned `errors[]` as a failure** — `cmdRoute` should inspect the handler result for a non-empty `errors`/null id and route to NeedsReview (keep unseen / don't move to Processed) rather than silently succeeding. Or the handler should `throw` on total write failure so the existing exit(1) path fires.
    3. **Gate the write on OT health** — `action_load_rfq` (and the poller route path for `needsOT` workflows) should probe `/api/v1/` before `writeRFQ`; on 000/5xx, leave the message unseen instead of moving to Processed. Mirrors the cron-runner OT health gate that already exists for scheduled jobs.
  - **Created / source:** 2026-05-26 stockrfq cron tick (UIDs 5040, 5041). Recovery details in that session transcript.

- [ ] ⏸️ **stockrfq: backfill missing chuboe_rfq_line_mpn on RFQ 1135619 (partial write during OT API outage)** *(opened 2026-05-26, surfaced during stockrfq cron tick UID 5029)*
  - **Context:** UID 5029 (eric_pldz@163.com / PLDZ Technology, Unqualified Broker fallback) loaded during a live OT REST API outage on 2026-05-26 ~10:02–10:07 UTC. `writeRFQ` created the header + line fine, but the `chuboe_rfq_line_mpn` AVL sub-row POST hung ~5 min and failed with `network error: fetch failed`. The writer logged "not retrying to avoid dup risk" — so there is **no auto-retry queue** for it. DB confirms: RFQ `1135619` / rfqId `1145034` / chuboe_rfq_line_id `3126132` / line 10 / qty 4257 has **0** active line_mpn rows → MPN `EPCS64SI16N` is NOT captured/searchable on this RFQ.
  - **Why blocked:** OT REST API (https://172.31.7.239/api/v1) was unreachable this tick (curl probe http_code=000, two consecutive 15–20s timeouts). Can't POST the sub-row until it recovers.
  - **Ready when:** OT API is healthy again (verify: `curl -sk -o /dev/null -w "%{http_code}\n" --max-time 15 https://172.31.7.239/api/v1/` returns 200/401, not 000).
  - **How:**
    1. Confirm still missing: `psql -c "SELECT COUNT(*) FROM adempiere.chuboe_rfq_line_mpn WHERE chuboe_rfq_line_id=3126132 AND isactive='Y';"` — if already >0, mark done (a later reprocess or manual fix beat us to it).
    2. Backfill via the API: `apiPost('chuboe_rfq_line_mpn', { Chuboe_RFQ_Line_ID: 3126132, Chuboe_MPN: 'EPCS64SI16N', Chuboe_MPN_Clean: 'EPCS64SI16N' })`. Leave MFR blank — EPCS64 is Altera/Intel but the MFR Reconciler cron fills the FK overnight; don't guess it here.
    3. Verify the row landed and the dup/match LEFT JOIN now shows the MPN.
  - **Created / source:** 2026-05-26 stockrfq cron tick. The header+line carry the demand qty; only the MPN string is missing.

- [ ] 🟢 **vq-loading: cross-UID duplicate-email detection for same-content forwards** *(opened 2026-05-25, surfaced from UID 8667 Savings Ribbon)*
  - **Context:** Savings Ribbon was already loaded to RFQ 1121675 via UID 8661 (34 VQs). UID 8667 was a sibling forward of the same email that bounced without realizing UID 8661 had already covered it. The natural-key dedup at the writer level catches duplicate VQ writes, but the agent still spent a tick + emitted a needs_review escalation that wasn't needed.
  - **Why blocked:** non-urgent — writer-level dedup prevents data corruption; only the escalation noise is the issue.
  - **Ready when:** any future session.
  - **How:** Investigate whether the agent should check breadcrumbs for prior `loaded` events with overlapping MPN sets + similar timing before issuing escalations. May want a "this email's content already covered by UID X loaded at T" early-exit branch.

- [ ] ⏸️ **Personal documentation track — paused pending external review** *(opened 2026-05-25)*
  - **Context:** Solo workstream. Local context only.
  - **Why blocked:** Event-driven on an external review conversation.
  - **Ready when:** That conversation has happened and there's feedback to fold in.
  - **Resume cue:** Operator will reference this with the phrase *"let's pick up the personal docs track"* — Claude pulls the per-user memory file (not in the repo) for the full picture.

- [ ] 🟢 **vq-loading → rfq-loading forward delivery — verify SMTP path** *(opened 2026-05-23, surfaced during UID 8630 live test)*
  - **Context:** First live exercise of the new `forward_to_rfq_loading` action (commit `cb1ceb9`) on UID 8630 fired correctly on the vq-loading side at 2026-05-22T23:56:50Z — sidecar `~/workspace/.vq-loading-pending/vq-forward-8630.json` parked 30 quotes with correlation MID `<vq-forward-8630-1779494210267@orangetsunami.com>`. The `vq-loading-resumer` cron is polling correctly (`waiting=1` every 10m). BUT: the forwarded email does not appear to have landed in `rfqloading@orangetsunami.com` inbox — `himalaya envelope list --account rfqloading` shows no matching subject, and there's no `rfq-loading-agent` breadcrumb activity for our MID.
  - **Why blocked:** unverified whether the send actually succeeded or failed silently. The notifier's `sendEmail` returns `false` on SMTP failure but the handler doesn't check the return value (just `await ctx.notifier.sendEmail(...)`). Three plausible causes: (a) SMTP delivery failure swallowed by lack of return-value check; (b) email landed in a folder I didn't check (Junk?); (c) delivery delayed beyond the time I looked.
  - **Ready when:** any future session — cheap to verify (himalaya envelope list across folders + `/tmp/vq-loading-agent.log` grep for SMTP errors around 23:56:50Z).
  - **How:**
    1. `himalaya envelope list --account rfqloading --folder INBOX --page-size 200` — look for `[VQ→RFQ] New RFQ needed: Astute Group / Shortage / 17 lines`.
    2. Also check Junk, Processed, OutboundPending folders on rfqloading@.
    3. If still absent: `grep "rfqloading\|sendEmail\|smtp" /tmp/vq-loading-agent.log` around 23:56:50.
    4. If genuine send failure: extend `action_forward_to_rfq_loading` to check `sendEmail`'s return value; on `false`, fail the action loudly (escalate `needs_review`) rather than silently parking the sidecar.
    5. Also extend `shared/notifier.js` `sendEmail` to throw instead of returning `false` on SMTP failure — silent failures here have caused other delivery issues historically.
  - **Side effects of leaving as-is:** Sidecar `vq-forward-8630.json` will sit for 7 days then trigger the resumer's `parked-expired` operator email. Not silent — operator will get pinged.

- [ ] 🟢 **spawnSync psql ENOBUFS in load-bulk-summary pre-flight for very large RFQs** *(opened 2026-05-23, surfaced during UID 8630 live test)*
  - **Context:** Same UID 8630 run. Two `load-failed` events with `error: "spawnSync psql ENOBUFS"` against RFQ 1134261 (Astute Electronics Inc, **17,752 active lines**). Both attempts failed identically. Agent then routed `needs_review` cleanly with the right investigation_summary. Other 10 RFQs in the same email loaded fine — only the giant one tripped the buffer.
  - **Root cause:** `shared/load-bulk-summary.js` calls `execFileSync('psql', ...)` to fetch RFQ lines + MPNs as part of `loadBulkSummary` setup. Default `maxBuffer` for execFileSync is 1MB. 17,752 lines × MPN-set per line easily exceeds that.
  - **Why blocked:** real but not urgent — the agent escalates cleanly. Affects only the small handful of very-large RFQs (Astute Electronics Inc-class). Not a regression — this RFQ shape has always been at the limit.
  - **Ready when:** whenever someone touches `shared/load-bulk-summary.js` or `shared/vq-writer.js` for unrelated reasons (apply the fix in the same touch per the parallel-writer-audit discipline).
  - **How:**
    1. Find every `execFileSync('psql', ...)` and `execSync('psql ...')` in `shared/load-bulk-summary.js` + `shared/vq-writer.js` + `shared/mfr-from-vq-history.js` + `shared/mfr-from-ot-history.js` + `shared/partner-lookup.js`.
    2. Pass `{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }` (64MB — generous; the alternative is paginated fetches which is much more code).
    3. Add a regression test that exercises the RFQ 1134261-size case via `shared/load-bulk-summary.js loadBulkSummary({ rfqSearchKey: '1134261', ... dryRun: true })` — should not throw ENOBUFS.
    4. Note in commit message that this is a writer-side fix that applies to all callers per parallel-writer-audit; update `loader-changelog.md`.

- [ ] 🟢 **LAM EPG SIPOC — POV0075254 / PO810397 update** *(opened 2026-05-22, picks up Monday 2026-05-25)*
  - **Context:** Operator placed Arrow PO810397 today (2026-05-22, 11 lines, all stamped `POV0075254`). Need to backfill the SIPOC tracker at `Trading Analysis/LAM EPG Award/Lam_EPG_SIPOC.xlsx` with PO + Purchased By (Mohan, ad_user_id 1013586) + PO Sent (2026-05-22) + Processed in OT (Y) + OT Order Number. All 11 PO MPNs matched to SIPOC rows.
  - **SIPOC column map (header on row 2 / index 1):** col 17=Qty (LAM sales commitment), 26=POV, 27=Purchased By, 28=PO Sent (date), 30=Processed in OT, 31=OT Order Number, 33=Notes, 34=Tracking.
  - **Method:** Surgical zip-level patch + dated backup (`.backup-2026-05-25-pov75254`). Do NOT round-trip through SheetJS — destroys validations / customXml / styles per [[feedback_xlsx_roundtrip_destroys_forms]].
  - **Three buckets (sales-anchored against SIPOC Qty):**
    - **CLEAN FIRST PO (6 rows — safe to write):** rows 33 (254124-E qty 126), 39 (0826-1X2T-23-F qty 80), 46 (MOX91022505FTE qty 40), 134 (43160-0306 qty 125), 173 (EEEFK1V222SM qty 125), 202 (TSW-108-17-G-S qty 80). SIPOC Qty == PO qty exactly, no prior POs. Fill all 5 columns.
    - **PLANNED SPLITS (3 rows — safe to append slash-separated):**
      - Row 13 LP-CC-30: SIPOC qty 50 = Fuses 30 (PO809583/POV0075524) + Arrow 20 (PO810397/POV0075254). Notes confirm. ⚠️ Flag for operator: $24.03 vs $49.66 same-MFR price disparity worth understanding.
      - Row 104 3299Z-1-202LF: SIPOC qty 175 = Master 16 shipped (not in OT) + Arrow 159 (PO810397). Notes already say "Arrow (159) still open" — today's PO is that leg finally cut.
      - Row 106 0216.200MXP: SIPOC qty 250 = Arrow 110 (PO810397) + 140 remaining. POV0075257 reserved but no PO cut yet.
    - **SOURCE CHANGE + COVERAGE GAP (1 row — safe to append, flag the gap):** Row 6 SHV24-1A85-78D3K: SIPOC qty 1000. DK 281 shipped (PO809612/POV0075252) + Arrow 288 (PO810397/POV0075254). 281+288=569; **431 units still uncovered** (POV0075257 reserved, no PO cut). Notes already say "DK repriced after order cancellation".
    - **🚨 SUSPECTED DUPLICATE (1 row — DO NOT WRITE until operator verifies):** Row 43 R-7315P. Notes already claim `"Master qty (5) shipped 03/28 on 380029812239; Arrow (15) shipped on 518717946566 — fully shipped"` and Tracking column has `"518717946566 (Arrow x15)"`. SIPOC says the Arrow-15 leg was already done. Yet today's PO810397 cuts a fresh Arrow 15 @ $15.584. Either (a) prior shipment was outside OT — today's PO is a duplicate purchase; or (b) the tracking note was premature — today's PO is the real cut. **Verify before writing.**
  - **Outstanding operator decisions before write:** (1) multi-POV rows: append slash-separated vs. only-fill-blanks vs. overwrite — operator leaned toward append slash-separated but didn't lock it in. (2) Notes line append per row in the existing dated format `[2026-05-22] Arrow POV0075254 / PO810397 placed — qty <X> @ $<Y>` — yes / no. (3) Row 43 duplicate verdict.
  - **Additional cleanup candidates surfaced during review (not strictly POV0075254):**
    - Orphan POV0075257 (planned but no PO cut) — used on rows 6 and 106 as reserved placeholder for remaining coverage
    - Orphan POV0075267 (planned but no PO cut) — used on rows 43 and 104; Master shipments referenced in notes are NOT in OT under any POV stamp
  - **Ready when:** Monday 2026-05-25 operator session. Three quick decisions, then surgical zip patch.
  - **Source:** This session (2026-05-22) — operator placed PO810397 today and said "i need to piock this back up monday".

- [ ] 🟢 **Claude Harris ROI digest — clarity pass (continuation)** *(opened 2026-05-21, big iteration shipped 2026-05-22)*
  - **Shipped 2026-05-22 (this session):**
    1. Removed the vestigial 3-row "Sales (Adoption — correlative)" table + its dead `direct_win` CTE / aggregates. Causal sales attribution now lives only in Revenue-Claude-Generated + Sold-line win attribution.
    2. **Dual-window view** — every scoped table (Procurement, Revenue Claude generated, Process-order per-seller, Sold-line win attribution) now shows trailing-30d AND since-inception (cumulative) columns side-by-side. Blue banner explains the dual-window convention. Inception date queried at runtime (2026-04-07).
    3. **Process-order per-seller table moved** directly under the Winning Business (Adoption) window table. Added columns: Non-Claude VQs (with avg/line), 🔎 Claude cheaper applicable lines, 💸 GP lost (= (purchased cost − Claude cost) × RFQ qty across qty-applicable cheaper-VQ lines).
    4. **Scope filter (1) — email-load echoes:** non-franchise Claude VQs written AFTER a human VQ on the same line are dropped from `api_vq`. These are the VQ-loader agent digitizing inbound broker emails on already-active lines — not sourcing.
    5. **Scope filter (2) — post-SO backfills:** any Claude VQ written AFTER a sold CQ already exists on the line is dropped. Desktop scrape (Heilind etc.) catching up after the deal closed; can't have influenced sourcing.
    6. **Title changed** "API Enrichment ROI" → "Sourcing ROI" (matches the broader Claude-as-Buyer scope: API enrichment + NetComp broker agent + LAM Kitting + scrapes).
    7. **MPN selection fix** — multi-MPN/AVL lines now pick the MPN that matches an actual VQ on the line (IsPurchased VQ preferred, then any VQ, fallback to lowest `chuboe_rfq_line_mpn_id`). Validated on RFQ 1135097 — drill now shows Yageo `RC0100FR-07100KL` (the part actually quoted) instead of the KOA AVL alternate.
    8. **Workflow-context footnote** on the Process-order section showing org-level Adoption RFQ→sold-CQ <60min count, independent of Claude. Today: 163 lines/30d, Claude active pre-sale on 8. The other 155 are "what-if" — surfaced as a count so the workflow signal is visible but per-seller granularity is reserved for the Claude-active subset where money-on-table is provable.
  - **Discoveries / framing decisions made (carry forward):**
    - Distinction nailed: **Claude as Sourcing Buyer** (API enrichment, NetComp agent, LAM Kitting, scrapes) vs **Claude as VQ Support** (email-loader digitization). Tracker is scoped to the former.
    - Mirror parent revenue dropped $32K → $13K post-filter; remaining $13K (Sanmina + GE Aerospace) is legitimate Claude-first franchise mirror.
    - Coverage Gap miss revenue went 1/$40K → 0/$0 — Marvell RFQ 1134154 was Heilind post-SO backfill, correctly removed.
    - Buyer-pre-loaded pattern (first human VQ <Xmin after RFQ creation) is the buy-side analog of seller process-order RFQs. Logged but not wired in.
    - **Truth-over-helpfulness check:** operator explicitly flagged not wanting to manipulate variables to suit outcome — filters keep signal honest, footnote keeps the workflow signal visible even when it's outside Claude attribution.
  - **Still open (next session):**
    1. `winBotSoleSolo` + `winBotSoleAdoptedCompetingVq` still contribute to `revenueClaudeGeneratedNet` but only handoff + mirrorClaudeFirst are displayed in the Revenue Claude generated box. Either fix description or add the missing 2 sub-rows.
    2. Per-bucket GP isn't broken out in that box (em-dash placeholder). Add `winBotSoleAdoptedHandoffPoNet` / `winMirrorClaudeFirstPoNet` accumulators for per-sub-row GP.
    3. `adoption.poNet` vs `revenueClaudeGeneratedPoNet` $2.80 gap — likely 1-2 lines not classified as wins.
    4. LAM/Stock revenue + GP tracking under Process Efficiency (currently PO cost only).
    5. Window classification (processOrder <60min / needsReview 1-24h / realSourcing 24h+) thresholds review.
    6. Buyer-pre-loaded pattern — if it shows up frequently, surface as parallel signal.
    7. Replica-lag / late-toggling investigation: misses that appear in one run and not another due to IsPurchased/IsSold flags being toggled later. Operator asked whether we can audit via `ad_changelog`.
  - **Ready when:** Next session with operator at hand. Discussion + iterate pass, not autonomous.
  - **Source:** Sessions 2026-05-21 (GP column landed) and 2026-05-22 (clarity pass main iteration).

- [ ] 🟢 **VQ Loading — UID 8508 "red rows only" recovery + HTML-body fix** *(opened 2026-05-20)*
  - **What's done this session:**
    - UID footer shipped: `vq-loading.js:754-765` now appends `Operator reference (CC only): UID <n>` to sender-routed needs-review emails when operator is CC'd. One-line grey footer.
    - Confirmed UID 8508 (Ivy fwd of Betty Song's `转发: upload VQ May 13th`) bounced 2026-05-20 01:39 UTC because Betty's body said "only red-highlighted rows should be uploaded" — plain-text body strips colour, agent couldn't disambiguate ~100+ rows.
    - Sender-facing bounce email asked generically for "structured text format" (the default `senderAsk` in `action_needs_review`). Ivy interpreted that as a format complaint and replied with text-pasted version (UID 8516) which had `brokerMessageId: null` — Betty's chain lost.
    - UID 8516 then loaded **293 VQs** across RFQs 1134279/141, 1134964/125, 1134264/25, 1134281/1, 1134282/1. **0 of 293 ticked `IsPurchased='Y'`** — safe to mass-deactivate.
  - **What's pending:**
    1. ~~Confirm scope via dedup-overlap signal~~ — skipped. The original query did a multi-million-row scan of prior VQs and stalled; spawned a pile of orphan psql processes that had to be killed. The overlap insight isn't required for the rollback decision (operator agreed deactivate all 293 regardless to give step 4 a clean test).
    2. ✅ **Rollback done** (2026-05-20 12:28 UTC). All 293 patched to `IsActive='N'` via `oneoffs/rollback-uid8516-vqs-2026-05-20.js`. 0 failures, 0 still active. Snapshot at `~/workspace/rollback-uid8516-snapshot.csv` (293 rows, columns: vq_id/rfq/bpartner_id/rfq_line_id/cost/currency_id/mpn/mfr). Use this snapshot to compare against step-4 reprocess output.
    3. **Ship HTML body exposure** in `shared/email-workflow-poller.js` so the read command surfaces an `html` field alongside text. Update VQ Loading agent prompt: when operator references formatting (red/yellow/highlight/bold/italic/strikethrough), consult HTML body. Per design decision this session — don't write a deterministic colour-parser, let the agent reason about the markup.
    4. Re-trigger UID 8508 (still parked in NeedsReview folder) through the new HTML-aware pipeline. Agent should pick out Betty's red rows and load only those. Validate: which (rfq_line_id, vendor) pairs from the new pass overlap with the snapshot? Overlap = the rows Betty wanted; non-overlap (new pass writes rows that weren't in the rollback set) = something has shifted.
  - **Won't do** (decided this session): generic "could you resend with red rows highlighted" ask back to Betty/Ivy. The fix is in the tool, not the operator.
  - **Created / source:** 2026-05-20 chat with operator after Ivy's reply made the format/content failure mode visible.

- [ ] 🅿️ **Stock RFQ Digest — Netlify static site (multi-user browse)** *(parked 2026-05-14)*
  - **What's done (code side, dry-run-tested but no real deploy):**
    1. `shared/netlify-deploy.js` — manifest+upload helper using built-in fetch + crypto (no netlify-cli dep)
    2. `Trading Analysis/Stock RFQ Loading/stock-rfq-activity-digest.js` — extracted `renderBodyInner` from `renderHtml`; added `renderSiteHtml` + `renderArchiveListHtml` + `publishSite` (writes `index.html` + `archive/<utc-ts>.html`, prunes archive >30 days, regenerates `archive/index.html`, calls Netlify deploy). Wired `--publish` flag; independent of `--dry-run` and email-send path.
    3. `cron-jobs.js` — appended `--publish` to the digest command. **Not yet installed via `install-crons.js --apply`** — gated on operator confirming the Netlify side is ready, otherwise every 4h cron tick will print a "credentials missing — skipping deploy" warning to the log.
    4. Dry-run staging confirmed at `~/workspace/.stock-rfq-digest-site/` (index + 404 + archive/index + timestamped snapshots). Identity widget script + login/logout buttons + client-side gate JS rendered correctly.
  - **Why parked:** Operator pivoting to a Chrome extension first; expects that work to make this much easier (probably the extension becomes the browse/auth mechanism, or replaces the need for a website entirely). Revisit after the extension lands.
  - **Why blocked / pending operator setup before first deploy:**
    1. Netlify account created, Identity already enabled — confirm registration is set to "Invite only" if not already
    2. Personal Access Token not yet issued (Avatar → User Settings → Applications → Personal access tokens)
    3. Site ID not yet captured (Site Settings → General → Site information → API ID)
    4. Both need to land in `~/workspace/.env` as `NETLIFY_AUTH_TOKEN` / `NETLIFY_SITE_ID`
    5. Users to invite (Identity tab → Invite users)
  - **Ready when:** operator returns to this after the Chrome extension is working, OR decides the website is still wanted in parallel.
  - **Concrete next steps:**
    1. Collect token + site ID, paste into `.env`
    2. `node "Trading Analysis/Stock RFQ Loading/stock-rfq-activity-digest.js" --publish` for first real deploy (this also sends email — use `--dry-run --publish` first if you want to re-stage without emailing; the deploy is skipped under `--dry-run`)
    3. Confirm site reachable, login flow works
    4. `node scripts/install-crons.js --apply` to pick up the cron-jobs.js change
    5. Invite team members via the Identity tab
  - **Caveats worth re-reading before resuming:**
    - Gate is **client-side only** — Identity widget hides `<main>` via JS until logged in. A determined party with the URL + curl can read the raw HTML. Acceptable for internal sourcing intel on an unguessable subdomain; upgrade path is Cloudflare Access (free, ≤50 users) in front of Netlify if true server-side protection is needed.
    - Multi-tenant on Netlify free plan — Identity free tier covers up to 1,000 active users. Deploy quota (~6/day = 180/month) well under the cap.
  - **Source:** 2026-05-14 session — operator asked "can we make a website that hosts this using Netlify" → built code through dry-run, parked before first deploy in favor of Chrome extension work

- [ ] 🅿️ **PO Activity Analysis — pick up where Jan 2026 left off** *(parked 2026-05-13)*
  - **What's done:** Full workbook for January 2026 (`Trading Analysis/PO Activity Analysis/output/January_2026_POs_Analysis.xlsx`, emailed to Jake). 8 tabs: Summary, Open Past-Due, Buyer Status Matrix, By Buyer / Supplier / Customer, Cycle Benchmarks, Cycle Times, All Lines. Headline: 413 POVs / 541 parts lines, 73% validated, 24% NOT_RECEIVED (132 lines, $333K open exposure, $1.28M open SO at risk), median PO→Valid 32d / P90 81d. Scripts + SQL persisted under `Trading Analysis/PO Activity Analysis/`.
  - **Why parked:** Operator was exploring — no immediate action. Curious about delivery status, OTIN lifecycle, tracking gaps.
  - **Possible follow-ups when revisited:**
    1. Repeat for Feb / Mar / Apr 2026 (SQL is month-parametric — change one date range)
    2. Filter chases for the 114 NOT_RECEIVED-with-no-tracking lines (the highest-risk subset — buyer follow-up worklist)
    3. Split GP by `rfq_type` (Stock / Shortage / PPV) — the 62% margin is almost certainly driven by Shortage / PPV
    4. Carrier API integration (FedEx Web Services + UPS Tracking API) — public sites block scraping from this env, confirmed 5/13. Would unlock systematic open-PO tracking reconciliation.
    5. Buyer-level cycle benchmark tab — who's running fast vs slow on PO→Valid
    6. SO attribution refinement — exact per-PO revenue requires m_inout → sales orderline matching (current method = po_qty × wavg SO price, slightly over-attributes when non-month POs also fulfill the customer order)
  - **Ready when:** operator wants to revisit
  - **Source:** 2026-05-13 ad-hoc session

<!-- VQ Loading agent-pattern conversion: PRUNED 2026-05-18 — landed between 5/11 handoff and 5/18. See ## Done § "Loader-parity bundle" below. -->

<!-- ORIGINAL DEFERRED ENTRY (kept commented for historical reference; can be deleted on next prune) -->
<!--
- [ ] 🟢 **VQ Loading — convert to agent + cron pattern matching stockrfq-agent / excess-agent** *(handoff from 2026-05-11 — operator wants this scheduled the same way)*
  - **Why blocked:** Operator opening fresh terminal to scope and implement. Currently VQ Loading is partially direct-write (Type 2 bulk-summary via `load-bulk-summary-cli.js`) and partially legacy-CSV (Type 1 single-vendor via `vq-parser fetch`). Operator wants the whole workflow on a 30-min cron like the other email-driven workflows.
  - **Ready when:** Next session.
  - **Required pattern** (from `astute-workinstructions/email-workflow-architecture.md` + memory `feedback_email_workflows_use_agent_pattern.md`):
    - Generic poller: `shared/email-workflow-poller.js` (no workflow-specific email parser)
    - Per-workflow handler: `shared/workflow-actions/vq-loading.js` (inbox config + notifierConfig + actions map)
    - Workflow .md (`Trading Analysis/RFQ Sourcing/vq_loading/vq-loading.md`) is the agent's runtime prompt — must be self-contained instructions for the LLM agent
    - Cron entry in `cron-jobs.js` invoking `vq-agent` every 30 min via `cron-runner.js`
    - **Print Resilience Checklist before adding the cron** (per CLAUDE.md § Scheduling New Activities — non-negotiable, operator wants this visible)
  - **Open design questions to resolve first (don't skip these — VQ loading is more complex than stockrfq):**
    1. **Inbox.** Probably `vq@orangetsunami.com`? Confirm. Verify forward rules exist (operator hit the weekend-no-forward gap on stockrfq/excess — same risk here).
    2. **Two-Agent Validation — keep for VQ specifically, NOT uniform across all three workflows.** Cost-of-error is fundamentally higher for VQ Loading than for stockrfq/excess: a misread price becomes a buy decision that costs real money. For stockrfq + excess, the writer-level validators (partner-lookup employee filter, MFR resolver, packaging-id check, `shared/vq-purchase-validator.js`) catch the schema errors that matter, and semantic errors are recoverable (deactivate + recreate). For VQ, schema validators can't catch "is this the right MPN at the right price for the right supplier?" — only a second agent comparing source vs. structured output can. **Implementation:** programmatic two-pass within the same tick — extractor emits structured output → verifier agent receives *only* the source email + the structured output and answers "did the extractor get this right?" If verifier flags, third pass or route to NeedsReview with both agents' notes attached. This is what an operator does manually in the terminal; bake it in.
    3. **Type 1 vs Type 2 routing.** Agent classifies email format on read: structured bulk summary → Type 2 path (currently `load-bulk-summary-cli.js` library); single-vendor table or PDF → Type 1 path. How does the agent invoke the template engine in `vq-parser/templates/` (velocity, chip1, j2-sourcing, semitech, akira-global, atlantic-semi)? Probably wrap the template lookup as a tool the agent can call by sender domain, then fall through to LLM extraction when no template matches.
    4. **RFQ matching.** VQs must link to the right `chuboe_rfq_id` — the email subject or body usually references the RFQ number. Agent extracts, resolves via `chuboe_rfq.value`, errors out if ambiguous. Memory `feedback_rfq_number_is_search_key.md` is the rule.
    5. **MFR/packaging/traceability gotchas.** Reference `shared/data-model.md`, memory `feedback_check_packaging_ids_at_source.md`, memory `feedback_mfr_resolution_mandatory.md`, memory `feedback_restricted_mfrs_opt_in.md`. The writer (`shared/vq-writer.js`) handles most of this, but the agent must pass valid inputs.
    6. **PDF attachments.** Several existing templates are PDF-based (ComSIT, Schukat, Charcroft, 4Source, IBH). Use `shared/pdf-extract.js`.
    7. **Cadence.** 30 min matches stockrfq/excess. Confirm — VQ traffic patterns may justify shorter (5–10 min) since brokers reply throughout the day, but 30 min should be the default and easy to tighten later.
    8. **Failure routing.** Where do extraction failures land — `NeedsReview` folder like the others? Define this in `workflow-actions/vq-loading.js`.
  - **Direct-write path is established.** Memory `feedback_vq_loading_writes_directly.md` says "Use `writeVQFromAPI` with synthetic broker stubs; CSV is a legacy artifact, NOT the deliverable." Type 2 bulk-summary already writes directly via `shared/load-bulk-summary.js` + `shared/vq-writer.js`. The conversion is to extend the same pattern to Type 1 (drop the CSV intermediate) and wrap both in the agent.
  - **Terminal-quality takeaways to bake into the cron-invoked VQ agent** *(operator's note: the terminal-invoked VQ parser is the best parser we have — these are the reasons why, codified)*:
    1. **The .md becomes a detail-dense runbook, not a procedural sketch.** Every operator correction surfaced during terminal sessions over the past months should be codified as an explicit rule + concrete example. Examples: "forwarded chains — check the body-block sender, not the From: header"; "if subject says 'RE:' look for the RFQ # in the quoted block"; "AVL alternates land on separate lines with shared CPC+qty per `feedback_avl_multi_mpn_loading.md`". The terminal version works because Claude reads carefully — give the cron-agent the same density of instructions and it can match.
    2. **Programmatic two-pass extractor → verifier** (see design question 2 above). This is the single biggest lift from terminal quality to agent quality — the terminal operator does this manually every time.
    3. **Active tool calls during extraction, not just at write time.** Define and expose to the agent: `lookupRFQ(value)`, `lookupExistingVQsForRFQ(rfqId)` (lets the agent spot "supplier already quoted this — is this an amendment?"), `lookupMFRAlias(text)` via `shared/mfr-equivalence.js`, `lookupVendorByDomain(emailDomain)`. The terminal Claude calls these naturally because they're available; the cron-agent needs them defined as MCP-style tools or as bash callouts wired into the agent's prompt.
    4. **Forward-chain handling as a first-class concern.** VQ Loading sees the most forwarded emails of any workflow — supplier reps frequently forward customer escalations, internal Astute people forward quotes between accounts, brokers forward broker-of-broker chains. The .md needs a dedicated section on: how to identify the original sender (body sender-block, not envelope From:), how to extract the original quote text from quote-fluff, how to flag ambiguous chains for NeedsReview. The operator has months of mental heuristics for this — codify them.
    5. **Confidence threshold for auto-write.** Verifier returns a confidence score; if below threshold (e.g. < 0.8), route to NeedsReview with the source email + extracted fields + verifier's flags, instead of writing. This is what a careful operator does instinctively. Define the threshold empirically by running the agent in shadow mode for a week and tuning before live writes.
  - **Cross-workflow takeaway (applies to stockrfq-agent + excess-agent too, not just VQ):** the .md detail-density lesson generalizes. The current stockrfq-agent / excess-agent runbooks are reasonably thin. Every operator-surfaced edge case from this point forward (the description regression in stockrfq, forwarded-chain employee-BP misattribution, HTML inline-table extraction in offer-poller) should land in the relevant .md as a rule with a concrete example. That's the cheapest quality lift available across all three workflows — no code changes required, just better instructions.
  - **Apply the lessons from stockrfq-agent / excess-agent rollout:**
    - The 5/7 partner-lookup employee-filter fix (`shared/partner-lookup.js` `partnerTypeFilter`) is shared infrastructure — VQ Loading's vendor lookup will automatically benefit, no separate fix needed
    - BUT the agentic loader's uniform-description regression on stockrfq-agent (see `project_stockrfq_agent_description_regression.md`) is a cautionary tale: trust the **DB**, not the agent log, when verifying behavior. The vq-agent's first few ticks should be inspected by querying `chuboe_vq_line` for the actual fields written, not just by reading the agent's summary.
  - **Files to read first** (in this order):
    1. `astute-workinstructions/email-workflow-architecture.md` — the canonical pattern
    2. `Trading Analysis/RFQ Sourcing/vq_loading/vq-loading.md` — current workflow doc (becomes the agent prompt)
    3. `shared/workflow-actions/rfq-loading.js` (reference implementation) and `shared/workflow-actions/` for excess-agent/stockrfq-agent equivalents
    4. `shared/load-bulk-summary.js` + `Trading Analysis/RFQ Sourcing/vq_loading/load-bulk-summary-cli.js` — existing Type 2 direct-write path
    5. `vq-parser/templates/*.js` — existing per-vendor templates, decide how to expose to the agent
    6. `shared/vq-writer.js` — the writer
  - **Source:** 2026-05-11 monitoring session — operator surfaced this after seeing stockrfq-agent + excess-agent working under the canonical pattern.
-->

<!-- Stock RFQ Loading two-changes: PRUNED 2026-05-18 — Change 1 moot (replaced by large-RFQ gate at enrich-poller), Change 2a + 2b shipped. See ## Done § "Loader-parity bundle" below. -->

<!-- ORIGINAL DEFERRED ENTRY (kept commented for historical reference; can be deleted on next prune) -->
<!--
- [ ] 🟢 **Stock RFQ Loading — two changes pending implementation** *(handoff from 2026-05-11 monitoring session — operator opening fresh terminal to implement)*
  - **Why blocked:** Operator wants both built in a fresh terminal with clean context. Two distinct changes scoped together.
  - **Ready when:** Now. Operator is on it.
  - **Change 1 — Decouple franchise API enrichment from `stock-rfq-runner`** so it doesn't compete with customer-RFQ enrichment for DigiKey's 1,000/day + Mouser's ~30/min budgets during business hours. Customer RFQs (PPV / Shortage / EOL/LTB) deserve uncontested daytime quota.
    - **Why:** 4/15 stock backlog (1,154 emails → 3,635 unique MPNs) exhausted DigiKey's daily quota and forced the JCI franchise shadow run to wait overnight. Same risk lives every time Stock RFQ volume spikes (5/8 had 136 RFQs).
    - **How:** Recommended approach is the "load-first, enrich-later" pattern (already in memory as a principle): `stock-rfq-runner` loads RFQ + lines + MPNs only, no API calls inline. A new scheduled enrichment cron (e.g. `enrich-stock-rfqs`) runs off-peak UTC (e.g. 03:00–07:00 UTC) and enriches Stock-type (1000007) RFQs only. Alternative: reuse `Trading Analysis/RFQ API Enrichment/enrich-rfq.js` filtered to `rfq_type_id=1000007` and schedule it nightly via `cron-jobs.js`.
    - **Files to check first:** `Trading Analysis/Stock RFQ Loading/stock-rfq-runner.js` (find inline franchise-api invocation), `Trading Analysis/RFQ API Enrichment/enrich-rfq.js`, `cron-jobs.js`, `astute-workinstructions/scripts/install-crons.js`. Print the Resilience Checklist for the new cron before installing (per CLAUDE.md § Scheduling New Activities).
    - **Tradeoff to flag:** Stock RFQ replies to brokers will lose same-day franchise-pricing data. Per `feedback_quoting_customer_vs_broker.md`, broker-to-broker quoting uses VQ history + 20-30%-below-franchise heuristic anyway — same-day franchise pricing is not a hard requirement. Confirm with operator before shipping.
  - **Change 2a — Partner-lookup scope expansion: customer-or-vendor, not customer-only** *(surfaced 2026-05-11 16:00 UTC by operator)*: The 5/7 partner-lookup tightening (`shared/partner-lookup.js` partnerType `'any'` → `'customer'` for stockrfq) was over-defensive. Reality of Stock RFQ workflow: we're quoting broker-to-broker, and most counterparties exist in OT as **vendors** (we've bought from them) — not yet promoted to customers. Restricting to `IsCustomer='Y'` falsely routes legitimate broker BPs to the Unqualified Broker catch-all (BP `1006505`).
    - **Today's misroutes caught manually:** Stack Electronics (BP `1003267`, IsVendor=Y) — RFQ `1143508`, PATCHed 16:14 UTC. SUNCODE Electronics (BP `1005501`, IsVendor=Y) — RFQ `1143433`, PATCHed 16:21 UTC. Both verified IsVendor=Y. Audit run via `~/workspace/oneoffs/audit-unqualified-stockrfqs-2026-05-11.js` — only those two surfaced from today's 56-RFQ Unqualified-Broker set, but that's a lower bound (suffix-stripping is conservative); the structural fix below catches the rest going forward.
    - **Correct scope rule:** for Stock RFQ context, match against `IsCustomer='Y' OR IsVendor='Y'` (i.e., "any non-employee BP"). The employee filter stays — that was the load-bearing part of the 5/7 fix.
    - **How:** Either expand `partnerType='customer'` to `partnerType='any'` in the agent's call sites (cleanest if the call goes through stock-rfq-runner.js — but per memory, the runner is retired and the agent does its own lookup), OR update `stock-rfq-loading.md` (the agent's prompt) to instruct the agent: "Match the sender against any active non-employee BP, including vendor-only BPs — broker-to-broker stock RFQs come from existing vendor BPs more often than customer BPs." The .md path is probably the right one given the agentic architecture.
    - **Don't regress employee filter:** the same .md/code change must continue to exclude `IsEmployee='Y'` BPs — that's the load-bearing part of the 5/7 commit. Test against an email containing Jake's or Edgar's address in a quoted chain — should still resolve to the broker BP, not the employee.
    - **Reference:** the 5/7 commit `2e9485f` and memory `feedback_use_data_model.md` / `feedback_lookup_cover_bases.md`. Update `shared/partner-matching.md` to reflect the broader scope rule.

  - **Change 2 — Unqualified-broker RFQ description format** *(empirical evidence updated post-12:30 tick observation, 2026-05-11)*: when partner-lookup falls through to the catch-all Unqualified Broker (BP `1006505` — **NOT** 1008499 as initially scoped; corrected after DB inspection of `chuboe_rfq_id` 1143408–1143428), the RFQ description should be `<best-effort company name from sender> — Stock RFQ` so the buyer sees at-a-glance who the unmatched email came from. Quantity is redundant (already on the line).
    - **Current state is worse than the 5/6 format.** The new `stockrfq-agent` (the 30-min agentic loader running per `stock-rfq-loading.md`) writes a UNIFORM description `excessAgent stock RFQ <YYYY-MM-DD>` to every RFQ — matched-BP and Unqualified alike. The `bpname` field is also empty. Verified across all 21 RFQs from the 12:30 UTC tick (search keys `1133993`–`1134013`, IDs `1143408`–`1143428`). 16 of those 21 went to Unqualified Broker with zero distinguishing info on the RFQ header.
    - **Agent log misleadingly claims success:** the 12:30 tick log says *"customerName captured in description per the .md fallback path"* but the DB shows it's not. Either the agent is hallucinating its own summary, or the customerName lands in a field we haven't checked. `description` is uniform, `bpname` is empty — those are the obvious candidates and both are blank.
    - **Examples of current bad format (5/11):** every Unqualified RFQ has `description = "excessAgent stock RFQ 2026-05-11"`. Examples by search key: `1133993`, `1133994`, `1133996`, `1133997`, `1133998`, `1133999`, `1134000`, `1134001`, `1134003`, `1134004`, `1134006`, `1134008`, `1134009`, `1134010`, `1134011`, `1134012`.
    - **Examples of (still bad but distinguishable) 5/6 format:** `MT47H128M16RT-25E:C 2000pcs`, `HUB//6520473-101`, `THS3202DGNR`, `MC79L12ABDR2G`, `IRFB4321PBF`, `FORMIX RFQ 06/05`.
    - **Target format:** `Shenzhen Yudexin — Stock RFQ`, `JSD Electronics — Stock RFQ`, etc. Fallback when no company name is parseable: `<sender-domain> — Stock RFQ` or `Unknown sender — Stock RFQ`. Probably also worth setting `bpname` to the parsed customer string while we're at it.
    - **How (since this is now agent-driven, not script-driven):** The change lives in two places — (a) the `stock-rfq-loading.md` workflow doc, which is the *prompt* the stockrfq-agent reads at every tick (update the fallback-path section to explicitly tell the agent to set `Description = "<best-effort customerName> — Stock RFQ"` and `BPName = customerName` when falling back to BP 1006505), and (b) double-check `shared/rfq-writer.js` or wherever the agent posts via `apiPost('chuboe_rfq', …)` to confirm it doesn't override the description. Start with the .md — agentic workflows are configured by their .md, not by code. Once shipped, verify against the next tick: any new BP-1006505 RFQ should have a populated company-name description, not the uniform agent-stamp.
    - **Scope clarification:** apply to *all* RFQs (matched and unmatched) — the matched-BP ones currently also get the uniform agent stamp, which is just as unhelpful. For matched BPs the description can be `<bp.name> — Stock RFQ` or just `Stock RFQ` (bp.name is on the FK already). Operator said "for unqualified rfqs" but the same regression hits matched BPs — flag this when implementing.
  - **Reference:** Today's monitoring session (2026-05-11) captured DB query results showing: Stock RFQ pipeline healthy post-5/7 partner-lookup employee-filter fix (commit `2e9485f`); 0 employee-BP attributions on 5/7–5/8 across 140 RFQs; Customer Excess was a silent co-victim of the same employee-BP bug (17 of 22 offers on 5/4–5/5 were employee BPs, all deactivated; shared module fix swept both). Monitoring loop continues in the other terminal — alerts on employee BPs, NeedsReview/NeedsPartner spikes, or errors > 0.
  - **Source:** 2026-05-11 monitoring + design discussion.
-->

- [ ] 🟡 **Customer Excess — `chuboe_offer` has no internal-owner field (schema gap)** *(surfaced 2026-05-18 during loader-parity audit)*
  - **What's missing:** `chuboe_offer` exposes the EXTERNAL counterparty (`c_bpartner_id` = the customer) but has no column for the INTERNAL Astute operator-on-record. The other three loaders (RFQ Loading, Stock RFQ, VQ Loading) all have an owner field (`SalesRep_ID` / `AD_User_ID` / `chuboe_buyer_id`) and the agents now stamp it via the internal-forward-chain rule — Customer Excess can't do the equivalent because the column doesn't exist.
  - **Why it matters:** When a support staffer forwards a customer's excess offer to `excess@` on behalf of a specific seller, that ownership is currently lost — operationally we don't know which Astute person should follow up.
  - **Why parked:** Schema change requires Chuck's involvement (column add on `chuboe_offer` + writer payload extension + UI surfacing). Not blocking — the 5/18 loader-parity bundle covered everything actionable without it.
  - **Ready when:** Operator opens the conversation with Chuck. Suggested column name: `chuboe_sales_rep_id` or `chuboe_owner_user_id` (mirror whichever convention already exists on related tables). Once shipped, update `shared/offer-writeback.js` + `shared/workflow-actions/excess.js` + `customer-excess-analysis.md` to populate it from the same Tier A/B/C/D ladder the other three loaders use (see `shared/partner-matching.md` § Astute Employee Resolution).
  - **Source:** 2026-05-18 loader-parity audit — three loaders updated to use the new forwarder-vs-owner rule; excess is the lone gap.

- [ ] 🅿️ **Marvell carryover — should we be tracking incoming lot bids at all?** *(unaddressed business question)*
  - **Why parked:** Surfaced 2026-05-07 while debugging the 5/4 inventory-cleanup partial. The `Incoming Lot bid from Marvell` slot in `STATIC_CARRYOVER_OFFERS` was originally seeded with bootstrap offer 1024030 (created 2025-07-17, BP=Astute Electronics Inc, OfferType=Stock-Philippines). The header was **never populated** — 0 active lines, 0 inactive lines, *ever*. The weekly refresh has been silently "leaving as-is" for 10 months. Today (5/7) we removed the entry from `STATIC_CARRYOVER_OFFERS` so the script stops touching dead config, but **the underlying business question hasn't been addressed**: does Astute actually win Marvell lot bids that need carryover treatment (i.e. stock committed to but not yet in Infor)? If yes, the workflow for seeding the carryover when a bid is won has never been documented or used. If no, this whole slot was speculative and can stay deleted.
  - **Ready when:** Operator decides — needs a real conversation with whoever bids on Marvell lots (Ivy Chew is the recurring Marvell contact in OT; multiple `Contact Ivy Chew` offers exist).
  - **How:** Confirm whether incoming Marvell lot tracking is a real need. If yes: (1) document the manual seed workflow (when a bid is won, create the first `[Carryover] Incoming Lot bid from Marvell — bootstrapped <date>` offer with the won lines, populated under the Astute internal BP / Stock-Philippines OfferType; the chain self-sustains from there), (2) re-add the entry to `STATIC_CARRYOVER_OFFERS` pointing the bootstrapId at that fresh seed offer, (3) deactivate the orphan empty 1024030. If no: leave 1024030 inactive and consider deactivating it for OT tidiness.
  - **Created / source:** 2026-05-07 inventory-cleanup retry session.

- [ ] 🟢 **Customer Excess NeedsReview backlog cleanup** — pre-screen the 27 stuck items before tomorrow's 11:00 UTC digest fires
  - **Why blocked:** Operator EOD 5/5. New persistent Section 4 (commit `e51a2bb`) will surface all 27 NeedsReview + 3 NeedsPartner items; several are stale from April 24-29.
  - **Ready when:** Next session, ideally before 11:00 UTC tomorrow so the cleaned queue lands in the first digest.
  - **How:** For each UID in `excess@` NeedsReview folder, fetch the body + attachments, classify as (a) parseable but parser missed it → recommend `LINES:` w/ structured data, (b) genuine junk / no extractable lines → recommend `IGNORE:`, (c) needs operator eyeballs. Output a single triage table for operator one-shot reply.
  - **Optional cosmetic follow-up:** "From" column in Section 4 shows `@` for IMAP-envelope rows because env.from header is empty on these forwards. Fix would parse body From: header instead. Low priority — flag if operator wants it.
  - **Created / source:** 5/5 EOD, deferred from Customer Excess Digest persistence work (commit `e51a2bb`).

- [ ] 🟢 **Inventory Recommended Resale — pilot mechanics build**
  - **Why blocked:** Operator EOD 5/5. First analysis pass run + emailed; design doc updated with all 5/5 clarifications; commit `2633d95` landed. Resale-write loop + RFQ-cycle plumbing not yet built.
  - **Ready when:** Next session (or when operator reviews the 5/5 emailed report and wants to act on it).
  - **How — remaining build work:**
    1. **Investigate NetComponents export hook** in `Trading Analysis/Inventory File Cleanup/inventory_cleanup.js` — find the masking touchpoint (only needed for broker-validate lines per 5/5 clarification, NOT for API enrichment)
    2. **Build selection query** for LAM Dead (priority queue + round-robin, oldest-resale-first)
    3. **Build per-(warehouse, ISO week) RFQ create/append helper** using `shared/rfq-writer.js`
    4. **Pick internal BP** for self-sourcing RFQs (existing or create)
    5. **Decide Monday-reload survival**: option A (re-apply on load in `inventory_cleanup.js`) vs option B (re-price after load)
    6. **`ad_field`/`ad_tab` check** to verify `apl_offer_recommendedresale` is surfaced anywhere in OT's UI before investing in writes
    7. **Cost source for non-LAM warehouses** (Free Stock / non-LAM consignment) — TBD; LAM Dead path is clear
  - **Decisions locked across 5/4 + 5/5:**
    - 1,500 lines/week TOTAL across all warehouses (3 cycles × 500). One RFQ per (warehouse, ISO week), `Stock` type, desc `"Inventory Pricing Warehouse {WHID} Week {WW}"`. Append cycles 2/3 onto same RFQ.
    - Bucket framework: 🟢 broker_validate (≥ cost × **2.0**), 🟡 default_markup (1–2× → cost × 1.15), 🔴 underwater (< 1× → 1.15 + stuck flag), ⚪ no_coverage (zero franchise stock → broker_validate as scarcity).
    - Delisting from NetComponents is **broker-RFQ only**, NOT API enrichment (key architectural refinement 5/5).
    - LAM Dead cost source = `Lam_Kitting_DB_03132026.xlsx` INVENTORY sheet, `Base Unit Price` column.
    - Restricted MFR display masking BYPASSED on LAM Dead (we're seller); still applies to priority-refresh trigger.
    - DC = annotation only; outside ~3-4 yr suppresses broker_validate.
    - Build order: LAM Dead (pilot) → GM (19) → free stock + smaller consignment → GE Consignment (last).
    - Priority refresh queue-jump: Memory Tier A (Micron/Samsung/SK Hynix), Hot (≥3 RFQ lines/30d), Obsolete (2+ API agreement, advisory only), Long Lead (≥26wk), Restricted MFRs.
    - Exclude LAM Kitting Inventory offer type 1000025 (one-off).
  - **5/5 first analysis pass:** ~907 lines analyzed (59 GM + 848 LAM). Email subject `"Inventory Upside-Down Analysis (corrected) — GM + LAM Kitting — 2026-05-05"` is the canonical output; the earlier `"...— GM + LAM SIPOC..."` subject was wrong-cost-source — disregard the LAM section.
  - **Reference:** `Trading Analysis/Inventory Recommended Resale/inventory-recommended-resale.md` is the source of truth; `run-upside-down.js` is the analysis runner (re-runnable with current inputs to refresh).
  - **Source:** 2026-05-04 design session + 2026-05-05 clarification + first run.

- [ ] 🅿️ **Mouser auth-failure root-cause — RESOLVED 2026-05-06**
  - **Why parked:** Root cause confirmed via diagnostic log — Mouser uses HTTP 403 with `ResourceKey=MaxCallPerMinute` for per-minute rate limiting (~30 calls/min). NOT a daily quota, NOT a key issue. We were bursting through the per-minute window via parallel processes.
  - **Ready when:** Watch for ~1 week. If `~/workspace/.api-failures.ndjson` shows zero Mouser failures, close. If failures persist, may need to lower the throttle cap (currently 25/min).
  - **What we already learned (5/6):**
    - Live API key in `.env` (`d73312c1...`) is healthy — 5/5 manual probes returned 200.
    - Mouser does NOT return 401/403 for bad-key-format — they return `200 OK` with `Errors[0].Message="Invalid unique identifier"` in the JSON body. So whatever is tripping our 401/403 branch is a different failure mode (real auth signal, not "we sent a wrong key").
    - Failure days correlate with high-volume days BUT other distys (TTI/Arrow/Newark/Future/Waldom) hit 2-3× Mouser's volume on the same days without alerting, so the simple "1000/day quota" theory is weak.
    - The "1000/day quota" figure is unverified — Mouser's official docs are auth-walled. The number comes from a third-party Go library + our own cog comment.
  - **What's already shipped (5/6):**
    - **Diagnostic logging in `mouser.js`** — every non-200 appends to `~/workspace/.mouser-failures.ndjson` with status code, 7 quota-header variants, body. Status code split for 401 vs 403 in error messages.
    - **Centralized retry policy** (`shared/api-retry-policy.js` + `shared/franchise-api.js`) — every cog (all 10) now retries transient failures via Bucket A. **Important:** discovered today that the existing per-cog retry logic in mouser.js + digikey.js was silently no-op'd by a JSDoc parse bug in `shared/api-queue.js` (line 35 had `*/30` cron syntax inside `/**...*/` block — `*/` closed the comment prematurely). Fixed. Every transient failure across every cog has been silently dropped since the file was written.
    - **Option A on alerter** (`shared/auth-failure-alerts.js`) — sustained-clean window (4h) before recovery declared, min-outage gate (30 min) before recovery email sent. Stops the alert/recovery email ping-pong that motivated the original mute.
    - **Wrapper-level failure log** (`~/workspace/.api-failures.ndjson`) — lighter-weight than the Mouser-specific log; covers all cogs.
    - **Rolling 24h health digest** in enrich-poller's existing 11/16/20 UTC digest — shows per-disty failure counts + categories + state.
  - **How — actual root-cause investigation when failures land:**
    1. `cat ~/workspace/.mouser-failures.ndjson` — look at status code + headers on real failures. If 403, look for `x-quota-*` or `retry-after` headers.
    2. If status code is 403 with a quota header → confirmed quota issue → either upgrade Mouser plan or add per-disty throttle on our side.
    3. If status code is 401 → real auth issue → check Mouser dev portal for key state, IP whitelist requirements.
    4. If status code is something unexpected → inspect Mouser docs (logged in via portal) for that code's meaning.
  - **How — lift the mute (after root cause known OR if operator wants to risk-accept):**
    1. Edit `shared/data/auth-failure-state.json` → remove `mouser` block (or set `suppressed: false`).
    2. With Option A live, even if Mouser flaps the alerter will only email on the FIRST failure of each outage and won't send a recovery email for outages < 30 min.
  - **Reference:** Today's chat session; `shared/auth-failure-alerts.js`, `shared/api-retry-policy.js`, `shared/franchise-api.js`, `Trading Analysis/RFQ Sourcing/franchise_check/mouser.js`.
  - **Source:** 2026-05-05 EOD operator request → 2026-05-06 build session.

- [ ] 🟢 **Cross-Ref Review Queue Phase 3 — inbox wiring + expiry cron + trust-build retirement** *(scoped 2026-05-13)*
  - **Why blocked:** Phase 2 reply parser is shaped as a standard `workflow-action` (`shared/workflow-actions/crossref-review.js` exports `inbox`/`notifierConfig`/`actions`) but isn't connected to the live email-workflow-poller yet. Operator approves via CLI in the meantime. Two adjacent gaps also worth closing in Phase 3.
  - **Ready when:** Next session — no upstream dependencies.
  - **Three pieces:**
    1. **Inbox wiring** (the main piece). Add a subject-filter rule on `stockRFQ@orangetsunami.com` (or pick a dedicated folder) so digest/Vortex replies route to the crossref-review action. The handler already exists — this is `email-workflow-poller.js` config + folder setup + `/schedule` routine creation. Pattern reference: `shared/workflow-actions/excess.js` + the excess-poller routine. Plan: pick the folder name (`CrossRef` is the natural fit), add to `cron-jobs.js` registry with the Resilience Checklist printed, install via `install-crons.js --apply`.
    2. **Expiry sweep cron.** `crossref-queue.expireOldCandidates(30)` exists but isn't scheduled. Add a daily 6am UTC entry to `cron-jobs.js` invoking a small CLI wrapper (`scripts/sweep-crossref-queue.js`) that calls `expireOldCandidates()` and logs counts. Resilience: idempotent (re-running same day is a no-op), no OT dependency.
    3. **Trust-build retirement.** Phase 2's Vortex tab currently shows auto-approved rows alongside pending so buyers see what the classifier did. After ~1 month of stable behavior, drop the auto-approved bucket from the visible tab (still counted in the email body summary). Implementation: env flag `CROSSREF_VORTEX_SHOW_AUTO_APPROVED=false` (default `true`); set to false when ready. Or: hard-code the date cutoff. Both fine.
  - **Acceptance criteria:**
    - Operator can reply to a digest or Vortex email and have approvals process automatically within the next poll cycle (matches existing 30-min cadence for inbox-driven workflows)
    - Pending candidates >30d old transition to `expired` status without manual intervention
    - When trust-build retirement fires, the Vortex tab shows only pending rows; the email body still surfaces the auto-approved count for context
  - **Source:** 2026-05-13 Cross-Ref Queue build, deferred from Phase 2 to keep the V1 scope tight.

- [ ] ⏸️ **Eaton carryover offer 1026049 — PATCH targeted lines after Jake's decisions**
  - **Why blocked:** Awaiting Jake's retire/update decisions on the 8 MPNs with sales activity (13 lines). Email sent 4/21 "Eaton Carryover — 8 MPNs with sales activity (carry × sold × Infor W117)".
  - **Ready when:** Jake replies with retire/update calls per MPN.
  - **How:** PATCH targeted lines on offer 1026049. Retire → `IsActive=N`. Update → PATCH `Qty` to current Infor W117 qty. Use `shared/record-updater.js::patchRecord`. No generalized Stage-2 logic (Jake maintains clean going forward).
  - **Categorization from the email:**
    - Clean retire: `ADR5041ARTZ-REEL7`, `LIS3DHTR`, `SX1509BIULTRT`
    - Clean update-to-Infor: `500X14N101MV4T`, `PMV450ENEAR`
    - Need eyes: `BLM15PD121SN1D` (200K-sold-vs-48K-carry), `C1608X5R1A106K080AC` (89K gap), `PBO-3C-5` (5.8K gap)
  - **Reference files:** `Trading Analysis/Inventory File Cleanup/eaton_audit.js` (audit builder — joins carryover × W117 × sales orders × tracking), `/tmp/eaton_carryover_2026-04-20.csv` + `/tmp/eaton_carryover_audit_2026-04-21.xlsx` (may not survive restart — re-run `node eaton_audit.js` to regenerate).
  - **Schema notes (learned during session):** `chuboe_warehouse_id` enum — 1000000=ALLOC/PRESOLD, 1000006=UNALLOC/STRANDED, 1000017=SPEC BUY, 1000018=W117 Eaton. Warehouse tagging on c_order is inconsistent (LIS3DHTR tagged SPEC BUY despite being Eaton stock). On sales view: `qtyentered` is real sold qty (qtyordered often 0); tracking-# alone isn't reliable for "shipped" (LIS3DHTR shipped without tracking).
  - **Stage-1 reconciliation code is inert:** attempted in `inventory_cleanup.js` then partially reverted. `pairedWarehouses` removed from STATIC_CARRYOVER_OFFERS; `reconcileCarryover()` helper + keptLines plumbing still present but short-circuits when pairedWarehouses is undefined. Safe to leave, not generalized.
  - **Source:** 2026-04-21 Eaton carryover session.

- [ ] 🟢 **Catch up on uncommitted backlog — pickup 2026-05-06 in buckets** — daily reminder until done
  - **Why blocked:** Multi-week unpushed work across many workstreams. Operator wants to commit in focused buckets, not one mega-commit, so each commit's diff is reviewable.
  - **Ready when:** Next session (2026-05-06). Operator explicitly asked to schedule continuation today (5/5). Surface this entry every session greeting until checklist clears.
  - **Recommended bucket strategy** (run `git status` first to confirm current state — backlog churns daily):
     1. **shared/ infrastructure first** — these are dependencies for the workflow folders. Review modified `shared/*.js` + new `shared/{breadcrumbs,cq-patcher,cq-sold-validator,feedback-overrides,hts-api,junk-classifier,load-bulk-summary,lockfile,offer-poller,offer-router,pdf-extract}.js`
     2. **CLAUDE.md + cron-jobs.js + scripts/install-crons.js + package.json/lock** — config infrastructure changes
     3. **One workflow folder per commit** so reverts are scoped: LAM EPG Award (largest — ~40 scripts), Customer Excess Analysis (new), Inventory Recommended Resale (new — pre-pilot per memory 5/4), AMAT RFQ Management (paused workflow), Request to Ship (new)
     4. **Workflow doc updates batched per workflow** with their code commit (rfq-loading.md, vq-loading.md, market-offer-loading.md, etc. travel with the workflow they describe)
     5. **One-offs / scratch / .gitignore candidates last**: `_fetch_1154.js`, `Trading Analysis/architecture-diagram-v2.html`, `rfq-lifecycle-interactive.html`, `shared/scratch/`, `Trading Analysis/Stock RFQ Loading/scratch/`. Decide gitignore vs commit case-by-case.
  - **How — checklist:**
    - [x] **Phase 1 commit + push** — `a5a5052` 2026-04-29: timeout + neg-cache + race fixes (17 files, +1516/-33). See commit body for the 6-bug list.
    - [ ] **Install probe-sampler cron** — `0 2 * * *  /usr/bin/node /home/analytics_user/workspace/scripts/probe-sampler.js >> /tmp/probe-sampler.log 2>&1`. Update `astute-workinstructions/crontab.md`.
    - [ ] **Install linecard-refresh cron** — `0 3 1 * *  /usr/bin/node /home/analytics_user/workspace/scripts/linecard-refresh.js >> /tmp/linecard-refresh.log 2>&1`. Update `crontab.md`.
    - [ ] **Decide shadow-mode for neg-cache** — currently serves hot (no shadow). Defensible to skip given 160K preseeded entries from trusted historical cache. Operator call.
    - [ ] **Backfill 20 truly-missed 4/13 RFQs** — priority order:
       - 🔴 1132316 Univ. Avionics EOL/LTB (33 lines, 41 MPNs, 0 VQs cold)
       - 🔴 1132317 RTX EOL/LTB (9 lines, 9 MPNs, 0 VQs cold)
       - 🟠 1132303 Sanmina Shortage (34 lines, 116 MPNs, 358 human VQs no franchise check)
       - 🟡 1132319 Honeywell Shortage (4 MPNs cold), 1132305 Advantech (3 cold), 1132315/1132338 GD (1 each cold), 1132312 Plexus PPV (2 cold), 1132336/1132337 Unqualified Broker Stock (5 total cold)
       - ⚪ 11 more with broker quotes already in (Bharat, Plexus, Foxconn, Netapp, GD, SFO, Astute internal, etc.)
       - Run via: `node "Trading Analysis/RFQ API Enrichment/enrich-rfq.js" --rfq <num>` per RFQ. Most should hit cache from the 4/15 burst.
    - [ ] **Triage remaining backlog into focused commits (refresh `git status` first — backlog churns daily):**
       - **DONE 5/5 (`df2a7e8`):** LAM Kitting customer-offer Step 4c (`lam-kitting-customer-offer.js` new + `lam-kitting-runner.js` modified). LAM Kitting Reorder doc was committed earlier 5/5 by operator (`5f110e5`).
       - LAM EPG Award workstream (~40 new scripts: `load-*.js`, `post-*.js`, `update-sipoc-*.js`, PDFs, action-items.md)
       - LAM Kitting Reorder remaining: `lam-kitting-source.js` modified (review then commit)
       - AMAT RFQ Management new workflow folder (currently paused at IT enablement)
       - Customer Excess Analysis (new workflow folder, untracked)
       - Inventory Recommended Resale (new workflow folder, pre-pilot per memory 5/4)
       - Stock RFQ Loading + Vortex updates (`stock-rfq-runner.js`, `vortex-matches.js`, `vortex-poller.js`)
       - Quick Quote 1132324 Honeywell scripts (`qq_1132324.{sql,_full.js,_mfr_audit.js}`)
       - Market Offer Loading: `excess-poller.js`, `run-poller.js`, `smoke-test-spine.js` (untracked) + `mfr-aliases.json`, `market-offer-loading.md` (modified)
       - shared/ refactors: `cq-patcher.js`, `cq-sold-validator.js`, `hts-api.js`, `load-bulk-summary.js`, `breadcrumbs.js`, `feedback-overrides.js`, `junk-classifier.js`, `lockfile.js`, `offer-poller.js`, `offer-router.js`, `pdf-extract.js`, `data/hts-cache.json`
       - franchise_check/main.js refactor (extractStockAndLtRows centralization, 4/9 architectural guidance)
       - Inventory File Cleanup: `bootstrap_gm_carryover.js` (new) + `inventory_cleanup.js` edits + `inventory-file-cleanup.md` doc
       - HTS ECCN Backfill: `hts-eccn-backfill.js` modified
       - Several .md doc updates (rfq-loading.md, vq-loading.md, sourcing-roadmap.md, template-candidates.md, trading-analysis-roadmap.md, lam-epg-escalation-table.md)
       - email-fetcher.js, api-pause.js, cq-writer.js, r-request-writer.js, vq-patcher.js, vq-purchase-validator.js, partner-lookup.js, db-helpers.js, cron-sentinel.js, api-writeback.md (modified)
       - cron-jobs.js + scripts/install-crons.js + package.json/lock + CLAUDE.md (modified — infrastructure)
       - Workflow `Trading Analysis/Request to Ship/` (entire untracked folder — new workflow?)
       - `_fetch_1154.js`, `scripts/vq-enrichment-roi-tracker.js`, `Trading Analysis/RFQ Sourcing/vq_loading/load-bulk-summary-cli.js` + sessions, `rfq-loading-poller.js`, `Trading Analysis/RFQ Loading/load_amat_2026_04_29.js` (untracked)
       - One-offs / probable .gitignore candidates: `Trading Analysis/architecture-diagram-v2.html`, `rfq-lifecycle-interactive.html`, `shared/scratch/`, `Trading Analysis/Stock RFQ Loading/scratch/`
  - **Already done (no work needed):** Phase 1 bugs all coded + tested live. Mouser env var fix shipped. Auth-failure alerter live with 24h debounce across all 10 distys. Verified-send fallback live. 160K-entry neg-cache preseeded. 4 linecards seeded (DigiKey/Mouser/TTI/Rutronik). DigiKey searchOptions parser fix + Layer 1 scope guard already committed earlier (`a82edbf`, `d74575e`).
  - **Punted (don't redo):** Arrow/Future/Newark/Waldom/Sager linecard scrapers (no manufacturer API; rely on probe sampler + 180d TTL). Layer 3 pre-flight audit email.
  - **Reference:** Commit `a5a5052`. MEMORY.md Recent Sessions → "Franchise API negative-cache + drift infrastructure (4/20-21)".
  - **Source:** 2026-04-29 session — bug-fix Phase 1 commit identified the broader backlog.

- [ ] 🟢 **Honeywell RFQ — replicate JCI 1132586 playbook (franchise shadow + Vortex)**
  - **Why blocked:** Operator picking this up next session. Same pattern as JCI 1132586 (4/16-17).
  - **Ready when:** Next session. Operator will provide the Honeywell RFQ number.
  - **How:** Repeat the JCI playbook end-to-end:
    1. **Look up the target RFQ** — get chuboe_rfq_id from search_key: `SELECT chuboe_rfq_id, c_bpartner_id, chuboe_rfq_type_id, salesrep_id, chuboe_user_id FROM adempiere.chuboe_rfq WHERE value = '<number>'`. Capture all five fields verbatim.
    2. **Create shadow RFQ** — adapt `~/workspace/mirror-rfq-1132586.js` (change `ORIGINAL_RFQ_ID` + `SHADOW_HEADER` fields to match Honeywell). Keep the description prefix "API Enrichment Mirror of {N} — DO NOT QUOTE" so buyers can't mistake it for live.
    3. **Run mirror** — `node ~/workspace/mirror-rfq-<N>.js` — writes header + all lines + all MPNs. Shadow search_key printed at end.
    4. **DigiKey quota check BEFORE enrichment** — `node -e "require('dotenv').config({path:'/home/analytics_user/workspace/.env'});require('...digikey').getAccessToken().then(t=>{...})"` — make sure we have headroom for the MPN count. JCI hit 100% 429s because of the 4/15 stock RFQ backlog burning the 1,000/day limit. May need to run overnight after midnight UTC reset.
    5. **Run enrichment** — `node "~/workspace/astute-workinstructions/Trading Analysis/RFQ API Enrichment/enrich-rfq.js" --rfq <shadow-search-key>` — expect ~94 min per 1,500 MPNs. Uses `shared/api-pause` — if `.api-pause` has a stale lock (crashed process / ops review), clear it with `rm ~/workspace/.api-pause`.
    6. **Franchise-only Vortex** — `node "~/workspace/astute-workinstructions/Trading Analysis/Vortex Matches/vortex-matches.js" <ORIGINAL-search-key> --vq-rfq-id <shadow-chuboe_rfq_id> --email`
    7. **Standard Vortex (market picture minus franchise)** — `node ...vortex-matches.js <ORIGINAL-search-key> --exclude-vq-rfq-id <shadow-chuboe_rfq_id> --email`
    8. **Compare** — between franchise-only + standard-minus-franchise, seller gets full market picture with franchise additive value quantified separately.
  - **Reference files from JCI run:** `~/workspace/mirror-rfq-1132586.js` (reusable template), `~/workspace/vortex-shadow-1132593.js` (custom CPC-level savings report), `~/workspace/1132586_Franchise_Vortex.xlsx` (output sample). Full session context in MEMORY.md `## Recent Sessions` entry "JCI RFQ 1132586 franchise shadow analysis + Vortex enhancements (4/16-17)".
  - **Gotchas learned from JCI:**
    - `rfq-writer.js` is 1:1 MPN-per-line; the original RFQ has AVL alternates (multi-MPN per line). The mirror script handles this with a custom worker loop — do NOT try to use `rfq-writer.js` or `rfq-fast-loader.js` directly.
    - `psqlQuery(sql, timeout)` — timeout is a number not an options object. Common trip-up.
    - `notifier.sendEmail()` silently drops `attachments` opt — use `notifier.sendWithAttachment()` for attachments.
    - Loose MPN join explodes due to AVL fan-out — use tight join on exact MPN match within same line.
  - **Source:** Operator asked 2026-04-17 to shift from JCI to Honeywell replication.

- [ ] 🟢 **Stock RFQ 4/15 backlog investigation — 1,154 emails collapsed into 1 Celestica RFQ**
  - **Why blocked:** Needs fresh-session investigation — this context is loaded with JCI/franchise/MFR state.
  - **Ready when:** Next session.
  - **How:** Investigate why the 4/15 stockrfq backlog drain (1,154 emails from `stockRFQ@orangetsunami.com`) resulted in only 4 RFQs created in OT, with 3,625 lines all landing under **Celestica (RFQ 1132405)** — not split by sender/customer as expected. Suspect bug in `stock-rfq-runner.js` partner resolution or email grouping logic. Other 3 RFQs: Astute Group internal (8 lines), Connect Electronics (1 line), Abstract Electronics (1 line) — all tiny, so the Celestica bucket has everything else. Start by reading `scripts/stock-rfq-runner.js` partner matching + grouping, verify against a sample of the source emails in the Processed folder, compare sender domains to the resulting RFQ assignments. Unqualified Broker (1008499) should be the catch-all for unknown senders, not Celestica.
  - **Source:** Surfaced during JCI franchise Vortex session 2026-04-16 when checking DigiKey quota burn — 3,635 unique MPNs loaded on 4/15 blew through the DigiKey 1,000/day limit.

- [ ] 🟢 **Automate Stock RFQ loading end-to-end (jake's pickup for 2026-04-15)**
  - **Why blocked:** Operator deliberately disabled the `stockRFQ@orangetsunami.com` mailbox forwarding rule earlier — wants the full pipeline automated before re-enabling so broker emails go straight from inbox to OT without manual touch.
  - **Ready when:** 2026-04-15 (operator-driven pickup)
  - **How:** End-to-end automation: (1) re-enable mailbox forwarding, (2) extend `vortex-poller`/`enrich-poller` style polling to `stockrfq` himalaya account, (3) wire to existing `RFQ Loading` workflow (`Trading Analysis/RFQ Loading/rfq-loading.md` Stock pipeline) with the new fast-loader (J1) for any volume blasts, (4) auto-categorize sender (known BP via `partner-lookup.js` → matched; unknown → 1008499 Unqualified Broker), (5) Steps 1-13 of rfq-loading.md happen unattended, (6) Processed/NotRFQ/NeedsReview folder routing automatic, (7) summary email to operator. Probably needs a new daemon `scripts/stockrfq-poller.js` modeled on `vortex-poller.js`.
  - **Source:** End of 2026-04-14 session — operator stated this is the focus for tomorrow.

### Investigations

- [ ] 🟢 **`rfq-loader-daemon` — is it actually running / handling non-RFQ mail?** *(surfaced 2026-05-11)*
  - **Why blocked:** Not urgent — operator wants to focus on the OOB task.
  - **Symptom:** OOB email (`rfqloading@` INBOX UID 68, "FW: OOB", Jake → 2026-05-06 11:58 UTC) has been sitting unmoved in INBOX for 5 days while `rfq-loader-daemon` is registered to run every 5 min. Operator also surprised they haven't seen error notifications.
  - **Ready when:** Whenever — anytime operator wants to confirm the daemon is healthy.
  - **How:** (1) `tail -200 /tmp/rfq-loader-daemon.log` (path to verify in `cron-jobs.js`) — check for recent ticks + behavior on UID 68. (2) Read `shared/workflow-actions/rfq-loading.js` — does the handler classify non-RFQ mail and leave-in-INBOX as intended, or move to `NotRFQ` folder like the other workflows? (3) `crontab -l | grep rfq-loader` — confirm cron entry installed. (4) Check `~/workspace/.cron-sentinels/rfq-loader-daemon.json` — last successful run. (5) Check `auth-failure-alerts` or other notifier output for silent failures.
  - **Source:** 2026-05-11 OOB email lookup — operator asked sanity check on whether rfq-loading is automated; cron-jobs.js says yes (every 5m), but the OOB email's been sitting untouched.

- [ ] 🟢 **`synthesizeStockLtVqLines` — verify LT-VQ rows aren't suppressed when stockQty=0** *(surfaced 2026-05-11 ROI coverage-gap investigation, commit `39b543c`)*
  - **Why blocked:** Not urgent — affected the 4 ROI-flagged lines this 30d but they were all transactional RFQs anyway, so no immediate revenue impact. Worth a focused look because if it's a real bug it suppresses LT pricing across the entire enrichment pipeline (every API call that returns 0 stock + valid LT cost).
  - **Symptom (from live probe via `~/workspace/oneoffs/probe-coverage-gaps.js` 2026-05-11):** DigiKey returned `found=true stockQty=0 cost=$1.12` for `FOD8314` and `found=true stockQty=0 cost=$111.71` for `PRM48AF480T400A00`. Both are valid LT-only quotes Claude should be writing as VQ rows. If `synthesizeStockLtVqLines` gates on `stockQty > 0`, those LT-flavor rows never appear.
  - **Ready when:** Whenever bandwidth allows.
  - **How:** (1) Read `shared/franchise-api.js` `synthesizeStockLtVqLines` (≈ line 190). (2) Check whether a non-zero `cost` with `stockQty=0` produces an LT row in the output array. (3) If suppressed, fix to emit one LT-tagged row when `cost` is present, marked with `leadTime` populated and `qty` set to RFQ qty (vs stock qty). (4) Re-probe the 4 MPNs above to confirm LT rows now emit. (5) Affects all consumers of `searchPart` / `searchAllDistributors` — RFQ enrichment, Quick Quote, Vortex Matches, Hurricane.
  - **Reference:** API surface side documented in `astute-workinstructions/api-integration-roadmap.md` § "ROI Tracker Follow-ups" → "LT-VQ suppression check". Probe script preserved at `~/workspace/oneoffs/probe-coverage-gaps.js`.
  - **Source:** 2026-05-11 — investigating ROI tracker "coverage gap" bucket; live API probe revealed the suppression hypothesis.

- [ ] 🅿️ **Verical-via-Arrow API surfacing gap** *(pointer entry — full investigation lives in api-roadmap)*
  - **Why blocked:** Not urgent — 5/11 ROI window confirmed today's "Verical wins" turn out to be transactional RFQs (already-committed orders documented after-the-fact). Real customers sourcing via Verical channel through Arrow IS still a real surfacing gap, just lower priority than originally framed.
  - **Ready when:** When a customer raises a Verical-sourced win that wasn't transactional (= real lost sourcing competition), OR when capacity allows the API investigation.
  - **How:** Full investigation steps live in `astute-workinstructions/api-integration-roadmap.md` § Arrow API → "TODO — Verical channel surfacing gap (open 2026-05-07)". 2026-05-11 ROI probe added a second confirmation case (`Q6004D3RP` for East West Mfg, RFQ 1132985) to the original Sanmina case.
  - **Source:** 2026-05-07 ROI tracker missed-franchise audit; 2026-05-11 ROI window confirmation case added.

- [ ] 🅿️ **NetComponents profile-only spinoff workflow** *(captured 2026-05-11)*
  - **Why parked:** Different intent than existing sourcing workflow — observe-only market intelligence, not active broker RFQ. Operator suggested a separate session to carve out as spinoff.
  - **Ready when:** Operator schedules a dedicated session to spin it up.
  - **What it is:** A variant of `Trading Analysis/RFQ Sourcing/netcomponents/` that **profiles** what's listed in NetComponents US + EMEA channels for given MPNs — does NOT submit RFQs to suppliers, just scrapes the offer landscape and logs placeholder VQs (or a new market-intel record type) for visibility. Goal: see what's out there in the broker channels without consuming RFQ submission budget or generating broker noise.
  - **How (sketch):**
    1. Reuse `netcomponents/node/` Playwright login + search infrastructure
    2. Add a "profile mode" flag that runs MPN search, captures listed offers (qty/price/region/supplier), but skips the RFQ submission step
    3. Filter to US + EMEA region listings (NetComponents has region filters)
    4. Write to a placeholder VQ record type or new market-intel table — needs to be clearly distinguishable from real VQs (the broker quotes we actively pursued + got a response on)
    5. Feeds the Stock RFQ Activity Digest's broker-availability column (currently planned as v2 "Tier-3 broker availability fallback")
    6. Cadence: probably weekly batch on selected MPNs (HOT inbound list from digest? Inventory we hold? Both?)
  - **Tradeoff to flag:** placeholder VQs in `chuboe_vq_line` could confuse downstream consumers (Vortex Matches, Quick Quote) that read VQ history. A separate table or a clear `chuboe_vendortype` (or new IsMarketIntel flag) is probably the right path so real VQs stay clean.
  - **Reference:** Source workflow at `Trading Analysis/RFQ Sourcing/netcomponents/rfq-sourcing-netcomponents.md`. Cross-workflow tie-in: feeds the OEMSecrets-broker fallback in the Stock RFQ Activity Digest (`Trading Analysis/Stock RFQ Loading/stock-rfq-activity-digest.js`).
  - **Source:** 2026-05-11 digest enhancement discussion — operator wants broker-channel visibility separate from active sourcing.

### iDempiere admin / external dependencies

- [ ] ⏸️ **Avnet Product Information API — APIM 404 unblock**
  - **Why blocked:** Roshan Tamrakar provided full endpoint details on 2026-04-29 (`GET https://apigw.avnet.com/external/getDEXFetchProducts?mpn=<MPN>`, header `ocp-apim-subscription-key: 067a6c51a2b04ca3ae39c85fd27f7fe2`). Smoke test 2026-05-07 returns `404 {"statusCode":404,"message":"Resource not found"}` — Azure APIM's "no operation matched" response. Bad/missing keys return the same 404, which means our subscription product has no operation registered at this path; the gateway never even checks our key. Reply sent to Roshan 2026-05-07 asking him to verify subscription entitlement and operation publish status.
  - **Ready when:** Roshan replies with corrected path or confirms the subscription has been re-attached to Product Information.
  - **How:** (1) Re-run smoke test (`node ~/workspace/_avnet_smoke.js`); look for status 200 on a known Avnet-stocked MPN. (2) Build `Trading Analysis/RFQ Sourcing/franchise_check/avnet.js` matching the `tti.js`/`mouser.js` interface — same signature (`getPart(mpn) → {stock, price, leadTime, ...}`). (3) Register in `shared/franchise-api.js` `DISTRIBUTORS` map. (4) Update `api-integration-roadmap.md` § Avnet API status. (5) Once Product Information is live, push back to Alberto Rosales separately for **Product & Pricing** API access (the rejected one — that's the contract-pricing tier; Product Information only returns web resale).
  - **Source:** 2026-05-07 stockRFQ@ inbox forward of Roshan's 4/29 reply; smoke test executed same session.

- [ ] ⏸️ **AMAT Supplier Collaboration Vault 2.0 — IT enablement (Phase 1, Steps 1-2)**
  - **Why blocked:** Operator needs IT support to (a) confirm Astute may automate access to https://myapp.amat.com/Login.html under Applied's supplier ToU, (b) provide the operational AMAT_USER credentials, (c) confirm the 2FA delivery channel (email vs SMS vs Authenticator app). All Phase 2-4 work (scrape modules, RFQ load integration, cron) depends on this.
  - **Ready when:** IT confirms ToU + provides credentials + 2FA channel.
  - **How:** (1) Operator runs `node "Trading Analysis/AMAT RFQ Management/set-creds.js"` to write `AMAT_USER` / `AMAT_PASS` to `~/workspace/.env` silently. (2) Operator runs `node "Trading Analysis/AMAT RFQ Management/login.js"` interactively, pastes 2FA code when prompted. (3) Inspect screenshots at `~/workspace/amat-portal/screenshots/` to confirm we landed on the SCV 2.0 dashboard. (4) Map the SCV 2.0 surfaces (URLs + selectors + page schema) and append to the workflow doc's "SCV 2.0 page map" section. After Phase 1 completes, scope Phase 2 (per-surface scraper modules).
  - **Open questions to resolve in Phase 1:** what RFQ data exactly (list/detail/attachments/ack)? Run cadence (on-demand vs daily)? Output destination (email vs OT writeback via `shared/rfq-writer.js`)? Does Applied have an EDI/API alternative that would replace scraping?
  - **Reference:** `Trading Analysis/AMAT RFQ Management/amat-rfq-management.md` is the source of truth for this workstream.
  - **Source:** 2026-04-28 session — operator scoped the workflow and paused at the IT-dependency boundary.


- [ ] ⏸️ **iDempiere virtual-column unlock for `chuboe_pricing_api_result.Chuboe_JSON_Info_Text`**
  - **Why blocked:** REST API rejects writes to the column with `500: Cannot update virtual column`. Awaiting iDempiere admin to either un-virtualize the existing column or add a new physical text column. Email sent 2026-04-08 to jake.harris@Astutegroup.com for forwarding to the developer.
  - **Ready when:** Developer replies with the column change applied
  - **How:** (1) verify the change with the POST template in `astute-workinstructions/api-integration-roadmap.md` § "Pricing Envelope OT-Native Storage"; (2) re-enable envelope writes in `shared/api-result-writer.js` `writeDb()` (currently in thin-pointer mode); (3) run `flushCacheToDB()` to backfill the local cache into OT
  - **Source:** W1 production smoke test, 2026-04-08

- [ ] ⏸️ **AD_Attachment read access for REST API (Document Explorer retrieval)**
  - **Why blocked:** Tsunami User role (1000004) can't read `AD_Attachment` table — attachments endpoint returns empty even when files exist. Email sent 2026-04-10 to jake.harris@Astutegroup.com for forwarding to Chuck.
  - **Ready when:** Chuck grants read access to `AD_Attachment` for Tsunami User role
  - **How:** (1) Re-run `retrieve-po-copies.js` on PO809585 to verify attachments now return; (2) download all 4 LAM EPG POV copies (POV0075525/29/32/33); (3) document the working pattern in `api-writeback.md` (print endpoint already documented)
  - **Source:** LAM EPG order entry session, 2026-04-10. Script ready at `Trading Analysis/LAM EPG Award/retrieve-po-copies.js`.

- [ ] ⏸️ **GE Aerospace MFR cross-references from Megan Gosselin**
  - **Why blocked:** Customer has not yet provided MFR cross-refs for the GE-internal AML codes that don't resolve in franchise APIs
  - **Ready when:** Megan sends the file
  - **How:** Re-run franchise APIs against the cross-referenced MPNs, re-score, deliver updated analysis. See `MEMORY.md` Recent Sessions entry for the GE Aerospace Consignment Analysis (4/1-4/2)
  - **Source:** GE Aerospace Consignment Analysis workstream

### Decisions / "should we build this"

- [ ] 🅿️ **OEMSecrets API integration**
  - **Why blocked:** Decision pending — worth the rate-limit overhead and additional integration cost?
  - **Ready when:** Whenever bandwidth allows + decision made
  - **How:** Per `astute-workinstructions/api-integration-roadmap.md` § Aggregator APIs section. Would add a 11th distributor with cross-vendor pricing aggregation
  - **Source:** Long-standing roadmap item, surfaced again 2026-04-08 during C9 audit

- [ ] 🅿️ **Arrow compliance endpoint integration (HTS/ECCN/packaging)**
  - **Why blocked:** Decision pending — Arrow's standard search doesn't return any of these fields. A separate compliance endpoint exists but per ongoing experience, Arrow's data quality on classification fields is unreliable. Cost vs benefit unclear.
  - **Ready when:** Either Arrow's data quality improves materially OR Arrow volume grows enough to justify the integration risk
  - **How:** Audit Arrow's compliance API endpoint, probe data quality on a sample, decide. See `sourcing-roadmap.md` C14 § "Why Arrow is Parked" for the existing analysis
  - **Source:** C14 HTS/ECCN audit, 2026-04-08

- [ ] 🅿️ **LLM/API fallback for unknown MPN-MFR prefixes (C15)**
  - **Why blocked:** Premature — expand the prefix table first via the bootstrap mining script, see if coverage is enough before adding LLM call latency + cost
  - **Ready when:** After C15 prefix table expansion proves inadequate, OR when an operator hits a real coverage gap that matters
  - **How:** Add a fallback path in `shared/mpn-mfr-classifier.js` that calls Claude API with `(mpn, "what manufacturer makes this?")` for prefixes that don't match the table. Cache results.
  - **Source:** C15 design doc, 2026-04-08

- [ ] 🅿️ **`shared/business-segments.js` rollout across other bot-activity reports** *(captured 2026-05-11 ROI tracker work, commit `39b543c`)*
  - **Why blocked:** Pull-when-touched is fine — no urgent driver. The shared classifier exists and works in the ROI tracker, but other reports that split LAM / Stock RFQ / Adoption (BOM Monitoring, seller-activity reports, any future scorecard) still inline their own segment logic. Inconsistencies between reports surface only when an operator notices two reports disagreeing.
  - **Ready when:** Next time any cross-segment report is touched for substantive changes — adopt the shared module then.
  - **How:** (1) Open `shared/business-segments.js` — exports `classifySegment(r)`, `isWinningContext(r)`, `SEGMENTS`, `LAM_BP_ID`, `STOCK_RFQ_TYPE_ID`. (2) In each cross-segment report, replace inlined `bp_id === 1000730` / `rfq_type_id === 1000007` checks with imports from the module. (3) Use `SEGMENTS[segment].label` / `.framing` / `.emoji` for display strings so the framing principle (Adoption = winning, LAM/Stock = efficiency) renders consistently. (4) Memory reference: `feedback_roi_framing_winning_vs_efficiency.md`.
  - **Reference:** Cross-cutting note in `astute-workinstructions/api-integration-roadmap.md` § "ROI Tracker Follow-ups". ROI tracker reference implementation in `scripts/vq-enrichment-roi-tracker.js` (commit `39b543c`).
  - **Source:** 2026-05-11 ROI tracker hybrid-approach decision — shared module built so the framing applies consistently, but only the ROI tracker uses it today.

- [ ] 🅿️ **Transactional-window filter as shared utility (`shared/sourcing-window.js`)** *(captured 2026-05-11 ROI tracker work, commit `39b543c`)*
  - **Why blocked:** Only one consumer today (ROI tracker). The `<60min` RFQ→first-sold-CQ check + 1-24hr "needs review" gate live inlined in `scripts/vq-enrichment-roi-tracker.js`. Extract when a second consumer needs it — premature otherwise.
  - **Ready when:** A second report or alert wants to flag "Claude misses" / "won despite tight window" / "salesperson workflow events" and needs the same window classification.
  - **How:** (1) Lift the `classifyWindow(rfqCreated, firstSoldCqCreated)` logic out of `vq-enrichment-roi-tracker.js` (the `isProcessOrder` / `isNeedsReview` / `isRealSourcing` block). (2) Place in `shared/sourcing-window.js` with named exports + the 60-min / 24-hr thresholds as constants. (3) Refactor `vq-enrichment-roi-tracker.js` to import. (4) Memory reference: `feedback_check_window_before_miss_narrative.md` (the rule: any "miss" report must run the window filter first).
  - **Reference:** Cross-cutting note in `astute-workinstructions/api-integration-roadmap.md` § "ROI Tracker Follow-ups". ROI tracker reference implementation in `scripts/vq-enrichment-roi-tracker.js` lines ≈ 585-605 (commit `39b543c`).
  - **Source:** 2026-05-11 ROI tracker — operator's framing principle that customer decisions take hours-to-days; sub-60-min RFQ→sold flows are paperwork, not sourcing events.

- [ ] 🅿️ **Diagnostic envelope retention (lighter cousin of "Pricing Envelope OT-Native Storage")** *(surfaced 2026-05-11)*
  - **Why blocked:** Not urgent — the full Pricing Envelope OT-Native Storage initiative is parked on iDempiere admin config (see `astute-workinstructions/api-integration-roadmap.md` § "Pricing Envelope OT-Native Storage"). This is a lighter scope: capture per-call diagnostic summary (`found`, `stockQty`, `cost`, `error`, `latency_ms`) on the existing thin-pointer row OR in a sibling JSON file so we can answer "why did Claude not surface MPN X on date Y" without live-reprobing the API.
  - **Ready when:** Next time we hit a coverage-gap investigation and have to live-reprobe APIs (today's situation) — pain point would justify the build.
  - **How:** (1) Extend `shared/api-result-writer.js` `writePricingResult` to also write a compact diagnostic summary to `~/workspace/.api-pricing-cache/diagnostics/{YYYY-MM-DD}/{mpn}_{distributor}.jsonl` (append-only NDJSON). One line per call. (2) Fields: `ts, distributor, mpn, qty, found, stockQty, vqPrice, error_msg, latency_ms, http_status`. (3) Retention: rotate weekly; auto-delete after 90 days. (4) Bonus: when ROI tracker flags a "coverage gap" line, the report can grep the diagnostic log and show what the API actually returned at that moment without re-probing.
  - **Reference:** Related but distinct from `api-integration-roadmap.md` § "Pricing Envelope OT-Native Storage" (which is about OT-queryable envelopes, blocked on iDempiere admin) — this is local-disk-only diagnostic retention, no iDempiere dependency. Cross-listed in api-roadmap § "ROI Tracker Follow-ups".
  - **Source:** 2026-05-11 ROI coverage-gap investigation — had to live-reprobe DK/Arrow APIs because thin-pointer rows had no envelope to read back.

- [ ] 🅿️ **Future / Newark deeper packaging inference**
  - **Why blocked:** Both have packaging-adjacent fields (Future's `STDMFR` + `mpq`; Newark's `reeling` + `packSize`) that COULD be combined into a packaging type guess with more inference logic, but the false-positive risk is high and the value is low (these distributors only contribute 8.2% + 7.4% of franchise volume)
  - **Ready when:** Only if packaging coverage gap becomes a real operational problem
  - **How:** Add inference rules in the respective distributor modules. Skip unless something forces it.
  - **Source:** C9a audit, 2026-04-08

- [ ] 🅿️ **LAM reorder: multi-file (Original + EPG + Phase 2) roster with Program column** *(surfaced 2026-05-21)*
  - **Why blocked:** EPG SIPOC and Phase 2 Adds today are scope-expansion / initial-procurement workbooks — they have `SPQ/MOQ`, `Lam Target Initial PO QTY`, `Approved PO Qty`, `12-month RPM usage` columns but **no reorder threshold / MIN QTY**. Steady-state reorder logic has nothing to trigger on. Operator (2026-05-21) plans to request threshold-bearing files from LAM seller for EPG + Phase 2 parts; without those, "include in reorder cron" doesn't have inputs.
  - **Schema spot-read 2026-05-21 (so future-me doesn't redo):**
    - `Lam_Kitting_DB_05082026.xlsx` INVENTORY (964 rows): row 0 = header. Cols Lam P/N|MPN|MFR|Desc|Lead Time|Base Unit Price|Resale Price|**MIN QTY** (H)|**MOQ** (I)|**Buyer** (J)|Notes.
    - `Lam_EPG_SIPOC.xlsx` Sheet1 (208 SKUs): row 0 = metadata/totals junk, **row 1 = header**. CPC|Description|MPN|MFR|Lead time|SPQ/MOQ|Base Unit Price|Total Cost|Resale Price|18% Markup|TOTAL VALUE|Z2 Lowest Price|CQ Median Price|MPN to Purchase|Manufacturer|Source|Purchase Price|Qty|Qty Remaining to Source|… plus execution columns (RFQ Number, POV, Purchased By, PO Sent, Tracking, Qty Received).
    - `Astute_New Part ADDS_ Working Copy - 04222026.xlsx` latest tab `Astute action list 4.14.26` (291 SKUs): row 0 = metadata, **row 1 = header**. Part Number|Description|MPN|MFR|Lam Target Initial PO QTY|MFR SPQ|Lead Time (wks)|Base Unit Price|SPQ/MOQ|Franchise QTY|Lifecycle Status|Astute PO Strategy|Approved PO Qty|Extended Cost|Lam Transfer Qty|PO Placed|… plus `12-month RPM usage` analytical cols.
    - Spot-checked overlap: CPC `644-B57073-024` / MPN `5503-24-1` appears in BOTH EPG SIPOC and Phase 2 Adds, so collisions are real.
  - **Ready when:** Operator receives LAM-provided files (or LAM-confirmed thresholds) for EPG + Phase 2 parts. Could be a new column in EPG SIPOC / Phase 2 Adds OR a separate threshold sheet.
  - **How (when unblocked):** (1) `lam-kitting-reorder.js`: read all 3 files at startup, build a unified roster keyed by MPN. (2) Precedence on collisions: Phase 2 > EPG > Kitting DB (newest scope wins for threshold lookup; rule mirrors the existing contract-price ladder at the top of `lam-3pl.md`). (3) Each row in the reorder CSV gets a new `Program` column with value `Original` / `EPG` / `Phase 2`. (4) Apply same Program tagging to `lam-kitting-customer-offer.js` so the BI dashboard roster picks up EPG + Phase 2 parts that haven't graduated into Kitting DB. (5) Update `lam-3pl.md` Inputs table + ALERT_COLUMNS reference + customer-offer roster description.
  - **Today's behavior (correct):** reorder cron reads Kitting DB only (964 SKUs). EPG (208 SKUs) and Phase 2 (291 SKUs) parts don't get alerts until they're added to Kitting DB INVENTORY tab. Operator confirmed this is the intended hand-off path — parts graduate from EPG/Phase 2 execution into Kitting DB steady-state.
  - **Source:** 2026-05-21 — operator asked whether reorder is reading all 3 files; investigation confirmed it's reading 1 of 3 and EPG/Phase 2 don't carry thresholds.

### Backfills / cleanups

- [ ] 🅿️ **LAM EPG packaging backfill (RFQ 1132040)**
  - **Why blocked:** Decided to defer per operator — too many other things going on right now. Not killed, just parked for visibility.
  - **Ready when:** Whenever bandwidth allows
  - **How:** Re-run packaging normalization on the 140 VQ rows under RFQ 1132040 using the new C9 three-path factory policy + actual qty/spq from each row. Probably 30-40 rows change. Same shape as the HTS/ECCN backfill workflow.
  - **Source:** C9b discovery — old PACKAGING_MAP always returned F-* even on partials, 2026-04-08

- [ ] 🅿️ **C15 self-improving classifier (online counter + auto-promotion)**
  - **Why blocked:** The bootstrap mining script (run-once against history) is shipping in this session. The online learning layer (every text-path resolution feeds a `(prefix, mfr)` counter file; periodic promotion threshold auto-adds to `mpn-prefixes.json`) is the steady-state mechanism. Worth doing as a separate focused workstream rather than bundling with the bootstrap.
  - **Ready when:** Whenever bandwidth allows. After the bootstrap mining has been run at least once and the prefix table has plateaued
  - **How:** (1) Modify `shared/mfr-resolver.js` to record `(prefix, mfr-id)` co-occurrences when the text path resolves successfully — write to `shared/data/mpn-prefix-counters.json`. NEVER count MPN-path resolutions (self-poisoning protection). (2) Build `shared/mpn-prefix-promote.js` script that reads counters, finds pairs ≥50 occurrences with one MFR ≥90%, auto-adds to `mpn-prefixes.json`. (3) Schedule weekly via Claude trigger.
  - **Source:** C15 design discussion, 2026-04-08

- [ ] 🅿️ **Confidence wiring for rfq-writer / offer-writeback / cq-writer**
  - **Why blocked:** vq-writer's `checkMfrConfidence` is path-aware (flags `MFR_LOW_CONFIDENCE` for short-prefix MPN-path matches). The other three writers don't have this check today — they just write whatever the resolver returns. Defensive insurance, not urgent.
  - **Ready when:** If MPN-path low-confidence inferences start producing visible bugs in production
  - **How:** Add the same path-aware check to the three writers' MFR resolution sites. ~10 lines per writer.
  - **Source:** C15 migration, 2026-04-08

### Time-conditional reminders

- [ ] 🟡 **Re-run C15 prefix mining ~3 months after first run**
  - **Why blocked:** Time-conditional. The prefix table benefits from periodic re-mining as new manufacturers ship product and new VQ rows accumulate
  - **Ready when:** ~2026-07-08 (3 months after the bootstrap mining run)
  - **How:** Re-run `astute-workinstructions/scripts/mine-mpn-prefixes.js`, review candidate diff, merge approved entries into `shared/data/mpn-prefixes.json`
  - **Source:** C15 bootstrap, 2026-04-08

- [ ] 🟡 **Bucket 3b accumulation review — distributor integration prioritization** *(time-conditional, set 2026-05-11 ROI tracker work)*
  - **Why blocked:** Self-populating signal — the ROI tracker's "Bucket 3b: No API for this distributor" bucket builds a ranked list over time of franchise/catalog/authorized vendors that win Adoption-segment Real-Sourcing lines but aren't in Claude's API-coverage set. Today (30d window) it shows 2 lines / $2.04 — not actionable. Worth re-checking quarterly to see if any distributor accumulates enough signal to justify API integration work (Heilind, RS, Symmetry are likely candidates per the api-roadmap).
  - **Ready when:** ~2026-08-12 (90 days after the ROI bucket scheme shipped) — check the bucket then. Re-evaluate quarterly thereafter.
  - **How:** (1) Run `node scripts/vq-enrichment-roi-tracker.js --window 90 --dry-run` and grep the log for `noApi=N/$X`. (2) If a single distributor appears repeatedly with material revenue, drop it into `astute-workinstructions/api-integration-roadmap.md` § Franchise Distributor APIs as a "To investigate" entry with the volume evidence. (3) Cross-reference: the bucket is gated to Real Sourcing only, so even small revenue numbers here mean genuine lost competitive sourcing (vs transactional paperwork).
  - **Reference:** `astute-workinstructions/api-integration-roadmap.md` § "ROI Tracker Follow-ups" → "Bucket 3b distributor prioritization signal". ROI tracker logic at `scripts/vq-enrichment-roi-tracker.js` (commit `39b543c`) — see `missNoApi` totals.
  - **Source:** 2026-05-11 ROI tracker bucket scheme rollout — Bucket 3b designed as a self-populating distributor-prioritization signal.

---

## Done (recent — pruned monthly)

- ✅ **Per-Seller VQ Digest: Mimecast blocking emails** *(closed 2026-07-01; opened 2026-06-17)*
  - **Resolution:** Issue self-resolved — emails now delivering successfully to all `@astutegroup.com` recipients. Likely Mimecast whitelist or DMARC propagation delay. Confirmed working: 2026-06-29 (6 sellers, 24 VQs), 2026-06-30 (12 sellers, 309 VQs), 2026-07-01 (12 sellers, 351 VQs). Cron runs daily at `5 10 * * *` (10:05 UTC / 5:05 CT).
  - **Files:** `Trading Analysis/RFQ Sourcing/vq_loading/per-seller-vq-digest.js`, state in `~/.seller-vq-digest-state.json`

- ✅ **vq-loading: agent-prompt rule for "cited RFQ active but zero MPN overlap"** *(closed 2026-06-04; opened 2026-05-25)*
  - **Resolution:** Added `EXCEPTION — Cited RFQ has ZERO MPN overlap` rule to agent-prompt.txt. When cited RFQ has zero overlap with extracted MPNs AND MPN matching finds a clean unique match → trust the MPN match.

- ✅ **Cron resume plan + backfill strategy** *(obsolete 2026-07-01; opened 2026-05-26)*
  - **Resolution:** Crons resumed at some point after 2026-05-26. No pause files exist as of 2026-07-01. Plan was never formally executed but crons are running normally.

- ✅ **2026-05-20 VQ Loading infrastructure batch** *(closed 2026-05-20)*
  - **Items shipped (all same day):**
    - CT time injection via SessionStart hook — `~/.claude/inject-ct-time.sh` + hooks config
    - Continuation-row vendor inference — § 3.7.0b in agent-prompt.txt for price+qty rows inheriting vendor
    - resolveBP fuzzy matching v1+v2 — strict matching ladder + levenshtein typo tolerance (≤2 distance)
    - Local per-VQ attribution log — `.vq-batch-attribution.jsonl` for precise digest reconciliation
    - clarify_buyer action with reply-stitching — sidecar + `bypassRegistryValidation` flag
    - Writer accounting bug fix — `PRE_EXISTING_DUPLICATE` flag, `writtenDetails` in perRfqResults
    - needs_review sidecar for bounce-reply re-attachment — `kind: 'needs_review_bounce'`
    - VQ Loading Daily Digest — production cron at 12:00 UTC
    - VQ buyer-resolution role-registry validation v1 — `shared/data/user-role-registry.json`

- ✅ **Customer Excess — agentic loader triggers router → analysis** *(closed 2026-05-12, commit `1355362`)*
  - **Resolution:** `action_load_offer` now invokes `offerRouter.dispatch()` after each successful `writeOffer`. Backlog cleared for 12 offers (2,406 lines).

- ✅ **Large-RFQ approval gate (full suite)** *(closed 2026-05-13)*
  - **Items shipped:** MVP gate (`shared/large-rfq-gate.js`), cache-aware approval email + `--cache-only` mode (commit `1d9bf4a`), reply-parser integration via rfq-loading workflow agent (commits `c68e346` + `19fda16`).

- ✅ **Loader-parity bundle: VQ Loading agent conversion + Stock RFQ Changes 1/2a/2b + forwarder-vs-owner pattern across 3 loaders** *(closed 2026-05-18; original handoff 2026-05-11)*
  - **VQ Loading agent conversion:** `shared/workflow-actions/vq-loading.js` handler + `vq_loading/agent-prompt.txt` runtime prompt + `vq-loading-agent` cron entry (tiered 5m burst / 15m steady with gate script). Type 1 + Type 2 unified through `loadBulkSummary`; multi-RFQ fan-out via `secondaryRfqSearchKeys[]`; partial-clarify with sidecar reply-stitch. Landed sometime between 5/11 handoff and 5/18 audit.
  - **Stock RFQ Change 1 (decouple franchise enrichment):** moot — quota-protection moved to `enrich-poller` Phase 0.5 large-RFQ gate (`feedback_large_rfq_gate_at_enrichment.md`). No dedicated `enrich-stock-rfqs` cron needed.
  - **Stock RFQ Change 2a (partner-lookup scope `customer` → `customer-or-vendor`):** shipped 5/18. `stock-rfq-loading.md` Step 2 now uses `partnerType: 'any'`; IsEmployee filter preserved (the load-bearing part of the 5/7 fix). `shared/partner-matching.md` updated.
  - **Stock RFQ Change 2b (unqualified-broker description format):** landed sometime between 5/11 handoff and 5/18 — `stock-rfq-loading.md` already requires `customerName` on every load_rfq call; handler stamps `<customerName> — Stock RFQ` on Description and populates BPName.
  - **Forwarder-vs-owner pattern (new):** two helpers added to `shared/partner-lookup.js` — `resolveAstuteUserByEmail` + `resolveAstuteUserByName`. Tiered resolution (internal forward chain → explicit text hint → outer forwarder → default-Jake) codified in Stock RFQ § Step 2.5, RFQ Loading § "Astute Operator Resolution", and VQ Loading § "Buyer Field" + agent-prompt.txt § 3.5. Handles the support-staff-forwards-on-behalf case where outer `@astutegroup.com` → deeper `@astutegroup.com` reveals the actual operator. `rfq-loading.js` handler updated to accept `salesrepId` from payload (was hardcoded to 1000004). Stockrfq + VQ handlers already accepted overrides. Excess deferred (no schema field) — see open entry above.
  - **Memory:** `feedback_forwarder_vs_owner_pattern.md`, updates to `feedback_email_workflows_use_agent_pattern.md`. `shared/partner-matching.md` § "Astute Employee Resolution" is the cross-loader reference.
  - **Original entries:** see commented-out blocks under § "Active workstreams" for the verbatim 5/11 scoping notes — kept for historical context, can be deleted on next prune.

- ✅ **Outbound stock-RFQ quotes → CQs in OT** *(closed 2026-05-12, originally captured 2026-05-11)*
  - **Shipped:** Three commits — `fd5a02e` (hot-patch: inbound agent routes operator replies to new `OutboundPending` folder), `eb21f2e` (full `stockrfq-cq-agent` build: workflow module, agent prompt, cron at `15,45 * * * *`), `d197201` (region + market-context price-check heuristic, integrated into both agents). Live + autonomous since 2026-05-11 ~22:00 UTC.
  - **First autonomous run:** 21:45 UTC 2026-05-11 — picked up 8 outbound replies the inbound tick had just deposited, wrote 7 CQs (mpn-fuzzy or subject match), 0 errors, 0 phantoms. Then 7+ idle ticks overnight.
  - **Cleanup done:** 2 phantom RFQs from morning of 2026-05-11 (`1134115`, `1134116` — SUNCODE + PCG PIC18F14K22T-I/SS dups) deactivated.
  - **Memory:** `feedback_exact_stock_match_brokers.md` refined with region + market-context heuristic (supersedes single-axis framing).
  - **Backlog items spawned:** (1) franchise data into market-context check — heuristic only sees `chuboe_offer` broker market today; (2) heuristic 180d window tuning; (3) multi-MPN RFQ support; (4) K9F2G08U0A inbound miss investigation.
