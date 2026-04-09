# Quick Quote Workflow

Generate baseline quotes from recent vendor quotes (VQs) for a given RFQ, applying margin/GP pricing logic with sales history context.

## Quick Start

```bash
# 1. Run the SQL query (replace RFQ number) — produces the actionable QQ output
psql -f qq_RFQNUM_sales.sql > "Quick Quote RFQNUM YYYY-MM-DD CUSTOMER.csv"

# 2. Optional: pull cached API pricing context for the same RFQ
node "Trading Analysis/Quick Quote/qq-cache-context.js" RFQNUM
# → writes ./qq_RFQNUM_cache_context.csv
```

## Cache Context (supplementary)

`qq-cache-context.js` reads the franchise API file cache at
`shared/data/api-pricing-cache/{MPN}_{YYYY-MM-DD}.json` for every MPN on
the RFQ and outputs a supplementary CSV with the alternate price tiers
+ distributors that aren't in `chuboe_vq_line` (because the VQ writer
only captures the qty-relevant break, not the full ladder).

Use case: when reviewing QQ output, the cache context CSV tells you what
ELSE the franchise APIs know about each MPN — bulk discount tiers for
larger qtys, distributors that returned data but didn't get a VQ row,
historical pricing from prior API calls on other RFQs.

The output is **NOT** deduped against the VQs in the main QQ CSV — both
sources are intentionally complete so the operator can compare them
independently.

**Arrow / Verical safety filter:** envelopes captured before
2026-04-09T13:00 UTC have the broken legacy parser shape (Arrow inflated
130x by Verical-mirror double-counting, unreachable bulk tier surfaced).
Those Arrow + Verical entries are skipped. Other distributors are not
affected and surface unconditionally within the 90-day window. The guard
can be removed after roughly a week of natural cache rollover.

## Input

- **RFQ Number** - The system RFQ value (e.g., `1129361`)
- Query pulls all CPCs (Customer Part Codes) from that RFQ with target prices

## Data Sources

| Source | Window | Purpose |
|--------|--------|---------|
| `chuboe_vq_line` | Last 30 days | Vendor quotes with cost/qty/date code |
| `chuboe_offer_line` | Active stock | Internal inventory matches |
| `c_order` / `c_orderline` | 12mo same-cust, 6mo other | Sales history for pricing |
| `chuboe_cq_line` | 12 months | Losing CQ prices (same customer/type) |

> **Table structures and join patterns:** See [`shared/data-model.md`](../../shared/data-model.md).

---

## Pricing Logic

### Step 1: Floor Price (Minimum Acceptable)

```
Floor = MAX(cost / 0.85, cost + $250/qty)
```

- **15% minimum margin** OR **$250 minimum GP per line**, whichever is higher
- This is the absolute floor - no quote below this

### Step 2: Suggested Resale (Priority Hierarchy)

The system applies these rules in order, always ensuring the result is at or above floor:

| Priority | Condition | Resale Logic | Rationale |
|----------|-----------|--------------|-----------|
| 1 | Same-cust PPV sale exists | Last PPV price | Customer already paid this for PPV |
| 2 | Same-cust Shortage sale exists | Last shortage price | Customer already paid this for shortage |
| 3 | Same-cust losing CQ exists | `CQ × 0.95 - 0.50 × (CQ×0.95 - floor)` | Undercut lost quote, adjust for market |
| 4 | Other-customer sale exists | `floor + (other_price - floor) × 0.5` | Split the difference |
| 5 | Target margin ≤35% | Use target price | Market-aligned, reasonable margin |
| 6 | Target margin >35% | `cost / 0.70` (30% margin) | Fat margin = competitive opportunity |

**Note:** All suggested resales are floored at the minimum from Step 1.

### Step 3: Confidence Scoring

| Tier | Criteria |
|------|----------|
| **High** | VQ within 14 days |
| **Medium** | VQ 15-30 days old |
| **Stock** | Internal inventory match |

