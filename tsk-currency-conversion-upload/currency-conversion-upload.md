# Currency Conversion Upload Workflow

**Status:** Active
**Trigger:** Email with Exchange Rate Matrix attachment to `bizops@orangetsunami.com`
**Cron:** `currency-conversion-poller` runs every 30m (at :10 and :40)

---

## Overview

Two-step workflow for loading currency conversion rates into iDempiere:

1. **Process & Review**: Email arrives → Extract xlsx → Generate CSV → Reply for review
2. **Load to OT**: User replies "add" → Push 21 currency pairs to `C_Conversion_Rate` table

---

## Input Format

### Source File

**Exchange Rate Matrix** (e.g., `Exchange Rate Matrix -1 May 2026.xlsx`)

### Structure (UKS Tab)

| Row | Content |
|-----|---------|
| 5 | Headers: `Buy Rates:`, `GBP`, `EUR`, `USD`, `AUD`, `CAD`, `CHF`, `INR`, ... `SGD`, ... |
| 6+ | From Currency rates (GBP, EUR, USD, AUD, CAD, CHF, INR, ISR, NOK, NZD, JPY, SEK, SGD, ...) |

**Key columns (0-indexed):**
- Col 1: From Currency code
- Col 2: To GBP rate
- Col 3: To EUR rate
- Col 4: To USD rate
- Col 6: To CAD rate
- Col 8: To INR rate
- Col 12: To JPY rate
- Col 14: To SGD rate

---

## Target Currencies

The upload includes these 7 currencies:
- **EUR** (Euro)
- **USD** (US Dollar)
- **SGD** (Singapore Dollar)
- **INR** (Indian Rupee)
- **JPY** (Japanese Yen)
- **CAD** (Canadian Dollar)
- **GBP** (British Pound)

---

## Rate Extraction Logic

1. Find the **USD row** (row 8 in UKS tab)
2. Extract USD→X rates for each target currency
3. Invert to get X→USD: `X→USD = 1 / USD→X`
4. Calculate cross-rates: `X→Y = X→USD / Y→USD`

---

## Output Format

```csv
AD_Org_ID[Name],C_Currency_ID[ISO_Code],C_Currency_ID_To[ISO_Code],MultiplyRate,ValidFrom,ValidTo
*,EUR,USD,1.1721,2026-05-04,2026-06-03
*,SGD,USD,0.7851,2026-05-04,2026-06-03
...
```

**Fields:**
- `AD_Org_ID[Name]`: Always `*` (all orgs)
- `C_Currency_ID[ISO_Code]`: From currency (3-letter ISO)
- `C_Currency_ID_To[ISO_Code]`: To currency (3-letter ISO)
- `MultiplyRate`: Conversion rate (6 decimal places)
- `ValidFrom`: Start date (YYYY-MM-DD)
- `ValidTo`: End date (YYYY-MM-DD)

---

## Output Rows

**21 unique pairs** (no reciprocals):
- 6 rows: X→USD (EUR, SGD, INR, JPY, CAD, GBP)
- 15 rows: Cross-rates (EUR→SGD, EUR→INR, EUR→JPY, EUR→CAD, EUR→GBP, SGD→INR, SGD→JPY, SGD→CAD, SGD→GBP, INR→JPY, INR→CAD, INR→GBP, JPY→CAD, JPY→GBP, CAD→GBP)

---

## Date Range Convention

Typically one month validity:
- Start: 4th of current month
- End: 3rd of following month

Example: May rates → `2026-05-04` to `2026-06-03`

---

## End-to-End Workflow

### Step 1: Email Detection (DO NOT SKIP)
The email workflow poller detects new emails with Exchange Rate Matrix attachment.

```bash
node shared/email-workflow-poller.js list --workflow currency-conversion
```

### Step 2: Read Email and Extract Attachment
```bash
node shared/email-workflow-poller.js read <uid> --workflow currency-conversion
```

### Step 3: Confirm Date Range
Ask the user to confirm the validity period (e.g., "5/4 - 6/3").

### Step 4: Process Excel File
Run the currency conversion processor:

```bash
node "Trading Analysis/tsk-currency-conversion-upload/currency-processor.js" \
  "/path/to/Exchange Rate Matrix.xlsx" \
  --start-date 2026-05-04 \
  --end-date 2026-06-03
```

### Step 5: Review Output
The processor generates:
- CSV file in `uploaded files/Currency Conversion Upload - {start} - {end}.csv`
- Console summary of all 21 currency pairs

### Step 6: Route Email to Processed
```bash
node shared/email-workflow-poller.js route <uid> load --workflow currency-conversion --payload '{...}'
```

### Step 7: Send Confirmation
Email sender with confirmation that rates have been processed.

---

## Related Files

| File | Description |
|------|-------------|
| `currency-processor.js` | Extracts rates from xlsx, generates CSV |
| `currency-poller.py` | Email poller (cron job), handles new emails + "add" replies |
| `shared/currency-rate-writer.js` | POSTs rates to OT `C_Conversion_Rate` table |
| `shared/workflow-actions/currency-conversion.js` | Workflow handler (for future agent use) |

---

## OT Table: C_Conversion_Rate

| Field | Value |
|-------|-------|
| `AD_Client_ID` | 1000000 (Astute) |
| `AD_Org_ID` | 0 (all orgs) |
| `C_ConversionType_ID` | 114 (Spot) |
| `C_Currency_ID` | From currency |
| `C_Currency_ID_To` | To currency |
| `MultiplyRate` | Conversion rate |
| `DivideRate` | 1/MultiplyRate |
| `ValidFrom` | Start date |
| `ValidTo` | End date |

**Currency IDs:** EUR=102, USD=100, GBP=114, CAD=116, INR=304, JPY=113, SGD=307

---

## Sample Files

- Input: `uploaded files/Exchange Rate Matrix -1 May 2026.xlsx`
- Output: `uploaded files/Currency Conversion Upload - 7_4_26 - 8_3_26.csv`
- Template: `uploaded files/Currency Conversion Matrix and Upload - Tsunami.xlsx`
