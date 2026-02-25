# Astute Work Instructions & Automation

Work instructions, queries, and automation tools for Astute Analytics operations.

## Quick Start

See [MEMORY.md](MEMORY.md) for recent session history and workflow index.

## Workflows

### Trading & Sourcing

| Workflow | Location | Description |
|----------|----------|-------------|
| **RFQ Sourcing** | [`netcomponents_rfq/`](netcomponents_rfq/) | Automated NetComponents RFQ submission |
| **VQ Loading** | [`Trading Analysis/VQ Loading/`](Trading%20Analysis/VQ%20Loading/) | Process supplier quote emails into VQ template |
| **Market Offer Matching** | [`Trading Analysis/Market Offer Matching for RFQs/`](Trading%20Analysis/Market%20Offer%20Matching%20for%20RFQs/) | Match RFQs against customer excess/stock |
| **Quick Quote** | [`Trading Analysis/Quick Quote/`](Trading%20Analysis/Quick%20Quote/) | Generate baseline quotes from recent VQs |

### Operations & Tracking

| Workflow | Location | Description |
|----------|----------|-------------|
| **Order/Shipment Tracking** | [`Trading Analysis/saved-queries/`](Trading%20Analysis/saved-queries/) | Look up by COV, SO, MPN, customer PO |
| **Inventory File Cleanup** | [`Trading Analysis/Inventory File Cleanup/`](Trading%20Analysis/Inventory%20File%20Cleanup/) | Clean customer inventory uploads |

### Reporting & Analysis

| Workflow | Location | Description |
|----------|----------|-------------|
| **LAM Billings Review** | [`Trading Analysis/LAM Billings Review/`](Trading%20Analysis/LAM%20Billings%20Review/) | LAM revenue and margin analysis |
| **Seller Quoting Activity** | (ad-hoc) | VQ→CQ→SO funnel by seller |

## Work Instructions (Legacy)

Located in [`src/`](src/):
- [Introduction](src/overview.md)
- [How To Write a Work Instruction](src/CreateworkInstructions.md)
- [Writing Tickets](src/logilite_ticket_creation.md)
- [Consignment Reporting](src/ConsignmentReporting.md)
- [Date Code Requests](src/DateCodeRequests.md)
- [Placing Stock](src/PlacingStock.md)
- [Reassigning Customers](src/ReassigningCustomers.md)
- [Excess Cost Adjustments](src/ExcessCostAdjustments.md)

## Environment

- **Database**: `idempiere_replica` (read-only via `psql`)
- **Schemas**: `adempiere`, `intermediate`, `mart`
- **Automation**: Node.js + Playwright (for web automation)
