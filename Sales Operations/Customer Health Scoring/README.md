# Customer Health Scoring

**Sales Operations project to proactively identify at-risk customer relationships and prioritize sales efforts for maximum ROI.**

## Project Status
**Phase:** Requirements & Discovery (as of 2026-06-25)

## Outputs (Planned)
1. **Monthly Regional Report** — Regional activity trends (USA, MEX, APAC) for collaboration
2. **Weekly Sales Manager Action List** — Prioritized interventions, high-signal/low-noise

## Documentation
- **`docs/requirements-brainstorm.md`** — Full requirements from discovery session
- **`docs/customer-health-scoring.md`** — Workflow documentation (TBD)
- **`docs/data-exploration.md`** — Database exploration findings (TBD)

## Folder Structure
```
Customer Health Scoring/
├── docs/              # Documentation
├── queries/           # SQL queries for health metrics
├── scripts/           # Report generation scripts
└── output/            # Generated reports
    ├── monthly/       # Monthly regional reports
    └── weekly/        # Weekly manager action lists
```

## Key Principles
- **Markers, not facts** — Data shows patterns; managers know the story
- **ROI focus** — Prioritize sales time on high-potential opportunities
- **No forecasting** — Current state & trends only
- **Context-aware** — Different thresholds for different customer types
- **Iterative** — Build, feedback, refine

## Next Steps
1. Data exploration (region mapping, customer type identification)
2. POC reports with draft thresholds
3. Manager feedback & refinement
4. Automated delivery
