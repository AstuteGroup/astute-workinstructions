# NetComponents RFQ Automation

Automated RFQ (Request for Quote) submission to NetComponents suppliers for electronic component sourcing.

## Overview

This automation:
1. Searches NetComponents for a part number
2. Identifies qualifying in-stock suppliers
3. Submits RFQs to multiple suppliers automatically
4. Tracks timing and results

## Business Logic

### Supplier Selection Criteria

| Criteria | Rule |
|----------|------|
| **Inventory Type** | In-Stock only (skip Brokered Inventory Listings) |
| **Supplier Type** | Skip franchised/authorized distributors (detected via `ncauth` class in DOM) |
| **Regions** | Americas and Europe only (Asia/Other excluded - handled by separate purchasing group) |
| **Quantity** | Supplier must have qty >= requested qty (fallback: largest available if none qualify) |
| **Date Code** | Fresh DC (2024+) prioritized, but never rules out suppliers |
| **Max per Region** | 3 suppliers per region (+1 if unknown DCs in selection) |

### Date Code Prioritization

Suppliers are prioritized by date code freshness (2-year window preferred), but **no supplier is ruled out** based on date code:

| Priority | Criteria |
|----------|----------|
| 1 (highest) | Fresh DC (24+) + meets qty |
| 2 | Unknown/No DC + meets qty |
| 3 | Fresh DC + below qty |
| 4 | Unknown/No DC + below qty |
| 5 | Old DC + meets qty |
| 6 (lowest) | Old DC + below qty |

**Date Code Status:**
- **FRESH**: Confirmed 2024+ (e.g., `2532`, `25`)
- **UNKNOWN**: No DC, ambiguous format (e.g., `2022`), or "+" suffix (e.g., `20+`)
- **OLD**: Confirmed older than 2024 (e.g., `2237`, `1507`)

When unknown DCs are in the selected suppliers, **+1 extra supplier** is added per region as a buffer.

### Quantity Adjustment

When a supplier has **less than the requested quantity**, the RFQ quantity is automatically adjusted to encourage quoting:

- Suppliers are more likely to respond when they feel they can win the order
- Adjusted qty is rounded to a "nice" number (nearest 5, 10, 25, or 100 depending on magnitude)
- Stays within 10% of supplier's actual stock

| Requested | Supplier Stock | RFQ Qty |
|-----------|----------------|---------|
| 100 | 150 | 100 (supplier has enough) |
| 100 | 32 | 30 (rounded to nearest 5) |
| 500 | 480 | 475 (rounded to nearest 25) |
| 500 | 123 | 123 (rounding would exceed 10%) |

### Part Number Variants

The automation aggregates quantities across part number variants from the same supplier:
- Base part (e.g., `DS3231SN#`)
- Tape & Reel variants (`DS3231SN#T&R`, `DS3231SN#TR`)
- Other packaging suffixes

### Europe Suppliers

For all Europe supplier RFQs, the message field automatically includes:
> "Please confirm country of origin."

## Scripts

Both Node.js and Python implementations are available with identical functionality.

### Node.js (`node/` directory)

#### `list_suppliers.js` - Market Check

Preview available suppliers before submitting RFQs.

```bash
cd node
node list_suppliers.js "<part_number>" "<min_quantity>"

# Example
node list_suppliers.js "DS3231SN#" "1000"
```

#### `submit_rfqs.js` - RFQ Submission

Submit RFQs to qualifying suppliers.

```bash
cd node
node submit_rfqs.js "<part_number>" "<quantity>"

# Example
node submit_rfqs.js "DS3231SN#" "1000"
```

### Python (`python/` directory)

#### `list_suppliers.py` - Market Check

```bash
cd python
python3 list_suppliers.py "<part_number>" "<min_quantity>"

# Example
python3 list_suppliers.py "DS3231SN#" 1000
```

#### `submit_rfqs.py` - RFQ Submission

```bash
cd python
python3 submit_rfqs.py "<part_number>" "<quantity>"

# Example
python3 submit_rfqs.py "DS3231SN#" 1000
```

#### `batch_rfqs.py` - Batch Processing with Excel Output

Process multiple parts from an Excel file and output results to Excel.

**Input Excel format:**
| Part Number | Quantity |
|-------------|----------|
| DS3231SN# | 1000 |
| BCM5221A4KPTG | 500 |

```bash
cd python
python3 batch_rfqs.py <input_excel>

# Example
python3 batch_rfqs.py rfq_input.xlsx
```

