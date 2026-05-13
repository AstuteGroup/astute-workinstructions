# MFR Reconciler

Forward-only daily cron that backfills `Chuboe_MFR_ID` on rows where the manufacturer text is populated but the FK is null.

## What it does

Sweeps three tables (`chuboe_rfq_line_mpn`, `chuboe_vq_line`, `chuboe_cq_line`) for active rows created since the last successful run that have:
- `chuboe_mfr_id IS NULL`
- `chuboe_mfr_text` populated
- `processed = 'N'` (where the column exists — RFQ line MPN doesn't have it)

Resolves each text via the standard `lookupMfr()` chain (alias → cache → DB strict → DB fuzzy), PATCHes the FK when the result is a non-system MFR, sends an email summary.

## Why forward-only

48% of MFR-bearing rows across the system have `chuboe_mfr_id IS NULL` (~2.5M rows). A one-time historical backfill is parked as **J4-backfill** in the trading analysis roadmap — separate ad-hoc weekend script. The forward cron handles new loads as they land so we don't accumulate more debt.

## Skip rules

- **System MFR** (`AD_Client_ID = 0` records like Texas Instruments, Vishay, Bourns) — iDempiere REST rejects system IDs in client tables. Text stays correct, FK stays null. Server-side bean callout resolves at write time on actual workflow operations.
- **Distributor names as MFR** (Arrow, Future, Avnet, Newark, Heilind, etc.) — data-entry error, not a real MFR. Flagged in the email, not patched.
- **Already populated** — `record-updater.patchBatch` `skipIfNotNull` gate prevents re-writes.

## Files

| Path | Purpose |
|------|---------|
| `mfr-reconciler.js` | The daemon |
| `~/workspace/.last-mfr-reconcile` | Watermark file (UTC ISO timestamp of last completion) |
| `~/workspace/.mfr-reconciler.pid` | PID file for single-instance guard |
| `~/workspace/logs/mfr-reconciler/<run-stamp>/` | Per-run audit logs (patched/skipped/error) from `record-updater` |
| `/tmp/mfr-reconciler.log` | Append-only run log (cron stdout/stderr) |

## CLI

```bash
# Normal cron run (uses watermark, writes PATCHes, sends email, advances watermark)
node mfr-reconciler.js

# Dry run — query + resolve, no PATCHes, no email, no watermark update
node mfr-reconciler.js --dry-run

# Override watermark for ad-hoc backfill of a specific window
node mfr-reconciler.js --since '2026-04-13'

# Restrict to one table
node mfr-reconciler.js --table vq_line

# Bypass the api-pause file (for testing during a paused enricher)
node mfr-reconciler.js --ignore-pause
```

## Cron entry

```cron
0 6 * * * /usr/bin/node "/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/MFR Reconciler/mfr-reconciler.js" >> /tmp/mfr-reconciler.log 2>&1
```

Daily 6 AM UTC (= midnight Central). Runs after enricher backlog drain finishes overnight, before US business hours.

## Lifecycle behaviors

- **Single-instance guard:** PID file at `~/workspace/.mfr-reconciler.pid`. If a live PID owns it, the new run exits 0 cleanly. Same pattern as `enrich-poller` and `rfq-loader-daemon`.
- **Pause-file aware:** Respects `~/workspace/.api-pause` (J5 mechanism). Any foreground workflow (LAM 3PL, Stock RFQ pricing, etc.) can yield the reconciler. Use `--ignore-pause` to override.
- **Signal handlers:** SIGINT/SIGTERM release PID and exit cleanly.
- **Watermark only advances on success.** Fatal errors leave watermark untouched so the next run picks up the same window.

## Email summary

Sent to `jake.harris@astutegroup.com` from `rfqloading@orangetsunami.com`. Includes:
- Per-table totals (scanned, patched, skipped-system, skipped-distributor, unresolved-unique-texts, errors)
- Top 20 unresolved MFR texts ranked by frequency (alias candidates)

If a text appears 5+ times across runs and looks like a real manufacturer, add it to `Trading Analysis/Market Offer Loading/mfr-aliases.json` to resolve it on subsequent runs.

## Known constraints

1. **System MFR ceiling.** ~30-40% of resolvable texts map to system-level MFRs we can't write the FK for. Not a bug — it's the iDempiere data model. The text remains correct and downstream `mfr-equivalence` queries work fine.
2. **Resolution speed.** `lookupMfr()` does a per-row `psql` call when there's a cache miss. Wall time scales with unique unresolved text count, not row count. ~60ms per unique text on first encounter, then cached. A daily window with a few thousand rows runs in ~5-10 minutes.
3. **`processed = 'Y'` rows are excluded.** The iDempiere business rule blocks all PATCHes on processed records. Those rows stay NULL until/unless someone reactivates them.

## Related

- `shared/mfr-lookup.js` — resolution chain
- `shared/record-updater.js` — `patchBatch()` with idempotency gate
- `shared/api-pause.js` — pause-file coordination (J5)
- `Trading Analysis/Market Offer Loading/mfr-aliases.json` — alias additions go here
- `Trading Analysis/trading-analysis-roadmap.md` § J4 — design decisions, J4-backfill follow-up
