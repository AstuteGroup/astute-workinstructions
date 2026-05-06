# Leah's BOS Report

Weekly open-order report for Leah Griffin (Business Operations Support Supervisor) and the BOS team. Processes an Infor "AST Open Orders" export into an HTML email + xlsx drill-down covering three operational buckets, aged into three bands, broken out by region / BOS / ISE, with auto-detected signals surfaced at the top.

**Owner:** Leah Griffin (BOS Supervisor) — consumer. Jake Harris — reviewer.
**Cadence:** weekly (and monthly carryover — future).
**Source:** Infor-generated xlsx (manual drop today; watched-folder automation pending Leah's sign-off on format).

---

## Inputs

| Field | Source | Notes |
|---|---|---|
| Open-order export xlsx | Infor "AST Open Orders" canned report | Columns: Name, Order, Customer Order, Customer Order Recorded Date, Internal Salesperson, Line, Item, Due Date, Promise Date, Qty Ordered, Invoiced, CO Buyer, Comments, Customer CSE |
| ISE → region mapping | `ise-regions.json` | Regions: APAC, US, MX, EMEA. Edit & rerun to correct. |

---

## Three Operational Buckets

| Bucket | Definition | What it means |
|---|---|---|
| **1 · Query Date (7/7/2700)** | `Promise Date = 7/7/2700` (Infor sentinel) | BOS has flagged the line for resolution — MPN suffix mismatch, missing CPO, vendor stock lost, bill-to missing, etc. |
| **2 · Placeholder CPO (8/8/2800)** | `Promise Date = 8/8/2800` (Infor sentinel) | Placeholder COV created; awaiting customer PO (CPO). Promise date will update once the CPO arrives. |
| **3 · Past Due** | `Promise Date < today` AND `Qty Ordered > Invoiced` | True overdue lines. Excludes sentinel dates + blanket-order filler (`12/25/2012`). |

## Aging Bands (Past-Due Only)

| Band | Days past | Meaning |
|---|---|---|
| Fresh | 0–7 | Just slipped. Normal operational noise. |
| Stale | 8–30 | Actively overdue. Should be chased this week. |
| Chronic | 30+ | Escalation — needs intervention, not just a follow-up. |

## Regions

Set in `ise-regions.json`. Current values: `APAC`, `US`, `MX`, `EMEA`, `(Unmapped)` (fallback). Add entries to `regions` object keyed by Infor ISE login (`first[:4] + last[:4]` pattern).

---

## Auto-Detected Signals

The script auto-surfaces operational anomalies at the top of the email (and as a dedicated "Signals" xlsx tab). Tuned conservatively so only real signals fire.

| Signal | Fires when | Severity |
|---|---|---|
| **Region bucket-mix skew** | Region has ≥15 flagged lines AND its share of any bucket is ≥10pp above team average | `WATCH` (yellow) |
| **BOS aging outlier** | BOS has ≥10 past-due AND fresh% ≤ (team fresh% − 15pp) | `ALERT` (red) |
| **BOS bucket concentration** | One BOS owns >40% of a bucket with ≥20 lines | `INFO` (blue) |
| **Chronic past-due** | Any line 30+ days past promise | `ALERT` (red) |
| **Unmapped ISEs** | Any flagged line has region=`(Unmapped)` | `INFO` — nudge to update `ise-regions.json` |

Thresholds live in `bos-report.js :: detectSignals()` — adjust there.

---

## Output

### Email (HTML body)
- **Region overview** — counts table + stacked bar chart (all 3 buckets × region)
- **Signals worth watching** — auto-flagged anomalies
- **Per-bucket sections** — each bucket shows: per-BOS bar chart, BOS × ISE stacked bar, per-BOS table
- **Past Due section (enhanced)** — aging strip (Fresh/Stale/Chronic), chronic-line callout table, BOS × aging chart

### Xlsx attachment
`BOS_Metrics_YYYY-MM-DD.xlsx` — multi-tab:

| Tab | Content |
|---|---|
| `All BOS` | Rollup: each BOS's Query / Placeholder / Past-Due (split into Fresh/Stale/Chronic) / Total |
| `Signals` | Auto-detected signal list (severity, title, detail) |
| `By Region` | Region × bucket × aging rollup |
| *(one per BOS)* | Escalation strip · bucket summary · ISE breakdown (region-grouped, aging cols) · embedded charts · per-bucket line detail (past-due sorted by days, row-shaded by aging) |
| `All Query 7-7` | All query-date lines with Region column |
| `All Placeholder 8-8` | All placeholder lines with Region column |
| `All Past Due` | All past-due lines with Region + Days Past + Aging, sorted worst-first, autofilter enabled |
| `Pivot BOS x ISE` | Flat pivot: Bucket · Region · BOS · ISE · Aging · Count |

### Email sender
`stockRFQ@orangetsunami.com` — displayed as "Leah's BOS Report". Default recipient is `leah.griffin@astutegroup.com` (flipped from Jake on 2026-04-28). Default CC is `jake.harris@astutegroup.com` (added 2026-05-06 — Jake stays on the thread to see what Leah sees). Override per-run with `--to` / `--cc`. Use `--no-send` to write the rendered email + xlsx into a `debug/` folder beside the script without dispatching, useful for verifying changes.

---

## Week-over-Week Trends

After every run, the script writes a snapshot to `snapshots/YYYY-MM-DD.json` capturing bucket totals, by-region counts, by-BOS counts, and past-due aging counts. On the next run it loads the most recent prior snapshot (any date < today) and renders deltas:

- **Email body** — a "Movement vs {priorDate}" panel just above the Signals block, showing bucket totals ▲▼, aging shift, top region past-due movers, top BOS past-due movers, and top region placeholder movers. Up arrow (red) = more flagged lines = bad. Down arrow (green) = fewer = good.
- **xlsx `All BOS` tab** — extra `Δ vs {priorDate}` column with red/green cell shading. BOS that fully cleared since last week (prior > 0, current = 0) appear in italics with a green Δ for visibility.
- **xlsx `By Region` tab** — same `Δ vs {priorDate}` column.
- **First run / no prior snapshot** — renders a "Baseline week" block instead of deltas; today's snapshot becomes the baseline for next week.

The snapshot file is committed to git so the trend history persists across operator sessions.

---

## End-to-End Workflow (REQUIRED STEPS)

### Step 1: Receive Infor export

Today: Leah emails the xlsx to Jake / drops it in `rfqloading@orangetsunami.com`. Jake saves it locally (e.g., `~/workspace/.tmp-metrics/Metrics needs.xlsx`).

**Future (pending Leah format sign-off):** a watched folder / inbox pipeline will pick it up automatically.

### Step 2: Verify ISE region mapping is current

Open `ise-regions.json`. If the export contains any new ISE logins (not in the `regions` object), they'll appear as `(Unmapped)` in the output. Add them.

**Do not skip** if adding a new region (e.g., first EMEA hire) — the mapping file must include it or the ISE will fall into `(Unmapped)`.

### Step 3: Run the report

```bash
node "astute-workinstructions/Trading Analysis/Leah's BOS Report/bos-report.js" \
  "/path/to/export.xlsx" \
  [--to someone@astutegroup.com]
```

Defaults to Jake. On success, prints bucket counts, chart fetch count, xlsx size, and `Sent to <email>`.

### Step 4: Review the output

Open the email body. The Signals block at the top summarizes anomalies — read these first. Open the xlsx, scan "All BOS" + "By Region" for the week's shape, drill into per-CSE tabs for anyone flagged.

### Step 5: Correct the mapping if anything is wrong

If an ISE is tagged to the wrong region, edit `ise-regions.json` and rerun Step 3. The mapping file is the single source of truth — do not hardcode region strings in the .js.

### Step 6 (weekly): Email goes to Leah

Default recipient is now `leah.griffin@astutegroup.com` (flipped 2026-04-28) with `jake.harris@astutegroup.com` CC'd by default (added 2026-05-06). Plain `node bos-report.js <file.xlsx>` sends to her with Jake on CC. To redirect to Jake (or anyone else) for ad-hoc tests, pass `--to jake.harris@astutegroup.com`. Pass `--cc ''` to suppress the CC. Use `--no-send` to render to `debug/` without emailing anyone.

### Step 7 (future): Monthly carryover

Leah's second ask: a monthly email showing what hasn't been resolved within the month. This requires snapshot persistence (save each weekly run to `snapshots/YYYY-WW.json`, then diff against the 4-week-old snapshot). Not yet wired.

---

## Known Signals (example, 2026-04-24 run)

| Severity | Signal |
|---|---|
| WATCH | APAC is placeholder-heavy (52% vs 42% team) — sales-side bottleneck |
| WATCH | MX is past-due-heavy (86% vs 47% team) — delivery slippage |
| ALERT | julie.white's past-due is stale-heavy (48% fresh vs 77% team) |
| INFO  | vimal owns 52% of placeholder lines |
| ALERT | 1 chronic past-due line: 192 days, COV0018787 Abaco EXPEDITE FEE |

---

## Future Work

- **Watched-folder automation** — Leah drops the Infor xlsx, cron picks it up, emails out
- **Direct Infor pull** — skip the manual drop if IT opens an ODBC / scheduled-report endpoint (big ask; evaluate once format is stable)
- **Monthly carryover tracking** — line-level snapshot diff (vs. the count-level snapshot we have now), shows which lines have been open 4+ weeks. Reuses the `snapshots/` folder; would extend the JSON shape with per-COV+line entries.
- **Per-CSE emails** — each BOS gets a personal email with just their tab (once Leah wants to push rather than forward)
- **Customer/ISE concentration signals** — "Abaco drives 6 of julie.white's 42 past-due"
- **Signal muting** — acknowledge a signal (e.g., the EXPEDITE FEE) to suppress until resolved

---

## Files

| File | Purpose |
|---|---|
| `bos-report.js` | Main script — reads xlsx, buckets, renders email + xlsx, sends |
| `ise-regions.json` | ISE login → region mapping (source of truth) |
| `snapshots/YYYY-MM-DD.json` | Per-run snapshot (bucket × region × BOS × aging counts) — drives week-over-week deltas. Committed to git. |
| `leahs-bos-report.md` | This doc |

## Dependencies

- `xlsx` (SheetJS) — read Infor export
- `exceljs` — write multi-tab xlsx with embedded chart images
- `quickchart.io` (HTTP) — chart PNG rendering (POST /chart)
- `shared/notifier.js` — SMTP via stockRFQ@orangetsunami.com
