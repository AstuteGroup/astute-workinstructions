# VQ Parser

Parse vendor quote emails into ERP-ready CSV files for mass upload.

## Features

- **Email Integration**: Connects to `vq@orangetsunami.com` via Himalaya IMAP
- **Multi-Source Extraction**: Parses PDFs (pdf.js-extract), Excel/CSV (xlsx), and hyperlinks (Playwright)
- **RFQ Resolution**: Matches quoted MPNs to database RFQs using fuzzy matching
- **MPN Validation**: Filters invalid MPNs (table headers, labels) with subject line fallback
- **93% Success Rate**: Progressive character trimming for partial MPN matches

## Setup

```bash
cd ~/workspace/vq-parser
npm install
```

Requires `.env` file with IMAP credentials (not tracked in git).

## Usage

```bash
# Fetch and process new emails
node index.js fetch --limit 50

# Parse a single .eml file (testing)
node index.js parse /path/to/email.eml --verbose

# Consolidate outputs into upload-ready files
node index.js consolidate

# Check processing status
node index.js status

# Test IMAP connection
node index.js test-connection
```

## Output

- `output/uploads/VQ_UPLOAD_*.csv` - Ready for ERP import
- `output/uploads/VQ_UNKNOWN_*.csv` - Needs manual RFQ assignment
- `output/archive/` - Processed source files

## Key Files

| File | Description |
|------|-------------|
| `index.js` | CLI entry point |
| `mapper/field-mapper.js` | MPN validation, field mapping |
| `mapper/rfq-resolver.js` | Multi-strategy RFQ lookup with fuzzy matching |
| `parser/multi-source-extractor.js` | PDF/Excel/link extraction |
| `email/fetcher.js` | Himalaya IMAP integration |

## RFQ Resolution Strategies

1. **Exact MPN match** - Direct database lookup
2. **Email body extraction** - Parse original MPN from NetComponents format
3. **Fuzzy matching** - Progressive character trimming (min 5 chars)
4. **Subject line fallback** - Extract MPN from email subject
