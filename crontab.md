# Crontab Reference

> **NOTE — 2026-05-04:** The source of truth for scheduled jobs is now `cron-jobs.js` (registry) + `scripts/install-crons.js` (installer). The crontab is auto-generated; do not hand-edit. This file is retained for the institutional knowledge below (PGUSER/LOGNAME peer-auth requirements that the installer preserves in the crontab header).
>
> To add or change a scheduled activity, update `cron-jobs.js` and run `node scripts/install-crons.js --apply`. See workspace `CLAUDE.md` § Scheduling New Activities for the required Resilience Checklist flow.

Last verified: **2026-04-15** (pre-registry. Live state: `crontab -l` + `node scripts/check-cron-drift.js`.)

## Environment

```cron
PGUSER=analytics_user
LOGNAME=analytics_user
```

Both set as global variables at the top of the crontab. **Required for any job that touches Postgres** because cron does NOT pass `$USER` or `$LOGNAME`, and Postgres peer auth (over Unix socket) uses `LOGNAME` / `USER` to determine the OS identity before checking `pg_hba.conf`. Without `LOGNAME=analytics_user`, peer auth fails and libpq falls back to requesting a password — which, in non-interactive mode (cron, execSync), becomes `fe_sendauth: no password supplied`.

**`PGUSER` alone is not enough.** `PGUSER` tells libpq which DB role to request, but peer auth's decision to accept vs. ask for password happens based on OS identity. If `LOGNAME` isn't set, libpq thinks it's a different OS user and falls back to password auth.

**Layered defenses in place:**
1. `PGUSER=analytics_user` at top of crontab (DB role request)
2. `LOGNAME=analytics_user` at top of crontab (peer-auth OS identity) — **added 2026-04-14**
3. `-U analytics_user` on every `execSync('psql ...')` call in `shared/mfr-lookup.js`, `shared/db-helpers.js`, `shared/market-data.js`, `shared/offer-analyzer.js`, `shared/partner-lookup.js` (belt-and-suspenders DB role)

**History:**
- **2026-04-09:** Discovered silent VQ write degradation from `fe_sendauth` failures. Added `PGUSER` to crontab + `-U analytics_user` to shared modules. Believed fixed.
- **2026-04-14:** `fe_sendauth` errors reappeared under cron. Root cause was that peer auth needs `LOGNAME` set, which `PGUSER` doesn't provide. Fixed by adding `LOGNAME=analytics_user` to crontab.

When adding new cron jobs that touch the DB, all three layers are belt-and-suspenders; the crontab env vars (1 + 2) cover the common case.

## Active jobs