**Output:** `RFQ_Results_YYYY-MM-DD_HHMMSS.xlsx`

#### `batch_rfqs_from_system.py` - Batch Processing from System RFQ

Process all line items from an RFQ in iDempiere and output results to Excel.

```bash
cd python
python3 batch_rfqs_from_system.py <rfq_number>

# Example
python3 batch_rfqs_from_system.py 1008627
```

**What it does:**
1. Creates subfolder `RFQ_<number>/` for all output files
2. Queries `chuboe_rfq` and `chuboe_rfq_line` tables for the RFQ
3. Extracts part numbers (MPN) and quantities for each line item
4. Launches 3 parallel browser workers (configurable)
5. Distributes parts across workers for faster processing
6. Outputs results to `RFQ_<number>/Results_YYYY-MM-DD_HHMMSS.xlsx`

**Output folder structure:**
```
RFQ_1130292/
├── .lock                                # Lock file (prevents duplicate runs)
├── Results_2026-02-25_212623.xlsx      # Main results
├── NoSuppliers_Analysis.xlsx            # CPC analysis (run separately)
└── Results_Combined.xlsx                # If multiple batches combined
```

**Lock File Protection:**
- A `.lock` file is created when a batch starts
- Prevents running the same RFQ twice concurrently
- Automatically removed when batch completes
- If a batch crashes, the lock file detects stale PIDs and auto-removes

**Parallel Processing:**
- 3 headless browser instances run concurrently
- Parts are distributed across workers via queue
- Timing jitter (±40%) prevents detection as bot traffic
- Mimics normal multi-buyer portal activity

**Output Excel columns:**
- RFQ Line
- CPC (Customer Part Code)
- Part Number
- Qty Requested
- Qty Sent (may be adjusted if supplier has less)
- Supplier
- Region
- Supplier Qty
- Qualifying (total qualifying suppliers found for this part)
- Qual Amer (qualifying suppliers in Americas)
- Qual Eur (qualifying suppliers in Europe)
- Selected (how many suppliers were selected/used)
- Status (SENT/FAILED/NO_SUPPLIERS - color coded)
- Timestamp
- Error (if any)
- Worker (which browser instance processed it)

**Batch Summary** (printed at end of run):
- Total parts processed, RFQs sent, failed, no suppliers
- Timing metrics (total time, avg per part)
- Supplier distribution: unique suppliers used, top 10 by RFQ count

#### `analyze_no_suppliers.py` - Post-Batch Analysis

Analyze batch results to identify CPCs that need manual sourcing attention.

```bash
cd python
python3 analyze_no_suppliers.py <results_excel> [rfq_number]

# Example (run from RFQ subfolder)
python3 analyze_no_suppliers.py RFQ_1130292/Results_2026-02-25_212623.xlsx 1130292
```

Output is saved in the same folder as the input file.

**What it does:**
1. Reads batch results Excel file
2. Groups MPNs by CPC (Customer Part Code)
3. For each "NO_SUPPLIERS" MPN, checks if other MPNs under same CPC got quotes
4. Outputs analysis file highlighting CPCs that truly need attention

**Output columns:**
- RFQ Line
- CPC
- MPN (No Suppliers)
- Qty
- CPC Has Other Quotes? (Yes = covered, NO = needs attention)
- Other MPNs Quoted (which alternatives got quotes)

**Color coding:**
- **Green** = CPC is covered by another MPN that got quotes
- **Red** = CPC has NO quotes from any MPN (needs manual work)

**Note:** If CPC column is missing from results (older batch runs), provide the RFQ number as second argument to look up CPC from database.

### Output (all implementations)

- Per-supplier status (SENT/FAILED)
- Timing breakdown (login, search, per-supplier, total)
- Throughput metrics (suppliers/minute)

## Configuration

### Credentials

Create `.env` file in the `node/` directory (shared by both Node.js and Python):

```
NETCOMPONENTS_ACCOUNT=<account_number>
NETCOMPONENTS_USERNAME=<username>
NETCOMPONENTS_PASSWORD=<password>
```

**Note:** The `.env` file is gitignored and should never be committed.

### Constants

Configurable in `python/config.py`:

