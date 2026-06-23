# VP Daily Brief - Part Details Performance Optimization

## Current Problem

Part details (MPNs, manufacturers, quantities) were removed because they caused 30+ second query timeouts.

**Bottleneck:** Joining c_order → c_orderline → chuboe_rfq_line_mpn → m_product and using STRING_AGG() to concatenate all parts.

## Option 1: LATERAL JOIN with LIMIT (Top 3 Parts Only)

**Concept:** Instead of aggregating ALL parts, show only the top 3 highest-value parts per order.

**Pros:**
- Much faster (processes fewer rows)
- Still provides useful context (top parts are most important)
- No STRING_AGG bottleneck

**Cons:**
- Doesn't show complete part list
- May miss some parts users want to see

**Example SQL:**
```sql
SELECT
  o.documentno as order_number,
  o.grandtotal as revenue,
  parts.top_parts,
  parts.part_count
FROM adempiere.c_order o
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) as part_count,
    STRING_AGG(p.value, ', ' ORDER BY ol.linenetamt DESC) as top_parts
  FROM (
    SELECT ol.linenetamt, p.value
    FROM adempiere.c_orderline ol
    LEFT JOIN adempiere.chuboe_rfq_line_mpn rlm ON ol.chuboe_rfq_line_mpn_id = rlm.chuboe_rfq_line_mpn_id
    LEFT JOIN adempiere.m_product p ON rlm.m_product_id = p.m_product_id
    WHERE ol.c_order_id = o.c_order_id
      AND ol.isactive = 'Y'
    ORDER BY ol.linenetamt DESC
    LIMIT 3
  ) top_3
) parts ON true
WHERE o.created::date = CURRENT_DATE - INTERVAL '1 day'
  AND o.isactive = 'Y'
ORDER BY o.grandtotal DESC;
```

**Performance Impact:** ~5-10x faster than aggregating all parts

---

## Option 2: Materialized View (Pre-computed Daily)

**Concept:** Create a materialized view that pre-computes order→parts mapping, refresh it nightly before the report runs.

**Pros:**
- Report queries become instant (just read from view)
- Can include all parts, not just top 3
- No query timeout risk

**Cons:**
- Requires database permissions to create materialized views
- Adds complexity (refresh schedule)
- View refresh itself may be slow (but can run during low-traffic hours)

**Example Implementation:**
```sql
-- Create materialized view (run once)
CREATE MATERIALIZED VIEW adempiere.mv_order_parts_summary AS
SELECT
  o.c_order_id,
  o.documentno,
  STRING_AGG(DISTINCT p.value, ', ' ORDER BY p.value) as mpns,
  STRING_AGG(DISTINCT p.name, ', ' ORDER BY p.name) as mfr_names,
  SUM(ol.qtyordered) as total_qty,
  COUNT(DISTINCT ol.c_orderline_id) as line_count
FROM adempiere.c_order o
LEFT JOIN adempiere.c_orderline ol ON o.c_order_id = ol.c_order_id AND ol.isactive = 'Y'
LEFT JOIN adempiere.chuboe_rfq_line_mpn rlm ON ol.chuboe_rfq_line_mpn_id = rlm.chuboe_rfq_line_mpn_id
LEFT JOIN adempiere.m_product p ON rlm.m_product_id = p.m_product_id
WHERE o.isactive = 'Y'
  AND o.created::date >= CURRENT_DATE - INTERVAL '90 days'  -- Keep recent orders only
GROUP BY o.c_order_id, o.documentno;

-- Add index for fast lookups
CREATE INDEX idx_mv_order_parts_order_id ON adempiere.mv_order_parts_summary(c_order_id);

-- Refresh nightly (via cron at 7:00am, before 8am report)
REFRESH MATERIALIZED VIEW CONCURRENTLY adempiere.mv_order_parts_summary;
```

**Then in report query:**
```sql
SELECT
  u.name as seller_name,
  bp.name as customer_name,
  o.documentno as order_number,
  o.grandtotal as revenue,
  parts.mpns,
  parts.mfr_names,
  parts.total_qty
FROM adempiere.c_order o
JOIN adempiere.c_bpartner bp ON o.c_bpartner_id = bp.c_bpartner_id
JOIN adempiere.ad_user u ON o.salesrep_id = u.ad_user_id
LEFT JOIN adempiere.mv_order_parts_summary parts ON o.c_order_id = parts.c_order_id
WHERE o.created::date = CURRENT_DATE - INTERVAL '1 day'
  AND o.isactive = 'Y'
ORDER BY o.grandtotal DESC;
```

**Performance Impact:** Report queries become <1 second

---

## Option 3: Array Aggregation (More Efficient than STRING_AGG)

**Concept:** Use ARRAY_AGG which is faster than STRING_AGG, then convert to text in application code.

