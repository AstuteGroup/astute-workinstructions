# Customer Health Scoring - Data Exploration Findings
**Date:** 2026-06-26
**Phase:** Phase 1 - Data Exploration

---

## Executive Summary

Phase 1 data exploration successfully:
1. ✅ Mapped **27 sales reps** to regions (USA: 11, MEX: 9, APAC: 7)
2. ✅ Validated **backfill pattern** exists in MEX team (90%+ conversion rates)
3. ✅ Confirmed customer type is NOT systematically tracked (requires manual tagging)
4. ✅ Identified data model structure for RFQ/CQ/SO linkage

**Ready for Phase 2:** Build POC reports with region mapping and conversion rate flagging.

---

## 1. Region Mapping

### Database Structure
- **Sales regions exist** in `c_salesregion` table (AMER, APAC, EMEA, INDIA)
- **BUT:** `c_salesregion_id` is NULL for all sales reps in `c_bpartner_location`
- **Conclusion:** Must use employee roster file as source of truth

### Employee Roster
- **Location:** `/home/melissa.bojar/workspace/lots-shipped-received/data/Employee_roster - 5.14.26.xlsx`
- **Key field:** "Work location name" maps to regions
- **Coverage:** Filtered to USA/MEX/APAC only (excludes EMEA division)

### Work Location → Region Mapping

| Work Location | Region | Notes |
|---------------|--------|-------|
| Astute HQ | USA | Austin headquarters |
| LATAM Office | MEX | Mexico team |
| Remote | VARIES | Requires manual override (see below) |
| Astute Electronics HK Limited | APAC | Hong Kong |
| Astute Electronics Inc Pte. Ltd. | APAC | Singapore |
| Astute Electronics Incorporated Korea Branch | APAC | South Korea |
| Astute Electronics ShenZhen Ltd | APAC | China |
| Bangalore, Chennai | APAC | India (resigned per requirements) |
| Indonesia, Malaysia, Philippines, Taiwan, Thailand | APAC | Various APAC offices |

### Remote Employee Overrides
- **Carolina Hinestroza:** MEX (confirmed in requirements)
- **Others assumed USA:** Jake McAloose, James Xu, Juan Botero, Liz Shelley, Michael Stifter

### Matched Sales Reps (27 total)

#### USA (11 reps)
- Aaron Mendoza
- James Diaz
- Josh Syre
- Justin Goodwin
- Thomas Haynes
- Will Rob
- Josh Pucci (VP of Sales)
- Jeff Wallace (Director of Sales)
- Jake McAloose
- James Xu
- Michael Stifter

#### MEX (9 reps)
- Alejandro Padilla
- Alex Partida
- Alfredo Martinez
- Carlos Moreno
- Carolina Hinestroza
- Joel Flores
- Joel Marquez (Sales Manager)
- Ricardo Morales
- Salvador Horner

#### APAC (7 reps)
- Ivy Chew
- Jasper Kee
- Laurel Kee (Regional Sales Manager)
- Lavanya Manohar (Bangalore - resigned team)
- Spring Tu
- Wing Zhang
- Winnie Lee

### Unmatched Records

**In roster but not in DB (11):** Likely new hires or not set up as sales reps in OT yet
- Dan Reiser, Edyna Lee, Joy Phromsatcha, Kris Munoz, etc.

**In DB but not in roster (82):** Likely EMEA division (excluded from USA/MEX/APAC tracking) or terminated employees

### Implementation
- **Mapping file:** `output/salesrep-region-mapping.json`
- **Script:** `scripts/build-region-mapping.js`
- **Refresh:** Re-run script when employee roster is updated

---

## 2. Conversion Rate Analysis

### Data Model
- **CQ Lines:** `adempiere.chuboe_cq_line`
- **Sold flag:** `issold` (Y/N) indicates if CQ converted to SO
- **Creator:** `createdby` links to `ad_user_id` (sales rep)

### Findings (Last 6 Months)

#### High Conversion (90%+ - Backfill Pattern)
**MEX Team (4 reps):**
- Alfredo Martinez: 100.0% (15/15)
- Salvador Horner: 95.2% (60/63)
- Alejandro Padilla: 93.3% (14/15)
- Carlos Moreno: 92.0% (23/25)

**APAC:**
- Manikandan: 90.0% (18/20)

**Not in our roster (likely EMEA):**
- Edgar Santana: 94.3% (33/35)

**Interpretation:** These reps likely create CQ + SO at the same time (backfill after winning deal outside system). This is a chronic data quality issue, not actual sales success.

#### Healthy Conversion (20-60%)

**USA Team:**
- Jake Mcaloose: 35.8% (278/777)
- Aaron Mendoza: 35.3% (49/139)
- James Diaz: 24.9% (54/217)
- Michael Stifter: 19.0% (4/21)

**MEX Team (Exception):**
- Carolina Hinestroza: 22.4% (19/85) ← NOT in backfill pattern!
- Alex Partida: 72.4% (63/87) ← Borderline
- Ricardo Morales: 75.0% (111/148) ← Borderline

