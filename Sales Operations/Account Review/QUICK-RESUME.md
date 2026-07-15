# Account Review Project - Quick Resume

**When user says:** "Let's pick up the Account Review project"

**Display this list immediately:**

---

## 📋 Where We Left Off

### ✅ Completed
1. **Project folder created** - `Sales Operations/Account Review/`
2. **Template analyzed** - Aaron Mendoza Q2 2026 example
3. **Database schema explored** - All tables and relationships identified
4. **Test queries validated** - OT metrics query working
5. **Infor data parsed** - Booked/Invoiced CSV structure understood
6. **Context reviewed** - User role, systems, data architecture documented

### 🎯 Next Steps (Ready to Build)

**Priority 1: Core Automation**
1. Build complete OT queries (use `created` date as specified)
2. Create Infor CSV parser for Booked/Invoiced GP
3. Implement customer name fuzzy matching (OT ↔ Infor)
4. Build "Not Assigned" section query
5. Create Excel generation script with formatting

**Priority 2: Integration**
6. Add Scheduled GP calculation (open orders)
7. Import GP Targets from goals file
8. Parameterize for any seller/quarter

**Priority 3: Documentation**
9. Write workflow documentation
10. Create usage guide

---

## 📊 Key Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Date field** | `created` (not `dateordered`) | User specified - label as "Booked Created Date" |
| **GP source** | Infor CSVs (not OT) | Infor matches Excel ($47K vs $32K, $28K vs $29K) |
| **Activities link** | Through `ad_user` table | `c_contactactivity` doesn't have direct `c_bpartner_id` |
| **Customer matching** | Fuzzy logic needed | OT/Infor names differ ("Alstom" vs "Alstom Transportation Inc.") |

---

## 📂 Key Files

**Documentation:**
- `PROJECT-STATUS.md` - Full project status (read this first!)
- `QUICK-RESUME.md` - This file

**Queries:**
- `account-review-full-query.sql` - OT metrics query (working)

**Test Scripts:**
- `analyze-account-review.js` - Excel template analyzer
- `analyze-booked-invoiced.js` - Infor booked sales parser
- `analyze-invoiced.js` - Infor invoiced sales parser

**Data Sources:**
- Example: `Account Reviews - Aaron Mendoza Example.xlsx`
- Infor CSVs: `Sales Pulse Daily/data/Infor Booked Sales by Line YTD - 6.19.26.csv`
- Infor CSVs: `Sales Pulse Daily/data/Invoiced Sales 2026 by Line - 6.19.26.csv`

---

## ❓ Questions to Ask User

Before continuing, confirm:

1. **Which quarter to build for first?** (Q3 2026 for upcoming reviews? Or Q2 for testing?)
2. **Do you have updated Infor CSV files?** (Booked/Invoiced/Backlog)
3. **Do you have 2026 seller goals file?** (Format: Excel? CSV?)
4. **Which seller to test with?** (Aaron Mendoza again? Or someone else?)
5. **Customer matching approval?** (Should I show matches for review before generating Excel?)

---

## 🚀 Recommended Next Command

**After answering questions above, say:**

"Let's build the Infor CSV parser first, then tackle the fuzzy matching logic."

or

"Let's complete the OT queries first, then move to Excel generation."

---

**Full details in:** `PROJECT-STATUS.md`