### Step 4: Date Code Filtering

Rejects VQs with date codes older than 22 (2022), unless:
- Date code is blank/empty
- Contains lead time language (e.g., "12-16wks", "lead")

---

## Output Columns

| Column | Description |
|--------|-------------|
| CPC | Customer part code (line identifier) |
| MPNs | Count of MPN variants for this CPC |
| Type | `VQ` (vendor quote) or `Stock` (internal inventory) |
| vs Target | `UNDER` / `OVER` / `VERIFY QTY` / `CHECK WITH JAKE` |
| RFQ Target | Customer's target price |
| RFQ Qty | Quantity requested |
| Source MPN | MPN from vendor/stock |
| Supplier/Location | Vendor name or warehouse |
| VQ Cost | Vendor quoted cost |
| Source Qty | Available quantity |
| Date Code | Manufacturing date code |
| Floor Price | Minimum acceptable resale |
| Suggested Resale | Recommended quote price |
| Resale Basis | Which pricing rule was applied |
| % Under Tgt | Percentage below target (positive = margin room) |
| Quoted GP | Gross profit in dollars |
| % Demand | Coverage: source qty / RFQ qty |
| Opp Amount | Opportunity value (target × qty) |
| Confidence | High / Medium / Stock |
| Days Btw | Days between VQ and RFQ |
| VQ Alts | Number of alternative VQ sources |
| Sales History | Recent sales: "Customer (Type) $Price MM/DD (Nx)" |
| Stock Offer Date | Date of stock offer (if applicable) |

---

## Sort Order

Results are grouped and sorted for efficient review:

1. **UNDER target** - Best opportunities (sorted by % Under Tgt DESC)
2. **VERIFY QTY** - Needs attention (supplier qty = 0)
3. **OVER target** - Harder to quote (sorted by % Under Tgt DESC)
4. **Stock-only** - No VQ match, stock available

Stock rows appear immediately after their associated VQ row.

---

## Inclusion Rules

A CPC appears in output if ANY of these are true:
- Floor price ≤ target × 1.20 (within 20% of target)
- Has sales history (same or other customer)
- Has a losing CQ on file

This ensures we don't miss winnable opportunities even when floor exceeds target.

---

## Workflow Steps

1. **Get RFQ number** from sales team or system
2. **Copy template SQL** and update RFQ number
3. **Run query** and export to CSV
4. **Review UNDER lines** - these are ready to quote
5. **Review OVER lines** - may need negotiation or alternative sourcing
6. **Check stock rows** - coordinate with Jake for internal inventory pricing
7. **Validate VERIFY QTY** - confirm supplier quantities before quoting

---

## Example Output

```
CPC,Type,vs Target,RFQ Target,VQ Cost,Floor Price,Suggested Resale,Resale Basis,% Under Tgt,Quoted GP
TPS2421-2DDAR,VQ,UNDER,0.4248,0.052,0.0631,0.0743,Cost-based 30% margin,82.5,167.15
ACPL-C79B-500E,VQ,UNDER,1.26,1.05,1.2353,1.2600,Target (margin 17%),0.0,420.00
TPS51200DRCR,Stock,CHECK WITH JAKE,0.1125,,,,,,,
```

---

## Files

| File | Description |
|------|-------------|
| `qq_RFQNUM_sales.sql` | Query template (copy and update RFQ#) |
| `Quick Quote RFQNUM YYYY-MM-DD CUSTOMER.csv` | Output file |

---

## Related

- [VQ Loading](../../Trading Analysis/RFQ Sourcing/vq_loading/vq-loading.md) - How VQs get into the system
- [Market Offer Matching](../Market%20Offer%20Matching%20for%20RFQs/market-offer-matching.md) - Match RFQs against excess/stock

---

## TODO

- [ ] Parameterize SQL query (avoid hardcoding RFQ number)
- [ ] Add rebate logic for contract customers
- [ ] Create Node.js wrapper for easier execution
- [ ] Add customer-specific margin rules
