# Weekly Project Report

The purpose of this task is to generate a weekly summary of git commits grouped by project.

This is important because it provides visibility into work completed each week without manually reviewing git logs.

## Schedule

- **Cron:** Fridays at 13:00 UTC (`0 13 * * 5`)
- **Reporting window:** Friday -> Thursday — the run covers the seven days
  ending the day before it fires. A Friday run reports last Friday through
  Thursday; commits made on the Friday it runs land in *next* week's report.
- **Recipient:** justin.oberhofer@astutegroup.com
- **Author filter:** Justin Oberhofer commits only

The window is anchored to the run date, not to a fixed weekday, so a
catch-up run still reports the seven days behind it.

> **Changing the schedule is two edits, not one.** `cadenceCron` in
> `cron-jobs.js` only takes effect after the job next succeeds under the *old*
> schedule — `nextDue` is written solely by `markSuccess()` in
> `shared/cron-sentinel.js`, and `--force` deliberately skips it. After
> changing the cron expression, also rewrite
> `~/workspace/.cron-sentinels/weekly-project-report.json` so `nextDue`
> matches the new schedule, or the job stays on the old cadence for one cycle.

## Output

Subject line: `Weekly Project Report - Week NN` (week number derived from the
window's start date). The report groups commits by project and shows:
- Project name and commit count
- Folder location (e.g., `Business Ops/tsk-inspection-queue-maintenance/`)
- Project description
- Key updates (deduplicated, max 6 per project)

## Manual Execution

```bash
# Preview in console
node "Business Ops/cron-reports/cron-weekly/weekly-project-report.js"

# Send email
node "Business Ops/cron-reports/cron-weekly/weekly-project-report.js" --send
```

## Project Categories

| Project | Folder |
|---------|--------|
| Inspection Queue Maintenance | `Business Ops/tsk-inspection-queue-maintenance/` |
| Tariff Tracker | `Business Ops/tsk-tariff-tracker-extraction/` |
| BOS Metrics | `Business Ops/cron-reports/cron-monthly/` |
| Currency Conversion | `Business Ops/tsk-currency-conversion-upload/` |
| MFR Screening | `Business Ops/tsk-new-mfr-screening/` |
| Excess Processing | `Trading Analysis/Customer Excess Analysis/` |
| VQ Loading | `Trading Analysis/RFQ Sourcing/vq_loading/` |
| RFQ Loading | `Trading Analysis/RFQ Loading/` |
| LAM Kitting | `Trading Analysis/LAM 3PL/` |

## Configuration

To add new project categories, edit `PROJECT_META` in `weekly-project-report.js`.

Tags: #cron #report #weekly