| Schedule | Job | What it does | Script | Log |
|---|---|---|---|---|
| `0 11 * * 1` | **Inventory Cleanup** | Weekly Mon 11:00 — fetches Infor inventory exports, dedupes, splits by warehouse, generates Chuboe + portal CSVs | `Trading Analysis/Inventory File Cleanup/inventory_cleanup.js` | `/tmp/inventory-cleanup.log` |
| `0 12 * * 1` | **LAM Kitting Reorder** | Weekly Mon 12:00 — runs LAM Kitting reorder analysis (BOM → demand → franchise sourcing) | `Trading Analysis/LAM Kitting Reorder/lam-kitting-runner.js` | `Trading Analysis/LAM Kitting Reorder/data/cron.log` |
| `*/20 * * * *` | **Vortex Matches Poller** | Every 20 min — polls `vortex@orangetsunami.com` inbox for forwarded RFQ emails, runs Vortex Matches (supply-vs-demand match across VQs/offers/stock), emails results back to original requestor + Cc list | `Trading Analysis/Vortex Matches/vortex-poller.js` | `/tmp/vortex-poller.log` |
| `*/30 * * * *` | **API Queue Worker** | Every 30 min — drains Bucket A queue (rate-limited / failed franchise API calls scheduled for retry) | `scripts/process-api-queue.js` | `/tmp/api-queue-worker.log` |
| `*/15 * * * *` | **RFQ API Enrichment Poller** | Every 15 min — polls `chuboe_rfq` for new RFQs since watermark, routes each through all 7 franchise APIs (TTL cache: PPV/Astute Franchised 30d, others 7d), writes VQ lines + thin-pointer audit rows. **Re-enabled 2026-04-09** after A4 dup amplification fixes shipped in commit `3fbd0fb` (writer-layer natural-key check-before-retry + enrich-rfq read-side dedup on `(line_id, mpn_clean, mfr_id)`). Also depends on Arrow / Verical channel split (commit `fa740e9`) and vq-writer Buyer_ID/Packaging_ID null handling (commit `05d03e1`). | `Trading Analysis/RFQ API Enrichment/enrich-poller.js` | `/tmp/enrich-poller.log` |
| `*/5 * * * *` | **RFQ Loader Daemon** | Every 5 min healthcheck — starts daemon if not running, no-ops if alive. Daemon loads queued RFQs concurrently (10 workers, ~20 lines/s), small RFQs (<500 lines) preempt large ones. Queue file: `~/.rfq-load-queue.json`. PID file: `~/.rfq-loader-daemon.pid`. **Added 2026-04-13** as part of J1/J2 fast-loader architecture. | `scripts/rfq-loader-daemon.js` | `/tmp/rfq-loader-daemon.log` |
| `0 6 * * *` | **MFR Reconciler** | Daily 6 AM UTC — backfills `Chuboe_MFR_ID` on rows created since last successful run where text is set but FK is null. Sweeps `chuboe_rfq_line_mpn`, `chuboe_vq_line`, `chuboe_cq_line`. Skips system-MFR rows (REST can't write system IDs to client tables) and distributor-as-MFR data-entry errors. Watermark: `~/.last-mfr-reconcile`. PID file: `~/.mfr-reconciler.pid`. Single-instance + pause-file aware. **Added 2026-04-14** as J4 (forward-only). Historical backfill of ~2.5M legacy rows is parked as J4-backfill in trading roadmap. | `Trading Analysis/MFR Reconciler/mfr-reconciler.js` | `/tmp/mfr-reconciler.log` |
| `0 7 * * 1` | **VQ Enrichment ROI Tracker** | Weekly Mon 7 AM UTC — queries all RFQ lines that received any API-written VQ (`createdby=1049524`) in trailing 30d, joins CQ/SO activity, emails conversion digest: per-customer, per-RFQ-type, direct-win subset. Read-only (no PATCH). **Added 2026-04-15** as J10 — feedback loop on whether enrichment contributes to sales. | `scripts/vq-enrichment-roi-tracker.js` | `/tmp/vq-enrichment-roi.log` |

## Watermark / state files

| File | Owner job | Purpose |
|---|---|---|
| `~/workspace/.last-rfq-enrich` | RFQ API Enrichment Poller | ISO timestamp of last successful poll. First run (no file) processes the last 1 hour. |
| `~/workspace/.rfq-load-queue.json` | RFQ Loader Daemon | Priority queue of RFQ load jobs. Items persist across restarts for resume. |
| `~/workspace/.rfq-loader-daemon.pid` | RFQ Loader Daemon | PID file for single-instance guard. Cron checks this before launching. |
| `~/workspace/.last-mfr-reconcile` | MFR Reconciler | ISO timestamp of last successful run. First run (no file) processes the last 24 hours. |
| `~/workspace/.mfr-reconciler.pid` | MFR Reconciler | PID file for single-instance guard. |

## Operations

```bash
# View current crontab
crontab -l

# Edit crontab interactively
crontab -e

# Tail a single job's log
tail -f /tmp/enrich-poller.log

# Check that all 5 jobs are still installed
crontab -l | grep -c '^[^#]'   # should print 8
```

**Note:** `crontab -l/-e` work fine under `analytics_user`'s `rbash` despite the restricted shell — see `reference_crontab_works_under_rbash.md` in memory.

## Adding a new job

1. Test the script manually first (`node path/to/script.js --dry-run` or equivalent).
2. Confirm log path exists and is writable.
3. Add the entry: `(crontab -l ; echo 'SCHEDULE COMMAND >> LOG 2>&1') | crontab -`
4. Verify with `crontab -l`.
5. **Update this file.** Don't skip — the table is the source of truth, not `crontab -l` output.
6. Commit + push the doc change.

## Removing a job

1. `crontab -e`, delete the line, save.
2. Update this file (remove the row from "Active jobs").
3. Decide whether to retire the script + log file or leave them in place.
4. Commit + push.
