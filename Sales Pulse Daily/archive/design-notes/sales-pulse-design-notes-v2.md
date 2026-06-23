# Sales Pulse Daily Digest — Design Notes v2

## Files Created

1. **sales-pulse-daily-sample-v2.html** — HTML version (UPDATED with all changes)
2. **sales-pulse-daily-sample-v2.txt** — Plain text version (UPDATED)
3. This design notes document (v2)

## Updates from v1 → v2

### ✅ Layout Changes
- **Adopted Option 1**: Grouped by Funnel Stage (Pipeline Input, Quoting Activity, Wins, System Discipline)
- Clearer metric definitions with exact OT field mappings
- Added distinct customer counts for RFQ and CQ lines

### ✅ New Metrics Added
1. **VQ Sourcing Metrics** (3 new measurements):
   - Buyer Queue Time (RFQ routed → picked by buyer)
   - Sourcing Cycle Time (picked → VQ loaded)
   - Total VQ Response Time (end-to-end)

2. **Dual Quote Age Metrics** (Option C):
   - Short-cycle avg (Shortage/PPV/Other with 10-30d auto-close)
   - Long-cycle avg (Mil-Aero/EOL/Obsolete/LTB with 64d auto-close)

3. **System Discipline Metrics**:
   - % CQs entered within 2hrs of marking 'sold'
   - % Retroactive CQ entry (entered after sold)

4. **CQ Lines Sold** — separate from SO Lines Booked (shows seller discipline in marking quotes)

### ✅ Regional Changes
- **APAC drilled down** to show:
  - Laurel Kee (Singapore)
  - Kris Munoz aka Silvia (Philippines/China)
  - Lavanya Manohar (India)
  - Edyna Lee (Korea) — included until replacement

- **Regional table expanded** with new columns:
  - RFQ Lines with VQs (sourcing %)
  - VQ Response Time
  - CQ Lines Sold (separate from SO Lines)

### ✅ System Discipline Positioning
- Moved to **bottom of Global Snapshot** (high visibility)
- Added note: "These numbers reflect OT activity only. Actual pipeline may be higher due to off-system work."

---

## The 5 Key Questions (Expanded to 7)

| Question | Metrics | Why It Matters |
|----------|---------|----------------|
| **"Are opportunities flowing in?"** | RFQ Lines Entered, Distinct Customers | Leading indicator of pipeline health |
| **"Are we sourcing fast enough?"** | RFQ Lines with VQs, Buyer Queue Time, Sourcing Cycle Time, Total VQ Response Time | Identifies sourcing bottlenecks |
| **"Are we converting to quotes?"** | CQ Lines Entered, Distinct Customers | Velocity check |
| **"Are we closing quotes?"** | CQ Lines Sold, Avg Quote Age (short/long) | Health of active pipeline |
| **"What did we win?"** | SO Lines Booked, $ Booked | Celebration + validation |
| **"What's stuck?"** | Aging quotes, RFQs with no VQs | Intervention needed TODAY |
| **"Are we using the system properly?"** | Timely CQ entry %, Retroactive CQ % | System discipline / data quality |

---

## Metric Definitions (For SQL Implementation)

### Pipeline Input

| Metric | Definition | SQL Logic |
|--------|------------|-----------|
| **RFQ Lines Entered in OT** | Distinct RFQ lines created yesterday | `COUNT(DISTINCT chuboe_rfq_line.chuboe_rfq_line_id)` WHERE `chuboe_rfq.created::date = yesterday` |
| **Distinct Customers (RFQ)** | Distinct customers with RFQs yesterday | `COUNT(DISTINCT chuboe_rfq.c_bpartner_id)` |
| **RFQ Lines with 1+ VQ** | RFQ lines that have at least one VQ | Join `chuboe_vq` to RFQ lines, count distinct RFQ lines with VQs |
| **Buyer Queue Time** | Avg days from RFQ routed to buyer queue → picked by buyer | **NEED TO DETERMINE:** What fields track "routed to buyer" and "picked by buyer"? Status changes? Custom fields? |
| **Sourcing Cycle Time** | Avg days from RFQ line picked by buyer → first VQ loaded | `AVG(chuboe_vq.created - [buyer_pick_timestamp])` |
| **Total VQ Response Time** | End-to-end: RFQ routed → VQ loaded | `AVG(chuboe_vq.created - [routed_timestamp])` |

