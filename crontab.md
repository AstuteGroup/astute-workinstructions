# Crontab Reference

Single source of truth for scheduled jobs running under `analytics_user`. Update this file whenever a cron entry is added, changed, or removed. Verify against `crontab -l` periodically.

Last verified: **2026-04-08**

## Active jobs

| Schedule | Job | What it does | Script | Log |
|---|---|---|---|---|
| `0 11 * * 1` | **Inventory Cleanup** | Weekly Mon 11:00 — fetches Infor inventory exports, dedupes, splits by warehouse, generates Chuboe + portal CSVs | `Trading Analysis/Inventory File Cleanup/inventory_cleanup.js` | `/tmp/inventory-cleanup.log` |
| `0 12 * * 1` | **LAM Kitting Reorder** | Weekly Mon 12:00 — runs LAM Kitting reorder analysis (BOM → demand → franchise sourcing) | `Trading Analysis/LAM Kitting Reorder/lam-kitting-runner.js` | `Trading Analysis/LAM Kitting Reorder/data/cron.log` |
| `*/20 * * * *` | **Vortex Matches Poller** | Every 20 min — polls `vortex@orangetsunami.com` inbox for forwarded RFQ emails, runs Vortex Matches (supply-vs-demand match across VQs/offers/stock), emails results back to original requestor + Cc list | `Trading Analysis/Vortex Matches/vortex-poller.js` | `/tmp/vortex-poller.log` |
| `*/30 * * * *` | **API Queue Worker** | Every 30 min — drains Bucket A queue (rate-limited / failed franchise API calls scheduled for retry) | `scripts/process-api-queue.js` | `/tmp/api-queue-worker.log` |
| ~~`*/15 * * * *`~~ **DISABLED 2026-04-08** | **RFQ API Enrichment Poller** | Every 15 min — polls `chuboe_rfq` for new RFQs since watermark, routes each through all 7 franchise APIs (TTL cache: PPV/Astute Franchised 30d, others 7d), writes VQ lines + thin-pointer audit rows. **Disabled pending A4 investigation** — upstream `chuboe_rfq_line_mpn` has duplicate rows on PPV RFQs (Sanmina especially) and the enricher amplifies the dups into VQ writes. See `Trading Analysis/trading-analysis-roadmap.md` § A4. | `Trading Analysis/RFQ API Enrichment/enrich-poller.js` | `/tmp/enrich-poller.log` |

## Watermark / state files

| File | Owner job | Purpose |
|---|---|---|
| `~/workspace/.last-rfq-enrich` | RFQ API Enrichment Poller | ISO timestamp of last successful poll. First run (no file) processes the last 1 hour. |

## Operations

```bash
# View current crontab
crontab -l

# Edit crontab interactively
crontab -e

# Tail a single job's log
tail -f /tmp/enrich-poller.log

# Check that all 5 jobs are still installed
crontab -l | grep -c '^[^#]'   # should print 5
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
