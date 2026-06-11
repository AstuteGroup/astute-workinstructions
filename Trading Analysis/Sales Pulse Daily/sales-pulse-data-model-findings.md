# Sales Pulse Daily - Data Model Findings

## VQ Timing Workflow

**Finding**: Buyer queue workflow timing is NOT reliably tracked in timestamps.

### What EXISTS:
- Queue checkboxes on RFQ line: `chuboe_amer/apac/emea/india_cpc2buyerqueue` (Y/N)
- `chuboe_buyer_id` on VQ line (assigned buyer)
- `created` timestamp on RFQ line and VQ line

### What DOES NOT EXIST:
- No timestamp for when RFQ line pushed to buyer queue
- No timestamp for when buyer "picked" the line from queue
- The `updated` field on RFQ line doesn't reliably capture queue push time
- Changelog table doesn't have queue checkbox changes

### RECOMMENDATION:
Use simpler, more reliable metrics:
- **Total VQ Response Time**: `AVG(vq.created - rfq_line.created)`
- **RFQ Lines with VQs**: `COUNT(DISTINCT rfq_line with 1+ VQ) / COUNT(DISTINCT rfq_line)`

**Drop the 3-part breakdown (Queue Time / Sourcing Time / Total Time) from the v5 design.**

---

## CQ Sold Status

**Finding**: Sold status is tracked with flag + timestamp.

### Fields:
- `issold` = 'Y'/'N' flag (marks CQ as sold)
- `r_status_id` = 1000026 (Closed status for sold CQs)
- `chuboe_cq_resolution_id` = resolution reason (1000004 = Won, etc.)
- `created` = when CQ was created
- `updated` = when CQ was last modified (proxy for "marked sold" timestamp)

### For Metrics:
- **CQ Lines Sold**: WHERE `issold = 'Y'`
- **Sold timestamp**: Use `updated` field
- **System Discipline (timely entry)**: Compare CQ `created` to CQ `updated` (within 2 hours = timely)
- **Retroactive entry**: CQ `created` > linked SO `dateordered` (created after the sale happened)

---

## RFQ Type

**Location**: `chuboe_rfq.chuboe_rfq_type_id` (header level, not line level)

### Type IDs:
- 1000001 = Shortage
- 1000002 = PPV
- 1000003 = EOL/LTB
- 1000000 = Stock
- 1000004 = Hot Parts
- 1000006 = Unqualified Spot RFQ

### Auto-Close Windows (from design doc):
- Shortage: 10 business days
- PPV/Cost Saving: 15 business days
- Other: 30 business days
- Mil-Aero/EOL/Obsolete/LTB: 64 business days

---

## Open Quote Definition

**Logic**: CQ is "open" if:
1. `issold = 'N'` (not marked sold)
2. Within auto-close window based on RFQ type
3. `isactive = 'Y'`

---

## Regional Mapping

**Source**: Employee roster + org structure from design doc

### Regions:
- **USA** (Jeff Wallace): 9 sellers
- **MEX** (Joel Marquez): 9 sellers
- **APAC** (multiple managers): 11 sellers
  - Laurel Kee (Singapore): 3 sellers
  - Kris Munoz/Silvia (Philippines/China): 5 sellers
  - Lavanya Manohar (India): 3 sellers

**Mapping approach**: Via `salesrep_id` → `ad_user.name` → lookup in org structure

---

## Key Finding: Simplify VQ Timing Metrics

The v5 design had 3 separate VQ timing metrics:
1. Buyer Queue Time (routed → picked)
2. Sourcing Cycle Time (picked → VQ loaded)
3. Total VQ Response Time (end-to-end)

**These can't be reliably measured** because queue push/pick timestamps don't exist.

**Proposed simplification**:
- Drop metrics #1 and #2
- Keep only: **VQ Response Time** = `AVG(vq.created - rfq_line.created)` for lines with VQs
- Add: **VQ Coverage %** = % of RFQ lines with at least 1 VQ

This is cleaner, more reliable, and still answers the key question: "Are we sourcing fast enough?"