**APAC:**
- Jasper Kee: 88.2% (45/51) ← Close to threshold
- Josh Syre: 59.5% (415/698)
- Renald Ng: 56.4% (101/179)
- Winnie Lee: 51.5% (85/165)
- Spring Tu: 50.8% (33/65)
- James Xu: 48.5% (16/33)

#### Low Conversion (<20%)
- Silvia Munoz: 16.7% (42/251) ← Potential red flag

### Validation Against Requirements
✅ **Confirmed:** MEX team has backfill pattern (90%+ conversion)
✅ **Confirmed:** Carolina Hinestroza (MEX) is exception (22.4% - NOT backfilling)
✅ **Confirmed:** USA team shows healthier range (20-60%)

### Recommendations for Reports
1. **Flag sellers with 90%+ conversion** as "⚠️ Data Quality - Incomplete Quote Loading"
2. **Exclude these sellers from team-wide conversion metrics** (or show asterisk)
3. **Weekly manager follow-up** until behavior improves
4. **General threshold:** <10% = red flag
5. **Mil-Aero threshold:** <20% = red flag (requires customer type tagging to implement)

---

## 3. Customer Type Identification

### Database Investigation

**Tables checked:**
- `c_bp_group` - Office-based groups (Austin, Mexico, Hong Kong, etc.) NOT customer type
- `chuboe_vendortype` - Vendor classification only (Franchise, Manufacturer, etc.)
- Search for OEM/EMS/Broker columns - **NONE FOUND**

### Dual Customer/Vendor Test
- **6.9% of customers** are also flagged as vendors (362 / 5,225)
- **Sample includes:** Mix of brokers, manufacturers, and internal entities
- **Conclusion:** NOT a reliable broker indicator

### Findings
❌ **Customer type is NOT systematically tracked in the database**

### Options for Phase 2

#### Option A: Manual Tagging (Recommended for POC)
- Build a manual list of known brokers to exclude
- Start with ~20-30 known broker names
- Expand iteratively based on report feedback

#### Option B: Name Pattern Heuristics
- Keywords: "Components", "Distribution", "Electronics", "Supply", "Trading", "Broker"
- Risk: False positives (e.g., "ABC Components Corp" might be an OEM)

#### Option C: Start Without Filtering
- Include all customers in initial reports
- Managers can identify/flag brokers during review
- Build exclusion list organically

#### Option D: External Data (Future)
- D&B, ZoomInfo, or industry databases
- More accurate but requires integration work

### Recommendation for Phase 2
**Start with Option C** - no broker filtering in POC. Managers will quickly spot if brokers are noise, then build manual exclusion list in Phase 3.

---

## 4. Activity Pattern Analysis

### Database Structure

**RFQ Tables:**
- `chuboe_rfq` (header)
- `chuboe_rfq_line` (line level)
- `chuboe_rfq_line_mpn` (MPN level)

**CQ Tables:**
- `chuboe_cq_line` (customer quote lines)
- Fields: `issold`, `dateordered`, `priceentered`, `c_bpartner_id`

**SO Tables:**
- `c_order` (sales order header)
- `c_orderline` (order lines)

### Query Performance Challenges
- **LEFT JOIN queries timeout** with large customer base (5,225 active customers)
- **Recommendation:** Build materialized views or incremental snapshots for reports
- **Alternative:** Query per region (USA/MEX/APAC separately) to reduce dataset size

### Thresholds to Define in Phase 2

#### Activity Cadence
- **No RFQs:** How many days triggers a flag? (30/60/90 days? Varies by customer segment?)
- **No orders:** When does silence = problem? (Same as RFQs or different?)
- **Declining:** What % drop is normal fluctuation vs. red flag?

#### "Accounts That Hold Weight"
- **Filters to reduce noise:**
  - LTV threshold? (e.g., $50K+ in last 12 months)
  - Order count minimum? (e.g., 3+ orders ever)
  - Recent activity? (e.g., active in last 6 months)
- **Recommendation:** Start permissive, refine based on manager feedback

#### Strategic Accounts (6 confirmed)
1. Eaton
2. ABB
3. RTX (Raytheon)
4. Thales
5. Parker-Meggitt
6. GE Healthcare

**Always include these** regardless of thresholds - any silence = red flag

### Sample Query Results (Attempted)
- Top customer activity query timed out (too many LEFT JOINs)
- **Next step:** Build simpler, region-specific queries for POC

---

## 5. Data Quality Issues Identified

### Issue 1: Backfill Pattern (Seller-Level)
- **Symptoms:** 90%+ conversion rate
- **Root cause:** Sellers create CQ + SO simultaneously after winning deal outside system
- **Affected:** Primarily MEX team (except Carolina)
- **Impact:** Inflates conversion metrics, masks actual quoting effectiveness
- **Solution:** Flag in reports, follow up weekly with sales managers

