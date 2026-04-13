# Crontab Reference

Single source of truth for scheduled jobs running under `analytics_user`. Update this file whenever a cron entry is added, changed, or removed. Verify against `crontab -l` periodically.

Last verified: **2026-04-13**

## Environment

```cron
PGUSER=analytics_user
```

Set as a global variable at the top of the crontab. **Required for any job that touches Postgres** because cron does NOT pass `$USER` and libpq has no other way to determine the auth identity for Unix-socket peer auth — without it, every `psql` call (including `pg.Pool` connections that don't pass `user` explicitly AND every `execSync('psql ...')` child process call) fails with `fe_sendauth: no password supplied`.

Discovered the hard way 2026-04-09 evening: enrich-poller cron tick at 17:30 ran successfully but VQ writes were silently degraded because `shared/mfr-lookup.js` (and 4 other shared modules) call `execSync('psql ...')` for MFR resolution and were getting auth failures. Some VQs wrote, most didn't, "0 errors" reported. Fixed in two layers: (1) `PGUSER=analytics_user` at top of crontab, (2) `-U analytics_user` added to every `execSync psql` call in `shared/mfr-lookup.js`, `shared/db-helpers.js`, `shared/market-data.js`, `shared/offer-analyzer.js`, `shared/partner-lookup.js` so they work regardless of cron env.

When adding new cron jobs that touch the DB, neither layer is strictly required (the other one covers you), but having both is the belt-and-suspenders default.

## Active jobs

| Schedule | Job | What it does | Script | Log |
|---|---|---|---|---|
| `0 11 * * 1` | **Inventory Cleanup** | Weekly Mon 11:00 — fetches Infor inventory exports, dedupes, splits by warehouse, generates Chuboe + portal CSVs | `Trading Analysis/Inventory File Cleanup/inventory_cleanup.js` | `/tmp/inventory-cleanup.log` |
| `0 12 * * 1` | **LAM Kitting Reorder** | Weekly Mon 12:00 — runs LAM Kitting reorder analysis (BOM → demand → franchise sourcing) | `Trading Analysis/LAM Kitting Reorder/lam-kitting-runner.js` | `Trading Analysis/LAM Kitting Reorder/data/cron.log` |
| `*/20 * * * *` | **Vortex Matches Poller** | Every 20 min — polls `vortex@orangetsunami.com` inbox for forwarded RFQ emails, runs Vortex Matches (supply-vs-demand match across VQs/offers/stock), emails results back to original requestor + Cc list | `Trading Analysis/Vortex Matches/vortex-poller.js` | `/tmp/vortex-poller.log` |
| `*/30 * * * *` | **API Queue Worker** | Every 30 min — drains Bucket A queue (rate-limited / failed franchise API calls scheduled for retry) | `scripts/process-api-queue.js` | `/tmp/api-queue-worker.log` |
| `*/15 * * * *` | **RFQ API Enrichment Poller** | Every 15 min — polls `chuboe_rfq` for new RFQs since watermark, routes each through all 7 franchise APIs (TTL cache: PPV/Astute Franchised 30d, others 7d), writes VQ lines + thin-pointer audit rows. **Re-enabled 2026-04-09** after A4 dup amplification fixes shipped in commit `3fbd0fb` (writer-layer natural-key check-before-retry + enrich-rfq read-side dedup on `(line_id, mpn_clean, mfr_id)`). Also depends on Arrow / Verical channel split (commit `fa740e9`) and vq-writer Buyer_ID/Packaging_ID null handling (commit `05d03e1`). | `Trading Analysis/RFQ API Enrichment/enrich-poller.js` | `/tmp/enrich-poller.log` |
| `*/5 * * * *` | **RFQ Loader Daemon** | Every 5 min healthcheck — starts daemon if not running, no-ops if alive. Daemon loads queued RFQs concurrently (10 workers, ~20 lines/s), small RFQs (<500 lines) preempt large ones. Queue file: `~/.rfq-load-queue.json`. PID file: `~/.rfq-loader-daemon.pid`. **Added 2026-04-13** as part of J1/J2 fast-loader architecture. | `scripts/rfq-loader-daemon.js` | `/tmp/rfq-loader-daemon.log` |

## Watermark / state files

| File | Owner job | Purpose |
|---|---|---|
| `~/workspace/.last-rfq-enrich` | RFQ API Enrichment Poller | ISO timestamp of last successful poll. First run (no file) processes the last 1 hour. |
| `~/workspace/.rfq-load-queue.json` | RFQ Loader Daemon | Priority queue of RFQ load jobs. Items persist across restarts for resume. |
| `~/workspace/.rfq-loader-daemon.pid` | RFQ Loader Daemon | PID file for single-instance guard. Cron checks this before launching. |

## Operations

```bash
# View current crontab
crontab -l

# Edit crontab interactively
crontab -e

# Tail a single job's log
tail -f /tmp/enrich-poller.log

# Check that all 5 jobs are still installed
crontab -l | grep -c '^[^#]'   # should print 6
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
