# Inventory Recommended Resale

**Status:** DESIGN + first analysis pass (2026-05-05). Resale-write loop not implemented yet.
**Pilot target:** LAM Dead Inventory (W115; ~LAM Kitting backwards-consignment stock — see Cost Sources below)
**Last updated:** 2026-05-05 (post-clarifications + first upside-down report)

---

## Purpose

Populate `chuboe_offer_line.apl_offer_recommendedresale` on our inventory offer lines (free stock + consignment) with **broker-market resale prices**, validated through real RFQ→VQ price discovery on a rolling cycle.

Resale here means: what we should quote to the broker market — not what we'd quote a direct customer (that's Quick Quote). Different pricing logic, different audience.

---

## The Mechanic

Continuous price-discovery loop on our own book:

1. **Pick** N inventory lines this cycle (round-robin + priority queue)
2. **Run franchise APIs** to get the current market signal (NO delisting at this step — APIs are not visible to competitors)
3. **Decide per line** which need broker validation based on franchise/cost spread + supply tightness (see Bucket framework below)
4. **For broker-validate lines only:** mask from NetComponents export, then submit to broker market via a per-warehouse weekly RFQ. Standard franchise enrichment + broker sourcing workflow runs against the RFQ.
5. **Catch** — VQs land on the RFQ; that's our market truth for the broker-validate subset
6. **Compute** — apply per-warehouse progression rules → recommended resale (broker-validate uses VQ truth; default-markup uses cost × 1.15)
7. **Write** — PATCH `apl_offer_recommendedresale` on each line; broker-validate lines return to NetComponents at the new price

The RFQ is the catchment for broker-validate lines. Default-markup and underwater lines never see the broker market — they get a 15% markup written directly.

**Important:** delisting from NetComponents is **broker-RFQ only**, not API. Franchise API calls are silent to competitors so we can run those against any line at any time. Only when we send a line to the broker market do we need to mask the NetComponents listing.

---

## Cycle Structure

- **3 cycles/week × 500 lines each = 1,500 lines/week TOTAL** (across all warehouses, not per-warehouse)
- One RFQ per (warehouse, ISO week)
- **Description format:** `"Inventory Pricing Warehouse {WHID} Week {WW}"`
- All 3 cycles in a week append onto the same per-warehouse RFQ — create-on-first-cycle, lookup-and-PATCH on cycles 2 and 3
- **RFQ type:** existing **Stock** type (no new chuboe_rfq_type)
- **Customer-of-record:** internal BP, TBD at pilot

At ~5,029 active lines total, full-book refresh ≈ 3.4 weeks if everything cycles round-robin.

---

## Inventory Surface (active lines, 2026-04-27 weekly load)

| # | Warehouse Group | Active Lines | Build Order |
|---|---|---:|---|
| 1 | LAM_Dead_Inventory | 915 | **PILOT** |
| 2 | GM Stock (carryover) | 19 | Small validation |
| 3 | Free_Stock_Austin | 519 | |
| 4 | Taxan_Consignment | 1,259 | |
| 5 | Free_Stock_Hong_Kong | 69 | |
| 6 | Spartronics_Consignment | 59 | |
| 7 | Eaton_Consignment (weekly + carryover) | 50 + 244 | |
| 8 | Free_Stock_Stevenage | 5 | |
| 9 | Free_Stock_Philippines (carryover) | 195 | |
| 10 | LAM_Consignment (weekly + carryover) | 88 + 30 | |
| 11 | Franchise_Stock | 82 | |
| 12 | GE_Consignment | 1,495 | **LAST** |
| | **Total** | **~5,029** | |

**Excluded:** LAM Kitting Inventory (offer type 1000025) — one-off consigned report, not a sellable inventory offer.

---

## Per-Warehouse Progression Rules

**Each new warehouse defines its own progression when it joins the queue.** Rules are not transplantable — LAM Dead's logic ≠ Free Stock Austin's logic ≠ GE consignment.

**Storage:** `shared/inventory-resale-rules.json`, keyed by warehouse identifier.

**Warehouse identifier:** `chuboe_offer.description` is the only signal today since the offer header has no warehouse FK and offer type is "Austin" for almost everything. Either parse the description (`"Weekly inventory YYYY-MM-DD — {Group}"` / `"[Carryover] {Group}"`) or — better — establish a stable enum file in `inventory_cleanup.js` and reference it from both sides.