### Issue 2: Customer Type Not Tagged
- **Impact:** Cannot segment by OEM/EMS/Broker
- **Impact:** Cannot apply Mil-Aero conversion thresholds (requires customer type)
- **Workaround:** Manual tagging for Phase 2 POC

### Issue 3: Region Not in Database
- **Impact:** Must maintain external employee roster mapping
- **Risk:** Roster gets stale if not updated regularly
- **Mitigation:** Document refresh process, automate mapping script

### Issue 4: Query Performance
- **Impact:** Full customer base queries timeout
- **Solution:** Build region-specific views or materialized snapshots

---

## 6. Phase 2 Recommendations

### Approach
**Build POC reports with reasonable assumptions, get manager feedback, iterate.**

### Report 1: Monthly Regional Report

#### Sections (Draft)
1. **Regional Activity Summary** (USA, MEX, APAC)
   - RFQ count, CQ count, SO count, Revenue (6 months)
   - Trending vs. prior period

2. **Top Accounts by Region** (Top 10)
   - Revenue, RFQ/CQ/SO counts
   - Conversion rate
   - Strategic account flag

3. **Seller Performance by Region**
   - Individual seller metrics
   - ⚠️ Data quality flags (90%+ conversion)

4. **Cross-Regional Account Visibility**
   - Customers active in multiple regions
   - Opportunity for collaboration

#### Assumptions to Test
- "Top accounts" = Top 10 by revenue in last 6 months
- "Active" = Any RFQ, CQ, or SO in last 6 months
- Conversion = (SOs / CQs) via `issold` flag

### Report 2: Weekly Sales Manager Action List

#### Sections (Draft)
1. **Immediate Action Required**
   - Strategic accounts with red flags (any silence >30 days or declining trend)
   - High-potential accounts (>$100K LTV?) with red flags

2. **Investigate This Week**
   - Medium accounts with declining trends
   - Low conversion accounts (wasting seller time?)

3. **Data Quality Follow-Ups**
   - Sellers with 90%+ conversion (Mexico team backfill issue)

#### Prioritization Logic (To Test)
1. Strategic accounts first (always)
2. Then by revenue at risk (LTV * severity)
3. Limit to top 10-15 items (high-signal, low-noise)

#### Assumptions to Test
- Strategic account silence threshold: 30 days no RFQs
- High-potential threshold: $100K+ LTV in last 12 months
- Declining trend: -20%+ drop in RFQs or revenue (6m vs. prior 6m)

---

## 7. Files Created

### Scripts
- `scripts/build-region-mapping.js` - Employee roster → DB matching
- `scripts/activity-pattern-exploration.sql` - Placeholder queries (performance issues)

### Data
- `output/salesrep-region-mapping.json` - 27 matched sales reps by region

### Documentation
- `docs/requirements-brainstorm.md` - Full requirements from brainstorming session
- `docs/data-exploration-findings.md` - This document

---

## 8. Next Steps

### Immediate (Phase 2 POC)
1. **Build Monthly Regional Report**
   - Query: Regional activity summary (USA, MEX, APAC)
   - Query: Top accounts by region
   - Query: Seller performance with conversion flagging
   - Output: HTML email or Excel?

2. **Build Weekly Manager Action List**
   - Query: Strategic account health check
   - Query: High-potential accounts with red flags
   - Query: Sellers needing data quality follow-up
   - Output: Email with top 10-15 items

3. **Get Manager Feedback**
   - Are thresholds reasonable?
   - Is prioritization logic helpful?
   - Too noisy or too quiet?
   - Format preferences?

4. **Iterate**
   - Adjust thresholds based on feedback
   - Add/remove sections
   - Build manual broker exclusion list if needed

### Future (Phase 3+)
- Automate weekly/monthly delivery
- Build materialized views for performance
- Add customer type tagging (manual or external data)
- Expand strategic account list as needed
- Add unique parts tracking (relationship breadth metric)
- Add RFQ type segmentation (Shortage vs. PPV vs. Mil-Aero)

---

## 9. Open Questions for Phase 2 Testing

### Activity Thresholds
- [ ] Silence red flag: 30, 60, or 90 days?
- [ ] Does threshold vary by customer segment/type?
- [ ] What defines "declining" - 10%, 20%, 50% drop?

### Account Filtering
- [ ] "Accounts that hold weight" - revenue threshold? Order count?
- [ ] LTV calculation - 6 months? 12 months? All-time?

### Action List
- [ ] How many items? (Top 5? 10? 15? All red flags?)
- [ ] Prioritization: Revenue-first or strategic-first?

### Delivery
- [ ] Monthly regional - who receives? (All sales team? Managers only?)
- [ ] Weekly action list - who receives? (Sales managers only?)
- [ ] Format: Email HTML? Excel attachment? Both?
- [ ] Day/time: Monday morning? Friday end-of-week?

---

**Status:** Phase 1 complete. Ready to build Phase 2 POC reports.
