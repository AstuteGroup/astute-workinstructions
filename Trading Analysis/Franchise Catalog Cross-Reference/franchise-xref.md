# Franchise Catalog Cross-Reference

Cross-references an RFQ's line items against stored franchise distributor catalogs (HTC Korea/TAEJIN, ATGBICS) and generates per-franchise workbooks showing which customer-asked MPNs have franchise alternatives.

---

## Trigger

**Inbox:** `vortex@orangetsunami.com` (shared with Vortex Matches)

**Subject patterns:**
- `1234567 franchise` → check ALL franchise catalogs
- `1234567 HTC` → check only HTC Korea catalog
- `1234567 ATGBICS` → check only ATGBICS catalog
- `1234567 HTC ATGBICS` → check both (explicit list)
- `franchise 1234567` → order doesn't matter

**Priority:** Franchise keywords take precedence over other routing (checked before Sourcing Recap).

---

## End-to-End Workflow

### Step 1: Email Detection (vortex-poller.js)

The poller checks incoming emails for franchise keywords using `parseFranchiseRequest()`:
- Detects generic "franchise" keyword → all catalogs
- Detects specific franchise names (htc, atgbics, taejin) → specific catalogs

### Step 2: RFQ Line Query

Queries `chuboe_rfq_line_mpn` for all MPNs/MFRs on the RFQ:

```sql
SELECT rlm.chuboe_mpn, rlm.chuboe_mfr_text, rlm.qty, rl.chuboe_cpc
FROM chuboe_rfq_line_mpn rlm
JOIN chuboe_rfq_line rl ON ...
WHERE r.value = '<rfq_number>'
```

### Step 3: Catalog Matching

For each franchise catalog:
1. Load `~/workspace/franchise-catalogs/<franchise>/catalog.csv`
2. Build MPN index (normalized with `shared/mpn-normalization.js`)
3. Match RFQ MPNs against:
   - `competitor_mpn` column (OEM parts with franchise replacements)
   - `distributor_mpn` column (customer asking for franchise part directly)

### Step 4: Workbook Generation

For each franchise with matches, generate `{RFQ}_{Franchise}_CrossRef.xlsx`:

**Tabs:**
| Tab | Contents |
|-----|----------|
| Summary | Per-line roll-up: RFQ MPN, MFR, Qty, Franchise MPN, Vendor, Match Grade |
| By MPN | Per asked MPN with all franchise alternatives aggregated |
| Detail | Per-hit detail rows with full catalog fields |

### Step 5: Email Response

Reply to sender with:
- HTML summary table showing matches per franchise
- One attachment per franchise with matches

---

## Output Format

### Email Subject
```
Franchise Cross-Ref — RFQ 1234567 (Customer Name) — HTC, ATGBICS
```

### Workbook Columns (Summary tab)

| Column | Description |
|--------|-------------|
| RFQ MPN | Customer's asked MPN |
| RFQ MFR | Customer's asked manufacturer |
| RFQ Qty | Quantity requested |
| Target Price | Customer's target price if provided |
| CPC | Customer Part Code |
| {Franchise} MPN | Franchise distributor's part number |
| Vendor Replaced | OEM vendor this replaces (Analog Devices, Intel, etc.) |
| Match Grade | Drop In Replacement, Conditional P2P, etc. (HTC only) |
| Match Type | "Cross-Ref" (OEM→Franchise) or "Direct" (asked for franchise MPN) |
| Package | Package type |
| Description | Part description or category |

---

## Catalog Storage

**Location:** `~/workspace/franchise-catalogs/`

```
franchise-catalogs/
  htc-korea/
    catalog.csv       # Parsed catalog data
    metadata.json     # Column mappings, keywords, display name
  atgbics/
    catalog.csv
    metadata.json
```

### metadata.json Schema

```json
{
  "name": "HTC Korea (TAEJIN)",
  "displayName": "HTC",
  "subjectKeywords": ["htc", "taejin", "htc korea"],
  "sourceFile": "htc_catalog.csv",
  "lastUpdated": "2026-06-22",
  "columnMapping": {
    "distributorMpn": "htc_mpn",
    "competitorMpn": "competitor_mpn",
    "vendor": "vendor",
    "matchGrade": "match_grade",
    "targetPkg": "target_pkg",
    "distributorPkg": "htc_pkg",
    "description": "major_difference"
  }
}
```

---

## Adding a New Franchise

### Step 1: Create Folder

```bash
mkdir ~/workspace/franchise-catalogs/<franchise-key>/
```

### Step 2: Add catalog.csv

Convert the franchise's catalog to CSV with at minimum:
- `competitor_mpn` — OEM part numbers this franchise replaces
- `distributor_mpn` — Franchise's own part numbers
- `vendor` — OEM brand being replaced

### Step 3: Add metadata.json

```json
{
  "name": "New Franchise Inc.",
  "displayName": "NewFran",
  "subjectKeywords": ["newfran", "nf"],
  "sourceFile": "source_spreadsheet.xlsx",
  "lastUpdated": "2026-06-22",
  "columnMapping": {
    "distributorMpn": "newfran_mpn",
    "competitorMpn": "competitor_mpn",
    "vendor": "oem_brand",
    "matchGrade": null,
    "targetPkg": null,
    "distributorPkg": null,
    "description": "description"
  }
}
```

### Step 4: Test

```bash
node "Trading Analysis/Franchise Catalog Cross-Reference/franchise-xref.js" <any-rfq> --franchise <franchise-key>
```

The system auto-discovers franchises by scanning `~/workspace/franchise-catalogs/*/metadata.json`.

---

## CLI Usage (Testing)

```bash
# All franchises
node franchise-xref.js 1234567

# Specific franchise
node franchise-xref.js 1234567 --franchise htc-korea

# Multiple franchises
node franchise-xref.js 1234567 --franchise htc-korea,atgbics
```

---

## Dependencies

- `shared/mpn-normalization.js` — MPN matching
- `shared/verified-send.js` — Email delivery (via vortex-poller)
- `exceljs` — Workbook generation
- `pg` Pool — RFQ queries

---

## Available Franchises

| Key | Display Name | Subject Keywords | Match Grade? |
|-----|--------------|------------------|--------------|
| `htc-korea` | HTC Korea (TAEJIN) | htc, taejin | Yes |
| `atgbics` | ATGBICS | atgbics, atg | No |

---

## Troubleshooting

### No matches found
1. Verify the RFQ has line items: `SELECT COUNT(*) FROM chuboe_rfq_line_mpn WHERE chuboe_rfq_id = (SELECT chuboe_rfq_id FROM chuboe_rfq WHERE value = '1234567')`
2. Check if MPNs are in the catalog: `grep -i "<mpn>" ~/workspace/franchise-catalogs/htc-korea/catalog.csv`
3. Test MPN normalization matches: The system strips hyphens, spaces, case for matching

### Catalog not loading
1. Verify `metadata.json` exists and is valid JSON
2. Check `catalog.csv` exists and has headers matching `columnMapping`
3. Run CLI with the franchise to see errors: `node franchise-xref.js 1234567 --franchise <key>`

### New franchise not recognized
1. Verify folder name matches the key you're using
2. Check `subjectKeywords` in metadata.json includes the keyword you're testing
3. Restart/re-run the poller if using email trigger (keywords are loaded at startup)
