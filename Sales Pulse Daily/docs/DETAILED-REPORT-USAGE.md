# VP Daily Brief - Detailed Report (On-Demand)

## Overview

The detailed report includes **part numbers (MPNs)** and **quantities** which require slower queries (30-60 seconds). Use this for manual drill-down when you need full part-level details.

## What's Different from Daily Email

| Feature | Daily Email (Automated) | Detailed Report (On-Demand) |
|---------|------------------------|------------------------------|
| **Part Numbers** | ❌ Not included | ✅ Full MPN list per order |
| **Quantities** | ❌ Not included | ✅ Total quantities |
| **Speed** | <1 second | 30-60 seconds |
| **Delivery** | 8am weekdays automatic | Manual run when needed |
| **Recipients** | Josh + Melissa | On-demand (specify email) |

## Usage

### 1. Generate Report (Files Only)
```bash
node "/home/melissa.bojar/workspace/Sales Pulse Daily/scripts/generate-detailed-report.js"
```

**Output:**
- HTML: `Sales Pulse Daily/output/vp-daily-brief-detailed-YYYY-MM-DD.html`
- Shows part numbers for:
  - Top 5 Orders Won
  - Reactivated Customers (6+ month gap)

### 2. Generate and Email
```bash
node "/home/melissa.bojar/workspace/Sales Pulse Daily/scripts/generate-detailed-report.js" --email=josh.pucci@astutegroup.com
```

**Email details:**
- From: salesanalytics@orangetsunami.com
- Subject: "VP Daily Brief - DETAILED (Wednesday, June 17, 2026)"
- Body: Full HTML report with part numbers

### 3. Quick Command (from anywhere)
```bash
cd ~/workspace && node "Sales Pulse Daily/scripts/generate-detailed-report.js"
```

## Example Output

### Top 5 Orders (with parts)
| Seller | Customer | Order # | Revenue | **Part Numbers** |
|--------|----------|---------|---------|------------------|
| Laurel Kee | THALES | SO507509 | $1.22M | **K4AAG165WA-BCWE** |
| Ricardo Morales | Sanmina | SO507508 | $133K | **88E1510-A0-NNB2I000, 88E6390-A0-TLA2I000** |

### Reactivated Customers (with parts)
| Customer | BP ID | Orders | Revenue | Gap | **Part Numbers** | **Qty** |
|----------|-------|--------|---------|-----|------------------|---------|
| Applied Materials | 1000724 | 4 | $6.4K | 181d | **LT8645SHV-2#PBF, RC0805FR-0768R1L** | **1,250** |

## When to Use

**Use Detailed Report when:**
- Need to see exactly which parts are in an order
- Drilling into a specific reactivated customer
- Creating follow-up action items by part
- Investigating unusual order compositions

**Use Daily Email when:**
- Quick morning overview of yesterday's activity
- High-level trends and alerts
- No need for part-level details (order # links to OT for drill-down)

## Performance Notes

**Why it's slower:**
- Joins to `c_orderline` table (100s-1000s of rows per order)
- Aggregates part numbers using `STRING_AGG()`
- Multiple subqueries per order/customer
- Not suitable for automated daily email (risk of timeouts)

**Optimization already applied:**
- Uses `chuboe_mpn` column directly (no complex joins)
- Only shows Top 5 + Reactivated (not all sections)
- Acceptable 30-60s runtime for on-demand use

## Troubleshooting

**If report takes >2 minutes:**
- Database may be under heavy load
- Try again in a few minutes
- Report will still complete, just slower

**If part numbers show "N/A":**
- Order may have no orderlines with MPNs
- Check in Orange Tsunami (OT) using order number
- Some orders (adjustments, credits) may legitimately have no parts

**If email fails:**
- Check WorkMail credentials in `~/workspace/.env`
- Verify recipient email address is correct
- HTML file is still generated even if email fails

## Files

**Scripts:**
- `/home/melissa.bojar/workspace/Sales Pulse Daily/scripts/generate-detailed-report.js`

**Queries:**
- `/home/melissa.bojar/workspace/Sales Pulse Daily/queries/vp-daily-queries-detailed.sql`

**Output:**
- `/home/melissa.bojar/workspace/Sales Pulse Daily/output/vp-daily-brief-detailed-*.html`

## Related

- Standard daily email: `email-vp-daily-brief.js` (automated 8am weekdays)
- Setup docs: `AUTOMATION-SETUP.md`
- Performance analysis: `PERFORMANCE-OPTIMIZATION.md`
