# Intel/Altera Buying Opportunity Analysis

**Date:** 2026-08-13
**Status:** Complete

## Summary

Analyzed 541 Intel/Altera MPNs from sales history file to identify buying opportunities by cross-referencing against:
- Customer excess offers (last 9 months)
- Vendor/broker stock offers (last 9 months)
- RFQ demand (last 9 months)

## Results

| Category | Count |
|----------|-------|
| Customer Excess Offers | 249 |
| Broker Stock Offers | 299 |
| Vendor/Market Offers | 601 |
| RFQ Demand Lines | 808 |
| Outreach Target Customers | 75 |
| Hot Opportunities (offer + demand) | 67 |

## Classification Overrides Applied

- **Celestica** → Customer Excess (OT has them as both customer AND vendor)
- **Very Chip Co.** → Broker Stock
- **Yixin** → Broker Stock
- **Refresh** → Broker Stock

## Deliverables

- **Report:** `/home/analytics_user/workspace/Intel-Altera-Opportunity-Report.xlsx`
- **Script:** `/home/analytics_user/workspace/intel-altera-opportunity-report-v3.js`
- **Emailed to:** jake.harris@astutegroup.com

## Report Tabs

1. Summary
2. Customer Excess - customers with parts to buy
3. Broker Stock - broker inventory (Very Chip, Yixin, Refresh)
4. Vendor Offers - other vendor stock
5. Outreach Targets - customers using these parts (contact for excess)
6. Opportunities - MPNs with both supply AND demand
7. RFQ Detail
8. MPN List (input)

## Input File

`file-drop/Intel and Altera Sales History.xlsx` - single column of 541 unique Intel/Altera MPNs

## Technical Notes

- Initial queries using `UPPER(olm.chuboe_mpn)` returned no results due to PostgreSQL behavior; removed UPPER() and queries worked
- Large IN clauses (541 MPNs) exceeded command-line length limits; solved by batching queries in groups of 50
- Email via `claude@orangetsunami.com` failed (mailbox doesn't exist); used `vortex@orangetsunami.com` instead

## Follow-up

- Consider adding the opportunity report as a reusable workflow if this analysis is needed regularly
- Classification overrides are hardcoded in the script; could be externalized to a config file
