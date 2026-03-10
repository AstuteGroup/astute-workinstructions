# Vortex Matches

Matches customer RFQs against VQs, market offers, and stock to surface sourcing opportunities and market intelligence.

## Output Files

Each run generates **Stock + No Prices**, plus either **Good Prices** or **All Prices** depending on whether customer targets exist.

### 1. Stock
`{RFQ}_Stock.xlsx`

Offers with `offer_type = "Stock - with a location"`. Always separated because we have more control over this inventory. May or may not include pricing.

### 2. Good Prices
`{RFQ}_Good Prices.xlsx`

Priced offers (VQs, excess, franchise, broker) at or below **20% above customer target**.

*Only generated when customer provided target prices.*

### 3. All Prices
`{RFQ}_All Prices.xlsx`

All priced offers as a general reference for buyers/sellers.

*Only generated when customer has NOT provided target prices.*

### 4. No Prices
`{RFQ}_No Prices.xlsx`

Supply matches WITHOUT pricing — excess partners, franchise, brokers, occasional VQs. Starting point for buyers to pursue potential sources.

## Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| Time window | 90 days | Rolling from **request date** (not RFQ date) — fresh market data even on old RFQs |
| Good Prices threshold | ≤20% above target | Filters out offers more than 20% above customer target |

## Generation Logic

```
1. Separate Stock offers (offer_type = "Stock - with a location") → Stock file

2. For remaining offers (VQs, excess, franchise, broker):

   IF customer provided targets:
     - Priced offers ≤20% above target → Good Prices
     - Offers without pricing → No Prices

   IF no customer targets:
     - All priced offers → All Prices
     - Offers without pricing → No Prices
```

## Data Sources

- `m_rfqresponse` — Vendor quotes (VQs)
- `c_rfqline` / `c_rfq` — Customer RFQs with target prices
- Market offer tables — Excess, franchise, broker inventory
- Stock offers — `offer_type = "Stock - with a location"`

## Column Refinements

**TODO**: Current BI tool uses same template for all files. Define file-specific columns:
- Remove irrelevant columns per file type (e.g., "Target Price" on Stock file)
- Add file-specific columns where needed

## Sample Files

See `Samples/` folder for example outputs.

## Status

**Phase**: Defining output specs
**Next**: Refine columns per file type
