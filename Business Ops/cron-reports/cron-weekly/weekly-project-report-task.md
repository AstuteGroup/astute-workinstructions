# Weekly Project Report

The purpose of this task is to generate a weekly summary of git commits grouped by project.

This is important because it provides visibility into work completed each week without manually reviewing git logs.

## Schedule

- **Cron:** Mondays at 9am CT (14:00 UTC)
- **Recipient:** justin.oberhofer@astutegroup.com
- **Author filter:** Justin Oberhofer commits only

## Output

The report groups commits by project and shows:
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
