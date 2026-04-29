# Price Intelligence Dashboard

Standardized part-trend analysis. Pulls VQ + Market Offer + Customer-target history for a given MPN and renders an interactive HTML dashboard matching the original `MT40A1G16TB-062E IT:F` look (Mar 18, 2026 prototype), with the customer-target overlay added from the `MT40A1G8SA-062E IT:E` iteration (Mar 27).

**When to run:** any time someone asks for a "price trend", "price intelligence", or "part trend analysis" on a specific MPN. Replaces ad-hoc CSV-then-script.

---

## Trigger phrases

When the operator says any of the following, run this workflow:

- "price intelligence on \<MPN\>"
- "price trend for \<MPN\>"
- "part trend analysis on \<MPN\>"
- "VQ vs MO history on \<MPN\>"
- "build a dashboard like MT40A1G16TB-062E for \<MPN\>"

---

## End-to-End Workflow

### Step 1 — Confirm the MPN(s) with the operator

Echo back the MPN(s) you parsed and ask whether they want **exact** match (default) or **loose** prefix match (catches sister variants like the TR / different revision suffix):

> "Building Price Intelligence Dashboard for `<MPN(s)>`. Default: exact `chuboe_mpn_clean` match (catches formatting variants only). Want `--loose` (prefix match, catches TR / revision variants)?"

Do not skip. The match scope changes the row count by 2-3× on Micron-style MPNs and the operator should know which slice they're looking at.

### Step 2 — Run the generator

**Single MPN** (clean view, no dropdown):

```bash
node "Trading Analysis/Price Intelligence Dashboard/price-intel.js" --mpn "<MPN>"
```

**Multiple MPNs** (one page with an MPN dropdown at the top):

```bash
# repeated --mpn flags
node "Trading Analysis/Price Intelligence Dashboard/price-intel.js" \
  --mpn "<MPN1>" --mpn "<MPN2>" --mpn "<MPN3>"

# or comma-separated
node "Trading Analysis/Price Intelligence Dashboard/price-intel.js" --mpns "<MPN1>,<MPN2>,<MPN3>"

# or newline-separated file
node "Trading Analysis/Price Intelligence Dashboard/price-intel.js" --mpn-file mpns.txt
```

Same generator powers both forms — when more than one MPN has data, the dashboard adds an **MPN selector bar** between the header and the stat cards. Switching MPN re-renders stats, chart, customer dropdown, and the recent-data table.

**MPNs with zero data are dropped from the dropdown** (and called out in the footer + console output) so the operator isn't switching to empty slots.

Optional flags:

| Flag | Default | Effect |
|------|---------|--------|
| `--mpn "<MPN>"` | required (one or more) | The part(s) to analyze. Repeatable. Quote each — colons, spaces, and dashes are common. |
| `--mpns "A,B,C"` | — | Alternative to repeated `--mpn`. Comma-separated. |
| `--mpn-file <path>` | — | Newline-separated MPN list. |
| `--from YYYY-MM-DD` | all-time | Earliest VQ/MO/RFQ date to include. |
| `--to YYYY-MM-DD` | today | Latest date to include. |
| `--loose` | off | Match `chuboe_mpn_clean LIKE '<clean>%'` instead of `=`. Catches family variants. |
| `--email` | off | Email the dashboard via `shared/notifier.js`. |
| `--to-email <addr>` | `$OPERATOR_EMAIL` or `jake.harris@Astutegroup.com` | Override recipient. |
| `--out <path>` | auto | Override output filename. |

Output filename:
- Single MPN → `<MPN>_<YYYY-MM-DD>.html`
- Multi MPN → `multi_<N>_MPNs_<YYYY-MM-DD>.html`

### Step 3 — Confirm the row counts

The script prints `VQ: N | MO: N | Customer Targets: N`. **Do not skip.** Check the counts are sane:

- If all three are 0 → MPN doesn't exist in our system, or it's spelled differently. Try `--loose`. Then ask the operator if they want a different spelling.
- If VQ is 0 but MO > 0 → we've never quoted this; it's only on customer excess / broker offers. Worth flagging.
- If one number is wildly higher than expected → we may be matching too loosely; try without `--loose`.

### Step 4 — Open the HTML and skim

Output path:

```
Trading Analysis/Price Intelligence Dashboard/output/<MPN>_<YYYY-MM-DD>.html
```

The dashboard has:

- **Header** — workflow title with the active MPN highlighted in yellow, date range, row counts.
- **MPN selector bar** *(multi-MPN only)* — purple bar with an MPN dropdown. Defaults to the first MPN. Switching re-renders everything below; customer/date filters reset.
- **Stat bar** — 9 cards: VQ count/avg/range, MO count/avg/range, customer-target count/avg, unique customers.
- **Controls** — chart type toggle (scatter / bi-weekly line), customer dropdown, date range filter, reset-zoom.
- **Chart** — three overlaid series: VQ (blue circles / solid line), MO (orange diamonds / solid line), Customer Targets (green triangles / dashed line). Hover tooltips show vendor, qty, DC, MFR, RFQ, customer, offer type.
- **Recent Data table** — interleaved VQ / MO / TGT rows, top 100 by date.
- **Footer** — match strategy, dropped-MPN list (if any), generation timestamp.

