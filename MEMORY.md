# Claude Code Session Memory

This file tracks recent work sessions and provides quick context for continuing work.

## Recent Sessions

1. **RFQ Sourcing Automation** (2026-02-25)
   - Built NetComponents batch RFQ system with date code prioritization
   - Added quantity adjustment to encourage supplier quoting
   - Location: `netcomponents_rfq/`

2. **LAM Billings Review** (2026-02-25)
   - Created LAM revenue/margin analysis queries
   - Location: `Trading Analysis/LAM Billings Review/`

3. **VQ Loading Workflow** (2026-02-24)
   - Supplier quote email processing to VQ template
   - Location: `Trading Analysis/VQ Loading/`

4. **Market Offer Matching for RFQs** (2026-02-17)
   - Match RFQs against customer excess and stock offers
   - Location: `Trading Analysis/Market Offer Matching for RFQs/`

---

## Workflow Index

### Active Workflows

| Workflow | Location | Description |
|----------|----------|-------------|
| **RFQ Sourcing** | `netcomponents_rfq/` | Automated supplier RFQ submission via NetComponents |
| **VQ Loading** | `Trading Analysis/VQ Loading/` | Process supplier quotes into VQ template |
| **Market Offer Matching** | `Trading Analysis/Market Offer Matching for RFQs/` | Match RFQs to customer excess/stock |
| **Quick Quote** | `Trading Analysis/Quick Quote/` | Generate baseline quotes from recent VQs |
| **Order/Shipment Tracking** | `Trading Analysis/saved-queries/` | Look up tracking by various identifiers |

### Analysis & Reporting

| Workflow | Location | Description |
|----------|----------|-------------|
| **LAM Billings Review** | `Trading Analysis/LAM Billings Review/` | LAM revenue and margin analysis |
| **Seller Quoting Activity** | (ad-hoc queries) | VQ→CQ→SO funnel analysis by seller |
| **Inventory File Cleanup** | `Trading Analysis/Inventory File Cleanup/` | Clean customer inventory uploads |

---

## Key Files

### RFQ Sourcing (`netcomponents_rfq/`)
- `python/submit_rfqs.py` - Single part RFQ submission
- `python/batch_rfqs_from_system.py` - Batch RFQ from iDempiere extract
- `python/list_suppliers.py` - Preview suppliers without submitting
- `python/config.py` - Credentials, supplier selection logic, date code parsing
- `node/.env` - NetComponents credentials (shared)

### Database Access
- Connection: `psql` (no password needed)
- Schemas: `adempiere`, `intermediate`, `mart`