**LAM Dead progression (in progress — refined 2026-05-05):**
- **Cost basis:** LAM Kitting DB (`Trading Analysis/LAM Kitting Reorder/Lam_Kitting_DB_03132026.xlsx`), column **Base Unit Price** on the `INVENTORY` sheet. This is operator-confirmed: LAM only approves repurchases above original purchase cost per SIPOC (the LAM Kitting DB *is* the SIPOC, despite the file name).
- **Cost-floor floor:** never quote below Base Unit Price (LAM contractual gate). All resale logic snaps to ≥ Base.
- **Broker markup logic:** see Bucket framework below — broker_validate uses VQ truth, default_markup uses Base × 1.15, underwater uses Base × 1.15 with a "stuck" flag.
- **Restricted MFR handling:** **bypass the standard masking** for LAM Dead. Restricted gate is a sourcing rule (don't pay broker for ADI/Maxim/LT/TI when franchise has them); when we're the seller, we need open-market price truth on everything (operator confirmed: sold a Linear Tech part at $35 against Mouser's stocked low, "all based on open market").
- **Date code:** annotation only, not a gate. Inside ~3-4 years from today, broker pricing differential is minimal even if DC varies. Older than 3-4 years gets a "stale" tag that suppresses broker-validate even if the franchise signal warrants it (don't waste broker RFQ slots).
- **VQ window:** TBD — likely 30-90 days similar to Quick Quote.

---

## Priority Refresh Tier (queue-jump)

Lines flagged with any of these jump to top of next cycle, regardless of last-refreshed date or warehouse rotation order.

### Memory (hybrid)

**Tier A — always priority (MFR allowlist, pilot scope):**
- Micron, Samsung, SK Hynix

**Tier B — priority if it's actually memory (post-pilot):**
- Macronix, Winbond, ISSI, GigaDevice, Kioxia/Toshiba, Adesto, Cypress (memory line), Kingston, Crucial
- These MFRs make non-volatile parts too, so we need a category check before flagging
- Cheap path: MPN-prefix patterns (`MT*`, `K4*`, `H5*`, `IS61/IS62*`, `W25*`, `MX25*`, etc.)
- Long path: pull category from DigiKey/Mouser API responses (we already enrich), store on the line

**Pilot scope:** Tier A only. Add Tier B once we're storing API category.

### Hot
- **Definition:** volume of inquiry on the MPN — count of distinct RFQ lines on the MPN over a recent window
- **Direction (operator pending — leaning a+c):**
  - (a) brokers/customers RFQ-ing us on the MPN — demand pull
  - (b) us sourcing the MPN through brokers — supply tightness
  - (c) both
- **Threshold (proposed):** ≥3 distinct RFQ lines in last 30d
- Operator confirmation pending; default to (a) until pinned.

### Obsolete (advisory only — double-verification gate)
- Require **2+ API sources** to agree on obsolete/EOL/discontinued (out of DigiKey, Mouser, Arrow, Newark, TTI, Future, Rutronik)
- Mouser-only ≠ obsolete (Mouser overstates lifecycle)
- Even when confirmed: triggers priority **refresh** only, not auto-action (no auto-delisting, no auto-repricing without review)
- Manual override file: `shared/obsolete-overrides.json` for confirmed false-positives

### Long Lead
- ≥26 weeks on the most recent franchise API quote
- Source: franchise API lead-time field on enrichment
- Triggers refresh only

### Restricted
- Reuse `shared/restricted-mfrs.json` (ADI / Maxim / LT / TI today) **for the priority queue trigger only** (these MFRs tend to have volatile broker pricing).
- **DO NOT apply the sourcing-side display masking on LAM Dead output** — see "LAM Dead progression" above for rationale.

---

## Selection Logic (per cycle)

1. **Priority queue first** — any line flagged Memory Tier A / Hot / Obsolete / Long Lead / Restricted, oldest-resale-first within the priority set
2. **Round-robin remainder** — oldest-resale-first (longest since last `apl_offer_recommendedresale` write or VQ refresh) until 500 lines hit
3. Warehouse rotation order respects build-order column above (LAM Dead first → GE Consignment last)

---

## NetComponents Masking

**OPEN:** trace the current NetComponents export hook before any code.

Two architectures possible:
- **Re-push every cycle (full snapshot)** — easiest: just exclude the 500 in-flight from that cycle's export
- **Delta feed** — need a per-line "in-cycle / hide" flag the exporter respects

Touchpoint: `Trading Analysis/Inventory File Cleanup/inventory_cleanup.js` (the email step that produces "Netcomponents Upload").

---

## Coupling Issue: Weekly Reload vs. Resale Persistence

**Critical issue identified at design:** `inventory_cleanup.js` runs every Monday and creates *new* `chuboe_offer` rows for that week's load. Last week's offer is deactivated. Any `apl_offer_recommendedresale` PATCHed on last week's lines does **not** carry forward to the new week's lines automatically.

**Two options — decide before pilot:**

- **A. Re-apply on load** — modify `inventory_cleanup.js` to copy forward existing resales by matching MPN + warehouse against the prior week's offer. Cleaner; resale lives with the inventory line and doesn't go stale.
- **B. Re-price after load** — the resale pipeline runs after each Monday load and re-applies the most recent computed resale per MPN + warehouse. Less invasive to inventory_cleanup but resales are stale ~24h after each Monday load.

---

## End-to-End Workflow (TO BE WRITTEN at pilot)

This section will be filled in once LAM Dead pilot is shaped. Expected structure:

1. Identify candidate lines for this cycle (priority + round-robin selection query)
2. Lookup-or-create the per-warehouse weekly RFQ
3. PATCH NetComponents export to mask the in-flight 500
4. Submit RFQ through standard franchise API enrichment
5. Invoke broker sourcing workflow on the RFQ
6. Wait for VQs (1-3 day SLA — TBD)
7. Run progression rules → compute recommended resale per line
8. PATCH `apl_offer_recommendedresale` on the offer lines
9. Restore NetComponents listing at new prices
10. Mark RFQ closed for the cycle

---

## Bucket Framework (locked 2026-05-05)

Per-line categorization on the cost-spread axis. Franchise stock + qty + DC are surfaced as context, not gates — broker pricing on inquiry is qty-aware and depends on how stock vs inquiry-qty plays out, which can't be statically classified.

| Bucket | Trigger | Action |
|---|---|---|
| 🟢 **broker_validate** | best franchise unit price ≥ cost × **2.0** | delist + send to brokers; expect headroom |
| 🟡 **default_markup** | franchise between 1.0× and 2.0× cost | tack on 15%, leave on NetComponents |
| 🔴 **underwater** | franchise < cost (we lose at market) | tack on 15% anyway, flag as stuck — won't move until market shifts |
| ⚪ **no_coverage** | zero franchise stock found across all distys | broker validate (true scarcity, even if franchise listed but stock = 0) |

**Why 2.0×, not lower:** when selling to other brokers/resellers, they need to undercut franchise *and* still make a margin on the broker risk, so the upstream spread has to be real. 1.30× headroom isn't enough to support a meaningful broker→customer chain.

**Surfaced alongside each line for context:**
- Our qty (LAM Kitting DB MOQ for unheld parts; W115 on-hand for held parts) and total franchise stock summed across distys
- Date code — annotation only; outside ~3-4 years from today gets a "stale" tag that suppresses broker_validate even if franchise signal warrants it
- Restricted MFR flag (priority-trigger only on LAM Dead, NOT display-masked)
- Recent sales velocity (planned overlay, not in first pass)
- LAM-only fields: `Lam P/N` (CPC), LAM Resale Price (reference for what LAM expects we sell at), MOQ

---

## Cost Sources (locked 2026-05-05)

| Warehouse Group | Cost Source | Field |
|---|---|---|
| LAM Dead Inventory (W115) | `Trading Analysis/LAM Kitting Reorder/Lam_Kitting_DB_03132026.xlsx`, sheet `INVENTORY` | `Base Unit Price` |
| GM Stock | Operator emails the cost xlsx to `stockRFQ@orangetsunami.com`; subject "FW: GM Inventory" with `Ready To Ship - GM GP *.xlsx` attached | sheet `Stock and Costs`, column `Astute Cost` |
| Free Stock (Austin/HK/Stevenage/PH) | TBD — likely OT `priceentered` if inventory_cleanup writes it for these groups, else Infor lot cost | TBD |
| Consignment groups (GE/Taxan/Spartronics/Eaton/LAM_Consignment) | TBD — special handling per program; consignment owners have different cost-pass-through rules | TBD |

**LAM Dead specifics:** the LAM Kitting DB acts as the SIPOC — LAM only approves repurchases above `Base Unit Price` per contract. `Resale Price` column on the DB = LAM's required minimum sell price (Base / 0.82 → 18% margin convention). Useful as a sanity floor for our recommended resale, though the broker market may dictate going higher.

**Coverage on first pass (2026-05-05):**
- LAM Kitting DB: 939 unique MPNs, 945 rows with cost > 0
- OT W115 LAM_Dead_Inventory: 851 unique MPNs / 915 lines
- **Overlap: 848 / 851** — 3 OT-only MPNs (in W115 but not on DB) and 91 DB-only MPNs (LAM expects, not held — purchasing-inefficiencies gap operator flagged)

---

## First Analysis Pass (2026-05-05)

Standalone "where are we upside down?" report. Pre-cycle, no resale writes, no NetComponents masking — just franchise APIs against the inventory + per-line bucketing.

**Run script:** `run-upside-down.js` in this folder.
**Sources joined:** GM cost xlsx + LAM Kitting DB × W115 on-hand qty.
**API:** `searchAllDistributors(mpn, ourQty, {mfr})` from `shared/franchise-api.js`.
**Output:** xlsx attachment emailed via `stockRFQ@orangetsunami.com` to operator.
**First run:** ~907 lines (59 GM + 848 LAM); ~5min runtime; result emailed at 2026-05-05 21:06 UTC.

**Notes from the run:**
- Mouser auth flapped during burst — produced ~25 alert emails from `shared/auth-failure-alerts.js`. Debounce isn't tight enough at concurrency=4. Cleanup item.
- First emailed report at 19:39 UTC was matched against the wrong cost source (LAM EPG SIPOC instead of LAM Kitting DB) — 0 overlap with W115. **Disregard the LAM section of that email.** Subject line on the corrected one includes "(corrected)".

---

## Open Questions (pin before pilot)

- [x] ~~Hot signal direction~~ — leaning a+c, default to (a) until pinned
- [x] ~~Tier A memory MFR allowlist~~ — Micron / Samsung / SK Hynix confirmed
- [x] ~~LAM Dead progression rules — full pricing logic~~ — bucket framework + cost source locked 2026-05-05
- [x] ~~Restricted MFR handling on LAM Dead~~ — bypass display masking; priority-trigger still applies
- [x] ~~Threshold for "considerably higher"~~ — 2.0× cost
- [x] ~~Threshold for "limited franchise inventory"~~ — qty-aware at inquiry time, not statically classifiable; surface stock + qty for buyer judgment
- [ ] Internal BP for self-sourcing RFQs — pick existing or create new
- [ ] NetComponents export architecture (re-push vs delta) — for broker-validate masking only
- [ ] Resale survival across Monday reload — option A (re-apply on load) vs B (re-price after)
- [ ] Verify `apl_offer_recommendedresale` is surfaced in OT's UI somewhere a buyer will see (`ad_field` / `ad_tab` check)
- [ ] How to source cost basis for the 91 DB-only MPNs (LAM expects, we don't hold) — likely just Base Unit Price from DB, but flag the not-held status
- [ ] How to source cost basis for the 3 W115-only MPNs (we hold, not on DB)
- [ ] Free Stock + Consignment cost sources (TBD per warehouse group)

---

## Build Phases

1. **Pilot — LAM Dead (915 lines):** define progression rules, build selection query, build per-warehouse RFQ create/append, NetComponents masking, validate end-to-end on one cycle
2. **GM Stock (19):** small validation of the pipeline at scale-of-1 carryover
3. **Free stock + smaller consignment** in size order
4. **GE Consignment (1,495):** last — largest pile, want kinks worked out first

---

## References

- Upstream loader: `Trading Analysis/Inventory File Cleanup/inventory-file-cleanup.md`
- LAM Kitting DB (LAM Dead cost source): `Trading Analysis/LAM Kitting Reorder/Lam_Kitting_DB_03132026.xlsx`
- LAM Kitting Reorder workflow (related): `Trading Analysis/LAM Kitting Reorder/lam-kitting-reorder.md`
- Restricted MFRs: `shared/restricted-mfrs.json`
- Franchise API: `shared/franchise-api.js`
- Data model: `shared/data-model.md` (chuboe_offer / chuboe_offer_line / chuboe_rfq)
- API write-back: `shared/api-writeback.md`
- Future config files (to be created): `shared/inventory-resale-rules.json`, `shared/obsolete-overrides.json`

---

## Source

- 2026-05-04: design session with operator. Mechanic + cycle structure + priority refresh tier + thresholds (initial).
- 2026-05-05: clarifications + first analysis run.
  - Cost source for LAM Dead = LAM Kitting DB Base Unit Price (NOT EPG SIPOC).
  - Delisting is broker-RFQ-only, not API-enrichment (key architectural refinement).
  - Bucket thresholds locked at 2.0× cost spread for broker_validate.
  - Restricted MFR display-masking bypassed on LAM Dead (we're seller, not sourcer).
  - First "where are we upside down?" report emailed.