### Step 5 — Surface findings to the operator

The chart rewards skimming. Look for:

- **VQ-MO gap** — broker stock offers consistently below our VQs means we're either being shown junk or there's arb worth investigating.
- **Customer-target line crossing VQ line** — points where customer ask diverges from market; the overlay tells us when we lost the part on price.
- **Single-customer concentration** — if a customer dominates the VQ count, filter to them and check whether the trend is customer-specific or market-wide.
- **Date-code gating** — many of the lowest-cost broker offers will have old/blank DCs; tooltips show DC.

Send a 3-5-bullet summary to the operator naming the most obvious finding.

### Step 6 — Optional email

If the operator wants the dashboard sent (e.g., for a buyer or salesperson), re-run with `--email`:

```bash
node "Trading Analysis/Price Intelligence Dashboard/price-intel.js" --mpn "<MPN>" --email
```

The HTML attaches as a single self-contained file — recipient can open it offline.

---

## Data Sources

| Series | Table | Price Column | Match Column | Filter |
|--------|-------|--------------|--------------|--------|
| **VQ Quotes** | `chuboe_vq_line` | `cost` | `chuboe_mpn_clean` | `isactive='Y' AND cost>0` |
| **Market Offers** | `chuboe_offer_line` joined to `chuboe_offer` | `priceentered` | `chuboe_mpn_clean` | `isactive='Y' AND priceentered>0`, both header + line |
| **Customer Targets** | `chuboe_rfq_line` joined to `chuboe_rfq` (RFQ-line `priceentered` is the customer's stated target) | `priceentered` | `chuboe_rfq_line_mpn.chuboe_mpn_clean` | `isactive='Y' AND priceentered>0` |

**Match strategy:** `chuboe_mpn_clean` is the alphanumeric-only normalized MPN. Default mode requires `chuboe_mpn_clean = '<clean>'` (catches `MT40A1G16TB-062E IT:F`, `MT40A1G16TB-062EIT:F`, `MT40A1G16TB062E ITF`, etc., but not the TR variant). `--loose` switches to `LIKE '<clean>%'` (catches `MT40A1G16TB062EITFTR`, etc. — useful for whole-family analysis).

**Date columns** (used for x-axis):
- VQ → `COALESCE(chuboe_datequotetrx, created)`
- MO → `COALESCE(datetrx, created)`
- Targets → `COALESCE(chuboe_co_orderdate, created)`

---

## What's intentionally NOT included (yet)

These are deferred to the roadmap, not the workflow:

- **Our CQ bids** — `chuboe_cq_line` shows what *we* offered the customer back, distinct from their target ask. Could be a 4th series. Left out to keep the chart legible (3 series is the IT:F/IT:E precedent).
- **Sales history** — actual sold transactions from `c_orderline`. Worth adding if we ever want a "did we win it and at what price" overlay.
- **Franchise distributor pricing** — `chuboe_pricing_api_result` has live distributor quotes that could anchor "what's the market doing right now". Same caveat about chart legibility.

If the operator asks for any of these, scope a roadmap addition rather than mutating this workflow.

---

## Files

| File | Role |
|------|------|
| `price-intel.js` | Generator — runs SQL, renders HTML |
| `price-intelligence.md` | This doc |
| `output/<MPN>_<date>.html` | Generated single-MPN dashboards (gitignored) |
| `output/multi_<N>_MPNs_<date>.html` | Generated multi-MPN dashboards (gitignored) |

---

## History

- **2026-04-29 (later)** — Multi-MPN support added. Single generator now handles both single-part (no dropdown) and multi-part (dropdown bar) outputs. Added `--mpns` (csv) and `--mpn-file` (newline-separated) input forms, plus `--to-email` / `--out` overrides. Email path fixed to use `createNotifier({...}).sendWithAttachment(...)`.
- **2026-04-29** — Workflow standardized from the original IT:F prototype + IT:E target overlay. Generator added with `--mpn` / `--loose` / `--from` / `--to` / `--email` flags.
- **2026-03-27** — `MT40A1G8SA-062E IT:E` iteration added customer-target overlay (committed `2f51417` as `mt40a1g8sa_price_trend.html`).
- **2026-03-18** — Original `MT40A1G16TB-062E IT:F` dashboard built ad-hoc from `vq_data.csv` + `mo_data.csv` (one-off `mt40a_dashboard.js` in `~/workspace/`).
