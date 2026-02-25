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
| **Supplier Type** | Skip franchised/authorized distributors (Mouser, DigiKey, Arrow, Avnet, Newark, etc.) |
| **Regions** | Americas and Europe only (Asia/Other excluded - handled by separate purchasing group) |
| **Quantity** | Supplier must have qty >= requested qty (fallback: largest available if none qualify) |
| **Max per Region** | 3 suppliers per region |

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

**Output:** `RFQ_Results_YYYY-MM-DD_HHMMSS.xlsx` with columns:
- Part Number
- Qty Requested
- Supplier
- Region
- Supplier Qty
- Status (SENT/FAILED - color coded)
- Timestamp
- Error (if any)

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

Configurable in `node/submit_rfqs.js` or `python/config.py`:
- `MAX_SUPPLIERS_PER_REGION` - Default: 3
- `FRANCHISED_NAMES` - List of franchised distributor names to skip

## Performance Benchmarks

Based on testing:

| Metric | Value |
|--------|-------|
| Login | ~11-12 seconds |
| Initial search | ~8 seconds |
| Per supplier | ~19-20 seconds |
| **Throughput** | **~2.4 suppliers/minute** |

### Example Timing

| Suppliers | Automated | Manual (est.) | Time Saved |
|-----------|-----------|---------------|------------|
| 4 | 1.5 min | 8-12 min | ~85% |
| 6 | 2.5 min | 12-18 min | ~85% |
| 60 | 25 min | 2-3 hours | ~85% |

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
- Check if they're being filtered as franchised
- Check if they're in the brokered section (skipped)
- Check if they're in Asia/Other region (excluded)

## Future Enhancements

- [x] Batch processing (multiple parts from RFQ)
- [x] Excel output with RFQ tracking
- [x] Python port for production use
- [ ] Database integration for RFQ input