### Quoting Activity

| Metric | Definition | SQL Logic |
|--------|------------|-----------|
| **CQ Lines Entered in OT** | CQ order lines created yesterday | `COUNT(DISTINCT c_orderline.c_orderline_id)` WHERE `c_order.issotrx='N'` AND `c_order.created::date = yesterday` |
| **Distinct Customers (CQ)** | Distinct customers quoted yesterday | `COUNT(DISTINCT c_order.c_bpartner_id)` WHERE issotrx='N' |
| **CQ Lines Sold** | CQ lines marked as 'sold' | **NEED TO DETERMINE:** How is "sold" tracked? `docstatus`? Custom field? Linked to SO? |
| **Avg Quote Age - Short-cycle** | Open CQs for Shortage/PPV/Other RFQ types | Filter by RFQ type, `AVG(CURRENT_DATE - c_order.created::date)` WHERE status = open |
| **Avg Quote Age - Long-cycle** | Open CQs for Mil-Aero/EOL/Obsolete/LTB | Same as above, different RFQ type filter |

### Wins

| Metric | Definition | SQL Logic |
|--------|------------|-----------|
| **SO Lines Booked** | Sales order lines created yesterday | `COUNT(DISTINCT c_orderline.c_orderline_id)` WHERE `c_order.issotrx='Y'` AND `c_order.dateordered::date = yesterday` |
| **$ Booked** | Sum of SO line amounts | `SUM(c_orderline.linenetamt)` |

### System Discipline

| Metric | Definition | SQL Logic |
|--------|------------|-----------|
| **CQs entered within 2hrs of sold** | % of CQ lines where quote created timestamp is within 2hrs of being marked sold | **NEED TO DETERMINE:** What timestamp indicates "marked sold"? CQ docstatus change? SO creation? |
| **Retroactive CQ entry rate** | % of sold CQs where quote was created AFTER the SO date | Compare `c_order.created` (CQ) to linked SO `dateordered` |

---

## Auto-Close Rules (For Avg Quote Age Calculation)

| RFQ Type | Auto-Close Window | Category |
|----------|-------------------|----------|
| Shortage | 10 business days | Short-cycle |
| PPV / Cost Saving | 15 business days | Short-cycle |
| All Other | 30 business days | Short-cycle |
| Mil-Aero | 64 business days | Long-cycle |
| EOL | 64 business days | Long-cycle |
| Obsolete | 64 business days | Long-cycle |
| LTB (Last Time Buy) | 64 business days | Long-cycle |

**Implementation Note:** For "open quote" calculation, only include CQs that:
1. Are not marked sold/lost/closed
2. Have not exceeded their auto-close window
3. Are linked to an RFQ with identifiable type

If RFQ type is unknown, default to "All Other" (30-day window).

---

## Org Structure (Final)

### USA (Jeff Wallace - Director of Sales)
**9 sellers:** Aaron Mendoza, Dan Reiser, Jake McAloose, James Diaz, Josh Syre, Justin Goodwin, Michael Stifter, Thomas Haynes, Will Rob

*(Melissa Bojar excluded — Sales Productivity Analyst, not a seller)*

### MEX (Joel Marquez - Sales Manager)
**9 sellers:** Alejandro Padilla, Alex Partida, Alfredo Martinez, Carlos Moreno, Carolina Hinestroza, Joel Flores, Juan Botero, Ricardo Morales, Salvador Horner

### APAC (Multiple Managers)

**Laurel Kee** (Regional Sales Manager, Singapore) — 3 sellers:
- Ivy Chew, Jasper Kee, Ray Ng

**Kris Munoz aka Silvia** (Sales Manager, Philippines/China) — 5 sellers:
- James Xu, Joy Phromsatcha, Spring Tu, Wing Zhang, Winnie Lee

**Lavanya Manohar** (Sales Manager, India) — 3 sellers:
- Manikandan Subramani, Meenakshi Chidambaram, NANDHINI .

