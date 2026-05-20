# Sourcing Recap

A per-RFQ "best option" sourcing summary, complementing Vortex Matches. Where Vortex answers *"where can we beat the customer's target?"*, Sourcing Recap answers *"what are the best sourcing options for this RFQ, with context from recent same-CPC activity?"* — useful when there is no target price (PPV, 3PL/VMI, shortage allocations) or when the buyer just wants a ranked snapshot of their open VQs.

The output ships as a single-tab xlsx grouped by CPC, ranked within each group, with out-of-RFQ rows visually called out so the buyer can tell at a glance when a different RFQ on the same part has a better price.

---

## End-to-End Workflow

### Step 1 — Read this doc

(You're here.) Do not improvise the SQL or ranking rules — they're encoded in `sourcing-recap.js`. If you need to adjust ranking behavior, edit the constants there, not separate copies.

### Step 2 — Choose the entry point

| Path | When | How |
|---|---|---|
| **Email** | Buyer wants the result delivered to their inbox + Ccs. Default. | Forward an RFQ email (or any email referencing a 7-digit RFQ#) to `vortex@orangetsunami.com` with **"BEST" + the RFQ#** in the subject. The Vortex poller routes to Sourcing Recap. |
| **CLI** | Manual run / debugging / one-off. | `node "Trading Analysis/Sourcing Recap/sourcing-recap.js" <RFQ#>` from `~/workspace/astute-workinstructions/`. Writes xlsx to `output/`. |

### Step 3 — Email subject rules (the router)

The vortex@ inbox handles **both** Vortex Matches and Sourcing Recap. Routing is by subject keyword:

| Subject pattern | Routes to | Reply subject |
|---|---|---|
| Contains **"BEST"** (standalone word, case-insensitive) **+** a 7-digit RFQ# | Sourcing Recap | `Sourcing Recap — RFQ <#> (<customer>)` |
| Anything else | Vortex Matches (existing behavior) | `Vortex Matches — RFQ <#> (<customer>)` |

Examples that route to Sourcing Recap:
- `BEST 1234567`
- `Best price for 1234567?`
- `1234567 BEST`
- `Best in stock 1234567 please`

Examples that stay on Vortex Matches:
- `1234567`
- `FW: RFQ 1234567 — urgent`
- `Best regards` (no RFQ#)
- `BEST RFQ` (no 7-digit number)

The keyword test is implemented in `Trading Analysis/Vortex Matches/vortex-poller.js` → `isSourcingRecapRequest(subject)`.

### Step 4 — RFQ type ranking rules

The ranking rule is selected automatically from `chuboe_rfq.chuboe_rfq_type_id`. **Do not skip this step's table** — it documents WHY a row was ranked the way it was, which the buyer will ask about.

Live IDs (verified against `adempiere.chuboe_rfq_type` 2026-05-20):

| ID | Type | Rule | Spine |
|---|---|---|---|
| 1000000 | Shortage | `stock_first` | `in_stock_full > in_stock_partial > lead_time > unknown`, then cheapest within tier |
| 1000013 | Hot Parts | `stock_first` | Same as Shortage |
| 1000001 | PPV | `cost_first` | Unit cost asc; in-stock breaks ties |
| 1000002 | Astute Franchised | `cost_first` | Same as PPV |
| 1000003 | EOL/LTB | `cost_first` | Same as PPV |
| 1000004 | 3PL/VMI | `cost_first` | Same as PPV |
| 1000005 | Proactive Offer | `cost_first` | Same as PPV |
| 1000006 | Import | `cost_first` | Same as PPV |
| 1000012 | Unqualified Spot RFQ | `cost_first` | Same as PPV |
| 1000007 | **Stock** | **REJECTED** | Workflow returns a polite redirect pointing to the Stock RFQ Loading workflow. |

The IDs are in the canonical `Trading Analysis/Sourcing Recap/sourcing-recap.js` file (constants `STOCK_FIRST_TYPES`, `STOCK_RFQ_TYPE_ID`, `TYPE_NAMES`). When new RFQ types are added to `chuboe_rfq_type`, edit those constants AND the table above. `shared/data-model.md` § RFQ Types is also kept in sync.

### Step 5 — Tier classification (in-stock vs lead-time)

`chuboe_vq_line.chuboe_lead_time` is free-text. The classifier in `classifyVQ(vq, rfqQty)` reduces it to one of four tiers:

| Tier | Condition |
|---|---|
| `in_stock_full` | qty > 0 AND lead-time blank-or-stock-like AND qty ≥ RFQ qty |
| `in_stock_partial` | qty > 0 AND (lead-time stock-like AND qty < RFQ qty)  OR  (qty > 0 AND lead-time non-stock — "STOCK+LT" case) |
| `lead_time` | qty == 0 AND lead-time has a number / weeks / days |
| `unknown` | qty == 0 AND lead-time blank (vendor told us neither) |

"Stock-like" lead-time text: blank, `"0"`, `/^(stock|in.?stock|stk|ready|available|asap|ship.?now)\b/i`. See the `STOCK_LIKE_LT` regex.

### Step 6 — Pool composition (where the rows come from)

| Source | Query | Filter |
|---|---|---|
| **In-RFQ** | `chuboe_vq_line` joined to `chuboe_rfq_line` via `chuboe_rfq_line_id` | `vq.chuboe_rfq_id = <this RFQ>` AND `vq.isactive='Y'`. ALL such rows are shown — no filtering. |
| **Out-of-RFQ** | Same join, but from any other RFQ | `vq.chuboe_rfq_id <> <this RFQ>` AND `vq.isactive='Y'` AND `vq.created >= NOW() - INTERVAL '14 days'` AND `rl.chuboe_cpc = ANY(<this RFQ's CPCs>)` |

Out-of-RFQ rows are then **filtered to those that would rank above the worst in-RFQ row** for the same CPC under the live rule. If a CPC has no in-RFQ rows at all, ALL out-of-RFQ rows for that CPC are surfaced (gives market context when in-RFQ coverage is empty).

### Step 7 — Output format

Single tab named `Sourcing Recap` in an xlsx file `sourcing-recap-<RFQ#>-<YYYYMMDD-HHMMSS>.xlsx`. Rows are grouped by CPC, ranked within each group. Visual cues:

| Cue | What it means |
|---|---|
| **★ in column A** | The #1 row in this CPC's combined ranking (in-RFQ + surfaced out-of-RFQ) under the live rule. Gold cell, bold. |
| **Orange-tint background + bold text** | This row is an out-of-RFQ VQ. The Source column carries the originating RFQ#, customer, and "Nd ago". |
| **No tint, plain text** | In-RFQ VQ (the buyer's own quote on this RFQ). |
| **Group banding (alternating grey)** | Visual separator between CPC groups. |
| **Red "MISMATCH" in MFR Match column** | RFQ's requested MFR doesn't equal the supplier's quoted MFR per `shared/mfr-equivalence` (`canonicalMfr` after alias + acquisition resolution). |
| **Bold non-USD Curr cell** | A heads-up that ranking is by raw cost without FX conversion. |

Columns (left to right):

`★ │ Source │ CPC │ RFQ Qty │ RFQ MPN │ RFQ MFR │ RFQ Target │ Supplier MPN │ Supplier MFR │ MFR Match │ Supplier │ Vendor Qty │ Cost │ Curr │ Tier │ Lead Time │ Date Code │ VQ Created`

Timestamps display in Central Time per the shared-helpers convention (`shared/time-format.fmtCT / fmtCTShort`).

### Step 8 — Limits / known constraints

- **Multi-currency:** All ranking is on raw `cost` without FX conversion. Non-USD rows show with a bold currency cell so the buyer notices. If multi-currency comparison becomes important, add FX via `shared/fx-rates` in `runSourcingRecapForRFQ` and rank by USD-normalized cost.
- **Date code:** Not part of the ranking rule today. A buyer can still spot stale date codes via the Date Code column.
- **MOQ/SPQ:** Not surfaced today (column space). Add to the writer if needed.
- **In-RFQ "no VQs yet":** If the RFQ has zero in-RFQ VQs, all out-of-RFQ rows for the CPC get surfaced — gives the buyer something to look at while sourcing is still running.
- **Inactive VQs:** Filtered via inner-join to `chuboe_vq_line.isactive='Y'` (same lesson as Vortex Matches RFQ 1132021 — `bi_vendor_quote_line_v` exposes deactivated rows).
- **"Best" definition is RFQ-type-specific.** The same VQ can be #1 under Shortage and #3 under PPV. The reply subject + xlsx title both name the rule so this is visible.

---

## Implementation

| File | Purpose |
|---|---|
| `Trading Analysis/Sourcing Recap/sourcing-recap.js` | Core query + ranking + xlsx writer + CLI entry. Library exports `runSourcingRecapForRFQ`, `buildSummaryHtml`. |
| `Trading Analysis/Sourcing Recap/sourcing-recap.md` | This doc. |
| `Trading Analysis/Sourcing Recap/output/` | xlsx artifacts produced by the CLI. |
| `Trading Analysis/Vortex Matches/vortex-poller.js` | Hosts the subject-keyword router. When subject matches `BEST` + RFQ#, dispatches to `runSourcingRecapForRFQ`; otherwise the existing Vortex Matches path. |

### Architectural debt (tracked)

The vortex@ inbox sits on the **old** email-handler pattern (standalone IMAP poller predating `shared/email-workflow-poller.js` + `workflow-actions/<name>.js`). Sourcing Recap was bolted onto the existing poller as a pragmatic extension — see `Trading Analysis/trading-analysis-roadmap.md` § "Migrate vortex@ to agent pattern" for the migration plan.

### Data-model notes encoded here

- `chuboe_rfq.value` is the user-facing RFQ# (search_key); `chuboe_rfq_id` is the PK.
- `chuboe_rfq_line.chuboe_cpc` is where CPC authoritatively lives. `chuboe_rfq_line_mpn.chuboe_cpc` is a copy.
- VQ has no CPC — always join VQ → `chuboe_rfq_line` to get it. The `bi_vendor_quote_line_v` view doesn't include CPC; we join directly to `chuboe_rfq_line` instead.
- `chuboe_rfq_type_id` is returned by pg as a string (numeric column). Always `Number(...)` before comparing.

---

## Smoke tests (2026-05-20)

| RFQ # | Type | Rule | In-RFQ | Out pool | Surfaced | Outcome |
|---|---|---|---|---|---|---|
| 1133829 | Shortage | stock_first | 59 | 0 | 0 | ✓ no cross-CPC activity |
| 1134323 | Shortage | stock_first | 393 | 1 | 1 | ✓ 1 candidate, 1 surfaced |
| 1134094 | 3PL/VMI | cost_first | 55 | 37 | 33 | ✓ 4 candidates worse than worst in-RFQ → filtered |
| 1133792 | PPV | cost_first | 29 | 16 | 16 | ✓ all surfaced |
| 1135091 | Stock | rejected | — | — | — | ✓ polite redirect to Stock RFQ Loading |

xlsx structure verified programmatically (titles, ★, orange-tint, MFR Match column, CT timestamps).

Router unit tests: 10/10 pass on synthetic subject lines (`BEST 1234567`, `Best price for 1234567?`, `Best regards`, etc.).
