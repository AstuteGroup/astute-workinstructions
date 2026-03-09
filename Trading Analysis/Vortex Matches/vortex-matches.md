# Vortex Matches

Analyzes market offers (VQs, stock offers, broker inventory) against customer RFQs to surface sourcing and quoting opportunities.

## Reports Generated

### 1. Under Target Opportunities
VQs or market offers priced below customers' target prices:
- **For Sellers**: Quick quote opportunities (margin already built in)
- **For Buyers**: High-priority lines to actively source

*Only generated when customer targets exist.*

### 2. Stock Matches
Parts from customer RFQs that match Astute's current inventory — immediate fulfillment opportunities.

### 3. All Other Market Offers
Remaining market intelligence:
- Customer excess inventory
- Broker inventory lists

Gives buyers potential parts to target and suppliers to engage.

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| Time window | TBD | How far back to look for VQs/offers |
| Target threshold | TBD | % under target to flag as opportunity |

## Data Sources

- `m_rfqresponse` — Vendor quotes (VQs)
- `c_rfqline` / `c_rfq` — Customer RFQs with target prices
- Inventory tables — Astute stock
- Market offer tables — TBD (customer excess, broker lists)

## Status

**Phase**: Initial scoping
**Next**: Define queries for each report

---

## Tasks

See `tasks/` folder for implementation steps.
