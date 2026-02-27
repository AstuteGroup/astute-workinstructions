# Franchise Screening

Pre-screen RFQ parts against franchise distributor inventory (FindChips) before sending to broker sourcing (NetComponents).

## Purpose

Eliminate low-value opportunities where franchise distribution has sufficient stock, saving broker effort for parts that genuinely need secondary market sourcing. Also captures franchise pricing data for downstream supplier filtering.

## Business Logic

### Screening Decision

| Condition | Action |
|-----------|--------|
| `franchise_qty >= customer_qty` AND `opportunity_value < threshold` | **SKIP** broker sourcing |
| Otherwise | **PROCEED** to broker sourcing |

**Opportunity Value** = `franchise_bulk_price × customer_qty`

Default threshold: `$50` (configurable via `--threshold`)

### Why Skip?

If franchise can fully meet the customer's need:
- Newer stock (recent date codes)
- Zero counterfeit risk
- No middleman markup

Customer would only use a broker if they can save significant money.

## Output Data

### 1. Full Results (`*_TrustedParts_*.xlsx`)

| Column | Description |
|--------|-------------|
| MPN | Part number searched |
| Franchise Qty | Total quantity available across franchise distributors |
| Franchise Price | First tier price (small qty) |
| **Franchise Bulk Price** | Last column / lowest price point (highest qty price break) |
| Opportunity Value | Calculated using bulk price |
| Send to Broker | Yes/No decision |
| Reason | Explanation of decision |

### 2. Broker List (`*_ForBrokerRFQ_*.xlsx`)

Parts that passed screening, ready for NetComponents RFQ:

| Column | Description |
|--------|-------------|
| RFQ Number | Source RFQ from iDempiere |
| MPN | Part number |
| Qty | Customer requested quantity |
| Franchise Qty | Available franchise quantity |
| **Franchise Bulk Price** | For min order value filtering in RFQ Sourcing |
| Opportunity Value | Calculated value |

## Pricing Data for RFQ Sourcing

The `franchise_bulk_price` output is used by RFQ Sourcing to filter suppliers by minimum order value:

```
if franchise_qty >= customer_rfq_qty:
    multiplier = 0.2  (abundant - broker must offer big savings)
else:
    multiplier = 0.7  (scarce - secondary market has leverage)

est_value = franchise_bulk_price × supplier_qty × multiplier

Skip supplier if: min_order_value > est_value
```

## Usage

```bash
cd rfq_sourcing/franchise_check

# Screen from iDempiere RFQ
node main.js --rfq 1130410 --threshold 100

# Single part check
node main.js -p "LM358N" -q 100

# From Excel file
node main.js -f parts.xlsx --threshold 50

# Debug mode
node main.js --rfq 1130410 --debug
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--rfq <number>` | Pull parts from iDempiere RFQ | - |
| `-p, --part <mpn>` | Single part number | - |
| `-q, --qty <num>` | Quantity for single part | 1 |
| `-f, --file <path>` | Excel file with parts | - |
| `--threshold <value>` | Opportunity value threshold ($) | 50 |
| `--debug` | Enable debug output | false |
| `--no-headless` | Run browser visibly | false |

## Configuration (`config.js`)

| Setting | Default | Description |
|---------|---------|-------------|
| `OPPORTUNITY_THRESHOLD` | 50.00 | Default opportunity value threshold |
| `SEARCH_DELAY` | 1500 | Delay between searches (ms) |
| `PAGE_TIMEOUT` | 30000 | Page load timeout (ms) |
| `DATA_SOURCE` | 'findchips' | Data source (findchips or trustedparts) |

## Technical Notes

### MPN Normalization

Part numbers are normalized before comparison (remove dashes, spaces, case-insensitive):
- Search: `503480-0800` → normalized: `5034800800`
- Result: `5034800800` → Match!

### Bulk Price Extraction

The pricing data from FindChips is in JSON format:
```json
[[1, "USD", "1.50"], [100, "USD", "1.20"], [1000, "USD", "0.95"]]
```

- First element (`prices[0]`) = small qty price ($1.50)
- Last element (`prices[length-1]`) = bulk price ($0.95) ← **This is what we use**

### Fresh Browser Context

Each search uses a fresh browser context to avoid session state pollution.

## Workflow Integration

```
┌─────────────────────┐
│   iDempiere RFQ     │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Franchise Screening │ ◄── You are here
│   (FindChips)       │
│                     │
│ Outputs:            │
│ - franchise_qty     │
│ - franchise_bulk_$  │
└──────────┬──────────┘
           │
    ┌──────┴──────┐
    │             │
 PROCEED        SKIP
    │             │
    ▼             ▼
┌─────────────┐  Done
│ RFQ Sourcing│  (low value)
│ (NetComps)  │
│             │
│ Uses bulk $ │
│ for min     │
│ order filter│
└─────────────┘
```
