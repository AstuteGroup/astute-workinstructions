# Account Review Automation - Roadmap

**Last Updated:** 2026-07-15
**Status:** In Progress

---

## Current Priorities

### High Priority (Next Sprint)

1. **Write Workflow Documentation**
   - Create comprehensive user guide
   - Document command-line usage
   - Explain column meanings
   - Troubleshooting guide
   - **Complexity:** Low
   - **Impact:** High - enables self-service

### Medium Priority (Future Enhancements)

2. **Account Context Columns**
   - Add "Months Assigned" - How long seller has been ISE Steward
   - Add "First Assigned" - Earliest location assignment date
   - Add "Last Sale Date" - Most recent invoice date for this account
   - Provides tenure context for account relationship
   - **Complexity:** Medium
   - **Impact:** Medium
   - **Technical Notes:**
     - Months Assigned: Calculate from earliest `c_bpartner_location.created` where `chuboe_ise_steward_id = seller`
     - First Assigned: MIN(created) from `c_bpartner_location` for this seller
     - Last Sale Date: MAX(invoice_date) from invoices for this customer

---

## Backlog (Lower Priority)

3. **Batch Mode - Multiple Sellers**
   - Generate reports for all sellers at once
   - Email reports directly to sellers
   - **Use Case:** Quarterly review prep for all reps
   - **Complexity:** Medium

4. **Historical Trend Analysis**
   - Q-over-Q comparison (e.g., Q2 2026 vs Q1 2026)
   - Show growth/decline metrics
   - Trend indicators (↑/↓/→)
   - **Complexity:** High

5. **Auto-Fetch Infor CSVs**
   - If Infor API becomes available
   - Eliminate manual CSV download step
   - **Complexity:** Unknown (depends on Infor API availability)

6. **Customer Name Mapping Database**
   - Store OT ↔ Infor customer mappings
   - Learn from manual corrections
   - Reduce fuzzy matching errors over time
   - **Complexity:** Medium

7. **Scheduled GP Breakdown**
   - Show scheduled GP by order status (CO vs IP)
   - Show expected delivery dates
   - Highlight at-risk orders
   - **Complexity:** Medium

---

## Completed

- ✅ Build complete OT queries (Activities, RFQs, CQs, conversions)
- ✅ Create Infor CSV parsing logic (Booked/Invoiced GP)
- ✅ Implement customer name fuzzy matching
- ✅ Build "Not Assigned" section query
- ✅ Create Excel generation script with formatting
- ✅ Parameterize for any seller/quarter
- ✅ Add Scheduled GP calculation (open orders)
- ✅ Import GP Targets from Goals File (2026-07-15)
- ✅ Dynamic Scheduled GP column header with quarter (2026-07-15)
- ✅ Dynamic Strategies column header with quarter (2026-07-15)
- ✅ Visual indicators for inactive accounts - RED zeros in ASSIGNED section (2026-07-15)
- ✅ Quarter labels on historical columns (Activities Q2, RFQ Lines Q2, etc.)
- ✅ Tab name reflects forward quarter (Aaron Mendoza - Q3 2026)
- ✅ Column reordering (B to I and % of Inv Total before Scheduled GP)
- ✅ Freeze top row for scrolling

---

## Ideas / Deferred

- **Email Integration:** Auto-send reports to sellers
- **PowerBI Integration:** Push data to PowerBI datasets
- **Account Health Score:** Composite metric (activity + conversion + GP)
- **Alert System:** Flag accounts with declining metrics
