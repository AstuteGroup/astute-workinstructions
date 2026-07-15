# OT New Manufacturer Check

Tool for verifying if a manufacturer exists in OT and confirming they are actually a manufacturer (not a distributor) via website analysis.

**Location:** `~/workspace/mfr-check/mfr-fuzzy-check.js`

## Purpose

When adding new manufacturers to OT, this tool helps:
1. **Fuzzy match** against existing OT manufacturers to avoid duplicates
2. **Check aliases** in the description field (e.g., "CET" matches "CET-MOS Technology Corp")
3. **Verify website** to confirm the company is a manufacturer, not a distributor

## Usage

```bash
# Basic fuzzy match against OT
node ~/workspace/mfr-check/mfr-fuzzy-check.js "Texas Instruments"

# With website verification
node ~/workspace/mfr-check/mfr-fuzzy-check.js "Acme Corp" --url https://acme.com

# Adjust similarity threshold (default 0.3)
node ~/workspace/mfr-check/mfr-fuzzy-check.js "Maxim" --threshold 0.5

# Auto-use URL from OT if found
node ~/workspace/mfr-check/mfr-fuzzy-check.js "Alif Semiconductor" --check-website
```

## Options

| Option | Description |
|--------|-------------|
| `--url <url>` | Website URL to check if manufacturer (not distributor) |
| `--check-website` | Auto-fetch URL from OT match if available |
| `--threshold <0-1>` | Similarity threshold (default: 0.3) |
| `--limit <n>` | Max results to return (default: 10) |

## Output

### Match Quality Levels

| Quality | Score | Meaning |
|---------|-------|---------|
| EXACT | 1.0 | Case-insensitive exact match on name |
| HIGH | >= 0.6 | Strong fuzzy match |
| MEDIUM | >= 0.4 | Moderate match, review recommended |
| LOW | >= threshold | Weak match |

### Match Field

- **name** - Matched against the manufacturer name
- **alias** - Matched against the description field (contains aliases like "M13275 - CET, Chino-Excel Technology")

### Website Classification

| Classification | Meaning |
|----------------|---------|
| MANUFACTURER | Strong manufacturer signals (we design, we produce, R&D, etc.) |
| LIKELY_MANUFACTURER | More manufacturer signals than distributor |
| DISTRIBUTOR | Strong distributor signals (authorized distributor, linecard, sourcing, etc.) |
| LIKELY_DISTRIBUTOR | More distributor signals than manufacturer |
| UNCERTAIN | Insufficient signals or blocked by bot protection |
| ERROR | Website couldn't be accessed |

## Examples

### Finding an existing manufacturer
```
$ node mfr-fuzzy-check.js "Texas Instruments"

Found 10 potential match(es):
   ID        | Score | Quality | Field | Name                           | Alias/Description
   1000000   |  1.00 | EXACT   | name  | Texas Instruments              | -

EXACT MATCH: "Texas Instruments" (ID: 1000000, Code: M05844)
```

### Finding via alias
```
$ node mfr-fuzzy-check.js "CET"

Found 5 potential match(es):
   ID        | Score | Quality | Field | Name                           | Alias/Description
   1020782   |  1.00 | HIGH    | alias | CET-MOS Technology Corp        | M13275 - CET, Chino-Excel Technology

Alias matches found: "CET-MOS Technology Corp" via "M13275 - CET, Chino-Excel Technology"
```

### Detecting a distributor
```
$ node mfr-fuzzy-check.js "K & J Magnetics" --url https://www.kjmagnetics.com

Website Analysis:
   Classification: DISTRIBUTOR (70% confidence)
   Distributor signals: supply chain, in stock, same day shipping
```

## Technical Details

- **Fuzzy matching:** PostgreSQL `pg_trgm` extension
  - `similarity()` for name field
  - `word_similarity()` for description/alias field (finds words within longer strings)
- **Website analysis:** Playwright with Chrome user-agent
  - Checks homepage + About page
  - 40+ manufacturer keywords, 35+ distributor keywords
- **Limitations:** Some large corporate sites block Playwright (bot protection)

## Decision Matrix

| OT Match? | Website Check | Action |
|-----------|---------------|--------|
| EXACT match | - | Use existing, do not add |
| HIGH match | Verify same company | May be duplicate, investigate |
| No match | MANUFACTURER | OK to add |
| No match | DISTRIBUTOR | Do NOT add as manufacturer |
| No match | ERROR/UNCERTAIN | Manual website review needed |