**Edyna Lee** (Director of Sales, Korea) — 0 direct reports (reports to Josh Pucci):
- Include in daily until replacement hired

**Total:** ~37 active sales employees across 3 regions

---

## SQL Data Model Questions (To Resolve Before Building Queries)

### 1. **VQ Timing Workflow**
- **Q:** How is "RFQ routed to buyer queue" tracked in OT?
  - Is there a status field on `chuboe_rfq` or `chuboe_rfq_line`?
  - Custom field? Workflow log?

- **Q:** How is "RFQ line picked by buyer" tracked?
  - Status change? Assignment field (`buyer_id`)?
  - Timestamp field?

- **Context provided:** VQs often bulk uploaded by data entry or Claude Harris (AI) for APAC buyers

### 2. **CQ "Sold" Status**
- **Q:** How is a CQ line marked as "sold"?
  - `c_order.docstatus` = specific value?
  - Link to SO exists (`c_order.ref_order_id`)?
  - Custom field/flag?

- **Q:** What timestamp indicates when it was marked sold?
  - Docstatus change log?
  - SO creation date as proxy?

### 3. **Open Quote Definition**
- **Q:** How to identify "open" CQs (not sold/lost/closed)?
  - No linked SO?
  - Specific `docstatus` value?
  - Active flag + date range?

### 4. **RFQ Type Field**
- **Q:** Where is RFQ type stored (Shortage, PPV, Mil-Aero, EOL, etc.)?
  - `chuboe_rfq.rfqtype` or similar?
  - Custom field?
  - Lookup table?

### 5. **Regional Mapping**
- **Q:** How to map RFQ/CQ/SO to region?
  - Via `salesrep_id` → lookup user → manager → region?
  - Custom region field on BP or order?

**Action:** Read `shared/data-model.md` to answer these, then build SQL queries.

---

## Next Steps

### Phase 1: Data Model Research (You are here)
- [x] Define metrics and format
- [x] Get user approval on layout
- [ ] Read `shared/data-model.md` to answer SQL questions above
- [ ] Identify exact fields/tables for each metric

### Phase 2: SQL Query Development
- [ ] Write global snapshot queries (10 metrics)
- [ ] Write regional breakdown queries (7 metrics × 4 regions + 4 APAC sub-regions)
- [ ] Write "Needs Attention" queries (3 alert types)
- [ ] Write "Yesterday's Wins" query (with seller names)
- [ ] Write "Week-to-Date" queries

### Phase 3: Build Mart Tables (Optional but Recommended)
- [ ] Create `mart.sales_pulse_daily_snapshot` (historical tracking)
- [ ] Create `mart.sales_pulse_regional` (regional metrics)
- [ ] Create `mart.sales_pulse_blockers` (aging quotes, stuck RFQs)
- [ ] Schedule daily refresh (cron at 5:45am PT)

### Phase 4: Email Automation
- [ ] Node.js script to run queries + format HTML
- [ ] Email delivery via `nodemailer`
- [ ] Schedule cron job (6:00am PT daily, Mon-Fri)
- [ ] Set recipients (Josh, Jeff, Joel, Laurel, Kris, Lavanya, Edyna)

### Phase 5: Iterate & Refine
- [ ] Tune thresholds (aging quote buckets, VQ response time targets, etc.)
- [ ] Add Friday special version (full week summary)
- [ ] Potentially add Power BI integration

---

## Open Questions for Next Review

1. **VQ timing fields** — need to confirm data model before building queries
2. **CQ "sold" status** — how is this tracked? Docstatus? Linked SO? Custom field?
3. **Weekly targets** — are 50 SO lines / $350K the right targets? Vary by region?
4. **Thresholds** — when do we show ✅ vs ⚠️ vs 🔥?
   - Quote age: <7d = ✅, 7-10d = ⚠️, >10d = 🔥?
   - VQ response time: <2d = ✅, 2-3d = ⚠️, >3d = 🔥?
5. **Friday version** — do you want a special Friday digest with full week summary?
6. **Seller names in wins** — always show, or only for deals >$X?