**Pros:**
- Faster than STRING_AGG (less string manipulation in DB)
- Still gets all parts
- No schema changes needed

**Cons:**
- Still slower than LATERAL or materialized view
- Returns arrays instead of comma-separated strings

**Example SQL:**
```sql
SELECT
  o.documentno,
  ARRAY_AGG(DISTINCT p.value ORDER BY p.value) as mpn_array,
  SUM(ol.qtyordered) as total_qty
FROM adempiere.c_order o
LEFT JOIN adempiere.c_orderline ol ON o.c_order_id = ol.c_order_id
LEFT JOIN adempiere.chuboe_rfq_line_mpn rlm ON ol.chuboe_rfq_line_mpn_id = rlm.chuboe_rfq_line_mpn_id
LEFT JOIN adempiere.m_product p ON rlm.m_product_id = p.m_product_id
WHERE o.created::date = CURRENT_DATE - INTERVAL '1 day'
GROUP BY o.c_order_id, o.documentno;
```

**JavaScript processing:**
```javascript
const mpns = row.mpn_array ? row.mpn_array.join(', ') : '';
```

**Performance Impact:** 2-3x faster than STRING_AGG, but still may timeout

---

## Option 4: Check/Add Database Indexes

**Concept:** Ensure all join columns have indexes to speed up joins.

**Required indexes:**
```sql
-- Check if these indexes exist
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'adempiere'
  AND tablename IN ('c_orderline', 'chuboe_rfq_line_mpn', 'm_product')
ORDER BY tablename, indexname;
```

**Likely missing indexes:**
```sql
-- If missing, add these:
CREATE INDEX IF NOT EXISTS idx_orderline_order_id ON adempiere.c_orderline(c_order_id) WHERE isactive = 'Y';
CREATE INDEX IF NOT EXISTS idx_orderline_rfq_line_mpn ON adempiere.c_orderline(chuboe_rfq_line_mpn_id) WHERE isactive = 'Y';
CREATE INDEX IF NOT EXISTS idx_rfq_line_mpn_product ON adempiere.chuboe_rfq_line_mpn(m_product_id) WHERE isactive = 'Y';
```

**Performance Impact:** 2-5x faster queries if indexes were missing

---

## Option 5: Hybrid Approach (Top 3 + Count)

**Concept:** Show top 3 parts + total count (e.g., "AD8138 (+4 more)")

**Pros:**
- Fast (LIMIT 3)
- Gives complete picture (user knows there are more parts)
- Best balance of performance vs information

**Cons:**
- Doesn't show all parts

**Example SQL:**
```sql
SELECT
  o.documentno,
  o.grandtotal,
  (
    SELECT STRING_AGG(p.value, ', ' ORDER BY ol.linenetamt DESC)
    FROM (
      SELECT p.value, ol.linenetamt
      FROM adempiere.c_orderline ol
      LEFT JOIN adempiere.chuboe_rfq_line_mpn rlm ON ol.chuboe_rfq_line_mpn_id = rlm.chuboe_rfq_line_mpn_id
      LEFT JOIN adempiere.m_product p ON rlm.m_product_id = p.m_product_id
      WHERE ol.c_order_id = o.c_order_id AND ol.isactive = 'Y'
      ORDER BY ol.linenetamt DESC
      LIMIT 3
    ) top_parts
  ) as top_mpns,
  (
    SELECT COUNT(*)
    FROM adempiere.c_orderline ol
    WHERE ol.c_order_id = o.c_order_id AND ol.isactive = 'Y'
  ) as total_line_count
FROM adempiere.c_order o
WHERE o.created::date = CURRENT_DATE - INTERVAL '1 day'
  AND o.isactive = 'Y'
ORDER BY o.grandtotal DESC;
```

**Display logic:**
```javascript
const partDisplay = row.total_line_count > 3
  ? `${row.top_mpns} (+${row.total_line_count - 3} more)`
  : row.top_mpns;
```

---

## Recommendation Priority

**Best Options (in order):**

1. **Option 2: Materialized View** (if you have DB permissions)
   - Fastest, most complete data
   - One-time setup, then instant queries forever
   - Refresh runs at 7am (before 8am email)

2. **Option 5: Hybrid (Top 3 + Count)** (if no DB permissions)
   - Good balance of speed and information
   - No schema changes needed
   - Can implement today

3. **Option 4: Add Indexes** (do this regardless)
   - Should be done anyway
   - Helps all queries, not just this report
   - Check what's missing first

**Next Steps:**

1. Check if you have permissions to create materialized views
2. Check existing indexes on join columns
3. Test Option 5 (Hybrid) on Top 5 Orders query to measure performance
4. If acceptable, apply to all sections

Would you like me to:
1. Check current indexes on the database?
2. Test the Hybrid approach on one query to measure actual performance?
3. Create a script to set up the materialized view approach?