| Setting | Default | Description |
|---------|---------|-------------|
| `MAX_SUPPLIERS_PER_REGION` | 3 | Max suppliers to RFQ per region |
| `NUM_WORKERS` | 3 | Parallel browser instances for batch processing |
| `JITTER_RANGE` | 0.4 | Timing variation (±40%) to appear natural |
| `DC_PREFERRED_WINDOW_YEARS` | 2 | Date code freshness window (2024+ is "fresh") |
| `MIN_ORDER_VALUE_MULTIPLIER_ABUNDANT` | 0.2 | Multiplier when franchise can meet demand |
| `MIN_ORDER_VALUE_MULTIPLIER_SCARCE` | 0.7 | Multiplier when franchise cannot meet demand |

**Note:** Franchised/authorized distributors are detected automatically via the `ncauth` CSS class in the DOM (no hardcoded name list required).

### Min Order Value Filtering

When franchise pricing data is available (from Franchise Screening), suppliers can be filtered based on their minimum order value:

```
if franchise_qty >= customer_rfq_qty:
    multiplier = 0.2  (abundant - broker must offer big savings to compete)
else:
    multiplier = 0.7  (scarce - secondary market has leverage)

est_value = franchise_bulk_price × supplier_qty × multiplier

Skip supplier if: min_order_value > est_value
```

**Example:**
- Franchise bulk price: $1.00
- Supplier qty: 500
- Franchise qty: 1000 (abundant) → multiplier = 0.2
- Est value: $1.00 × 500 × 0.2 = **$100**
- If supplier's min order is $150, they are **OMITTED**

Omitted suppliers appear in the output with yellow highlighting and the reason for omission.

## Performance Benchmarks

### Single-Threaded (submit_rfqs.py)

| Metric | Value |
|--------|-------|
| Login | ~11-12 seconds |
| Initial search | ~8 seconds |
| Per supplier | ~19-20 seconds |
| **Throughput** | **~2.4 suppliers/minute** |

### Parallel Processing (batch_rfqs_from_system.py)

With 3 workers:

| Metric | Value |
|--------|-------|
| Login (per worker) | ~12 seconds |
| Avg per part | ~20-25 seconds |
| **Effective throughput** | **~7-8 suppliers/minute** |

### Example Timing (Batch)

| Parts | Suppliers (est.) | Sequential | 3 Workers | Time Saved |
|-------|------------------|------------|-----------|------------|
| 10 | ~50 | 20 min | 7 min | 65% |
| 30 | ~150 | 60 min | 20 min | 67% |
| 70 | ~350 | 140 min | 45 min | 68% |

## Technical Notes

### NetComponents Page Structure

The search results table has a hierarchical structure:
1. **Region headers** - "Americas", "Europe", "Asia/Other"
2. **Section subheaders** - "In-Stock Inventory" or "Brokered Inventory Listings" (with yellow warning triangles)
3. **Data rows** - Supplier listings

**Important:** Section subheaders must be distinguished from data rows that contain "in stock" in the description field. The automation identifies subheaders by checking if the row starts with "in stock" or "brokered" AND is a short row (<100 chars).

### Table Columns

| Column | Content |
|--------|---------|
| 0 | Part Number |
| 3 | Manufacturer |
| 4 | Date Code |
| 5 | Description |
| 6 | Upload Date |
| 7 | Country |
| 8 | **Quantity** |
| 15 | **Supplier Name** (link) |

### RFQ Form Elements

| Element | Selector |
|---------|----------|
| Part checkbox | `#Parts_0__Selected` |
| Quantity input | `#Parts_0__Quantity` |
| Comments field | `#Comments` |
| Send button | `input[type="button"].action-btn` |

**Note:** The Send RFQ button is an `<input type="button">`, not a `<button>` element.

## Troubleshooting

### "E-Mail RFQ option not found"
- Not all suppliers support email RFQ through NetComponents
- The automation will skip and continue to next supplier

### "Send button disabled"
- Ensure quantity is filled
- Ensure part checkbox is checked

### Supplier not appearing in results
- Check if they're being filtered as franchised (has `ncauth` class)
- Check if they're in the brokered section (skipped)
- Check if they're in Asia/Other region (excluded)

## Future Enhancements

- [x] Batch processing (multiple parts from Excel)
- [x] Batch processing from system RFQ number
- [x] Excel output with RFQ tracking
- [x] Python port for production use
- [x] Database integration for RFQ input
- [x] Parallel processing (3 workers)
- [x] Timing jitter for natural appearance
- [x] Date code prioritization
- [x] Quantity adjustment to encourage quoting
