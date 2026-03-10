# Vortex Matches

Matches customer RFQs against VQs, market offers, and stock to surface sourcing opportunities and market intelligence.

## Usage

```bash
node vortex-matches.js <rfq_number>
```

Example:
```bash
node vortex-matches.js 1130895
```

Output files are generated in `output/` directory.

## Output Files

Each run generates **Stock + No Prices**, plus either **Good Prices** or **All Prices** depending on whether customer targets exist.

### 1. Stock
`{RFQ}_Stock.xlsx`

Astute inventory matches (`offer_type = "Stock - *"`). Always separated because we control this inventory. Price left blank when $0.

### 2. Good Prices
`{RFQ}_Good Prices.xlsx`

Priced offers (VQs, excess, franchise, broker) at or below **20% above customer target**. `% Under Target` in column B for quick sorting.

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
| Time window (VQs/MOs) | 90 days | Rolling from request date — fresh market data |
| Time window (Stock) | No limit | Astute stock always shows if active |
| Good Prices threshold | ≤20% above target | Filters out offers more than 20% above customer target |

## Data Processing

### RFQ Line Deduplication

RFQ lines with identical `MPN + Qty + Target + Customer Part Number` are deduped before matching. This prevents inflated output when source data has duplicate lines.

### MO Type Column

- **Market Offers** → Shows offer type (Broker Stock Offer, Customer Excess, Stock - Austin Warehouse, etc.)
- **VQs** → Blank (MO Type = Market Offer Type, not applicable to verified quotes)

## Columns by File Type

### Good Prices (20 columns)
```
RFQ Number, % Under Target, RFQ Created, RFQ Customer, RFQ MPN, RFQ Qty, RFQ Target,
Customer Part Number, Type, MO Type, Supplier MPN, Supplier/Excess Partner, Qty,
Supplier Price, lead_time, Date Code, Created Date, Days Btw MO/VQ & RFQ, % of Demand, Opp Amount
```

### All Prices (18 columns)
Same as Good Prices but without:
- `% Under Target` — no target to compare against
- `RFQ Target` — will be empty/0

### No Prices (17 columns)
Same as Good Prices but without:
- `% Under Target` — can't calculate without price
- `Supplier Price` — obviously no price
- `Opp Amount` — can't calculate without price

### Stock (18 columns)
Same as Good Prices but without:
- `Type` — always "MO" for stock

Special handling:
- `lead_time` defaults to **"STOCK"** if blank
- `Supplier Price` left blank when $0

## Data Sources

- `bi_vendor_quote_line_v` — Vendor quotes (VQs)
- `bi_market_offer_line_v` — Market offers (excess, franchise, broker, stock)
- `chuboe_rfq` / `chuboe_rfq_line_mpn` — Customer RFQs with target prices

## Sample Files

See `output/` folder for example outputs from RFQ 1130895.

## Status

**Implemented** — Ready for use.
