# VQ Loading Workflow

Process supplier quote emails into the VQ Mass Upload Template for import into OT.

---

## Quick Start

```bash
# Process new emails from VQ inbox
node ~/workspace/vq-parser/src/index.js fetch
```

Output: `~/workspace/vq-parser/output/VQ_{RFQ#}_{Sender}_{Timestamp}.csv`

---

## Detailed Instructions

See **[tasks/vq_loading.md](../../tasks/vq_loading.md)** for:
- Parser commands and options
- RFQ resolution logic (database MPN lookup)
- Partial data flags and MPN mismatch handling
- Field mappings and valid values
- Manual fallback steps

---

## Overview

Supplier quotes arrive at `vq@orangetsunami.com` via:
- Email body text/tables
- PDF attachments
- Excel/CSV attachments
- Hyperlinks to quote portals

The `vq-parser` tool extracts data from all sources, resolves RFQ numbers by MPN lookup, and generates upload-ready CSVs.

---

## Related

- [Market Offer Matching for RFQs](../Market%20Offer%20Matching%20for%20RFQs/README.md)
- [Quick Quote](../Quick%20Quote/)
