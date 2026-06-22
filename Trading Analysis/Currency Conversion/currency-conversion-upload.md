# Currency Conversion Upload Workflow

Creates currency conversion rate CSV files for iDempiere import from Exchange Rate Matrix Excel files.

## Source File

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

## Target Currencies

The upload includes these 7 currencies:
- **EUR** (Euro)
- **USD** (US Dollar)
- **SGD** (Singapore Dollar)
- **INR** (Indian Rupee)
- **JPY** (Japanese Yen)
- **CAD** (Canadian Dollar)
- **GBP** (British Pound)

## Rate Extraction

1. Find the **USD row** (row 8 in UKS tab)
2. Extract USD→X rates for each target currency
3. Invert to get X→USD: `X→USD = 1 / USD→X`
4. Calculate cross-rates: `X→Y = X→USD / Y→USD`

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
- `MultiplyRate`: Conversion rate
- `ValidFrom`: Start date (YYYY-MM-DD)
- `ValidTo`: End date (YYYY-MM-DD)

## Output Rows

**21 unique pairs** (no reciprocals):
- 6 rows: X→USD (EUR, SGD, INR, JPY, CAD, GBP)
- 15 rows: Cross-rates (EUR→SGD, EUR→INR, EUR→JPY, EUR→CAD, EUR→GBP, SGD→INR, SGD→JPY, SGD→CAD, SGD→GBP, INR→JPY, INR→CAD, INR→GBP, JPY→CAD, JPY→GBP, CAD→GBP)

## Date Range Convention

Typically one month validity:
- Start: 4th of current month
- End: 3rd of following month

Example: May rates → `2026-05-04` to `2026-06-03`

## Workflow Steps

1. **Receive** Exchange Rate Matrix Excel file
2. **Confirm** date range with user (e.g., "5/4 - 6/3")
3. **Extract** rates from UKS tab, USD row
4. **Calculate** all 21 unique currency pairs
5. **Export** CSV to `uploaded files/Currency Conversion Upload - {start}_26 - {end}_26.csv`

## Script Location

The extraction logic uses Node.js with the `xlsx` package. Key steps:

```javascript
const XLSX = require('xlsx');
const wb = XLSX.readFile('Exchange Rate Matrix.xlsx');
const sheet = wb.Sheets['UKS'];
const data = XLSX.utils.sheet_to_json(sheet, {header: 1});

// Row 5 = headers, Row 8 = USD rates
// Invert USD→X to get X→USD
// Cross-rate: X→Y = X→USD / Y→USD
```

## Output Location

`/home/justin.oberhofer/workspace/uploaded files/Currency Conversion Upload - {M_D_YY} - {M_D_YY}.csv`

## Related Files

- `Currency Conversion Matrix and Upload - Tsunami.xlsx` — Template with formulas (Prescribed Rates, TempRates, Download sheets)
- Previous uploads in `uploaded files/` for reference
