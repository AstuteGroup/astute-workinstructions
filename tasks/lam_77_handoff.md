# LAM 77-Item Approval List - Session Handoff

**Date:** 2026-06-24 (Updated)
**Status:** Analysis Complete

## What We're Working On

LAM sent an approval email (June 12, 2026) to place POs for **77 items** totaling **$132,257.31**.

**Email location:** `rfqloading@orangetsunami.com` inbox, NeedsReview folder, UID 231
**Full email text saved to:** `/home/analytics_user/workspace/lam-77-approval-email.txt`
**Parsed items:** `/home/analytics_user/workspace/lam_77_mpns.txt`
**Status report script:** `/home/analytics_user/workspace/lam_77_status_check.py`

## Current Status Summary

| Category | Count | Value |
|----------|-------|-------|
| **POs Placed (Shipped)** | 4 | $2,124.26 |
| **VQs Loaded (Ready for PO)** | 14 | $36,992.45 |
| **Need VQs Loaded** | 50 | $87,990.36 |
| **Custom/BTP** | 9 | $5,150.24 |
| **Total** | **77** | **$132,257.31** |

## CRITICAL: VQ Buyer Field (RESOLVED)

**The VQ buyer is `chuboe_buyer_id` on `chuboe_vq_line`.**

- NOT `createdby` (that's the data entry person, often Gopalakrishnan)
- NOT `salesrep_id` on the RFQ
- Buyer IDs: Josh Syre = 1005243, Stephanie Hill = 1009138

Query to verify:
```sql
SELECT vl.chuboe_mpn, b.name as buyer, vl.created
FROM chuboe_vq_line vl
JOIN ad_user b ON b.ad_user_id = vl.chuboe_buyer_id
WHERE vl.chuboe_buyer_id IN (1005243, 1009138)
AND vl.created >= '2026-01-01';
```

## Items with POs Already Placed (4 items)

| CPC | MPN | PO | Vendor | Tracking |
|-----|-----|-----|--------|----------|
| 630-268428-001 | FT234XD-R | PO810491 | Newark | 526134749325 |
| 630-248896-001 | IS25LP128-JBLE | PO810491 | Newark | 1Z97X570AT04717123 |
| 631-099701-003 | HFBR-1531ETZ | PO809925 | Mouser | 528979457439 |
| 630-340553-001 | 551SCMGI | PO809706 | NAC Semi | 1Z019F050396474319 |

## Items with VQs Loaded (14 items - $36,992.45)

All Passive Plus capacitors with VQs from Stephanie Hill (mostly June 23, 2026):

| CPC | MPN | Qty | Ext Cost | VQs | Buyer |
|-----|-----|-----|----------|-----|-------|
| 648-249226-001 | 7676C102JW502X | 20 | $1,802.40 | 2 | Stephanie Hill |
| 668-B66386-001 | 3007W2SCR51E40X | 40 | $510.80 | 3 | Stephanie Hill |
| 648-218816-003 | 1111C221FP501X | 50 | $353.00 | 2 | Stephanie Hill |
| 668-107631-001 | 3005W5PXX55N40X | 100 | $1,858.00 | 2 | Stephanie Hill |
| 648-339430-001 | 1111C101EP501X | 50 | $738.50 | 1 | Josh Syre |
| 648-B67704-241 | 2225C241FW252X | 100 | $4,787.50 | 3 | Stephanie Hill |
| 648-218817-001 | 3838C2R0AP722X | 100 | $5,198.75 | 3 | Stephanie Hill |
| 648-B62204-001 | 7676C102GP502X | 20 | $4,838.00 | 3 | Stephanie Hill |
| 648-B67704-121 | 2225C121FW252X | 100 | $3,988.00 | 3 | Stephanie Hill |
| 648-B67704-620 | 2225C620FW252X | 100 | $3,543.00 | 3 | Stephanie Hill |
| 648-B67732-820 | 3838C820JW362X | 100 | $3,274.00 | 3 | Stephanie Hill |
| 648-B64083-047 | 3838C4R7BW362X | 100 | $2,875.00 | 3 | Stephanie Hill |
| 648-B67704-300 | 2225C300FW252X | 100 | $2,540.00 | 3 | Stephanie Hill |
| 648-345343-016 | 3838C2R0CP722X | 30 | $685.50 | 3 | Stephanie Hill |

## Items Needing VQs (50 items - $87,990.36)

### High Value (>$1,000)

| CPC | MPN | Qty | Ext Cost |
|-----|-----|-----|----------|
| 630-337692-004 | XCZU5CG-1SFVC784E | 15 | $22,988.93 |
| 622-A78896-001 | T1794-675 | 250 | $7,465.00 |
| 630-337692-003 | XCZU4CG-1SFVC784E | 5 | $6,770.00 |
| 630-262333-001 | LTC2986CLX#PBF | 200 | $5,939.24 |
| 630-A92150-002 | MTFC64GBCAQTC-WT | 30 | $4,114.50 |
| 616-052546-008 | MP9100-80.0-1% | 250 | $3,567.50 |
| 630-257348-001 | LTC2312HTS8-14#TRMPBF | 100 | $3,446.00 |
| 630-099507-002 | MAX306EUI+ | 70 | $2,438.10 |
| 668-314221-001 | C10-738244-100 | 100 | $2,095.00 |
| 670-037698-044 | FNQ-R-30 | 30 | $1,800.00 |
| 630-323468-001 | MAX5903NNETT+T | 200 | $1,782.00 |
| 668-900417-001 | 10654-01 | 25 | $1,724.25 |
| 660-121917-001 | 2AA12-N4-I10-Y83-M | 5 | $1,715.00 |
| 668-032731-001 | 10483-56 | 25 | $1,448.75 |
| 644-098425-001 | AZ881-2A-24DEA | 100 | $1,055.34 |

### Medium Value ($500-$1,000)

| CPC | MPN | Qty | Ext Cost |
|-----|-----|-----|----------|
| 630-223433-001 | MAX7325ATG+ | 150 | $996.00 |
| 619-095611-104 | MS315-100K-1.0% | 35 | $921.90 |
| 723-308078-009 | 3045A-B-632-B-16 | 425 | $888.25 |
| 630-052043-001 | LT1499CS#PBF | 50 | $778.83 |
| 630-260287-001 | LTC2313CTS8-12#TRMPBF | 30 | $774.90 |
| 630-165765-018 | TPS78618DCQR | 178 | $774.30 |
| 723-308078-046 | 3050T-B-632-B-16 | 420 | $768.60 |
| 628-102014-001 | IRLB4030PBF | 140 | $763.00 |
| 630-112899-001 | INA111AU | 40 | $751.61 |
| 648-097891-102 | C1206C102K5RAC | 2030 | $625.24 |
| 669-C00309-007 | 203263-0066 | 75 | $586.50 |
| 648-005168-022 | EEEFC1V220P | 1000 | $553.80 |
| 615-901294-101 | CRCW0805100RJNEA | 5000 | $550.00 |
| 648-047973-105 | 08053G105ZAT2A | 3000 | $510.00 |
| 615-901294-752 | RC0805JR-077K5L | 5000 | $500.00 |

### Lower Value (<$500)

Remaining 20 items with values from $250-$480

## Custom / BUILD TO PRINT Items (9 items - $5,150.24)

| CPC | Type | Qty | Ext Cost |
|-----|------|-----|----------|
| 714-084061-001 | BUILD TO PRINT | 25 | $1,090.50 |
| 714-084061-002 | BUILD TO PRINT | 25 | $1,090.50 |
| 714-084061-011 | BUILD TO PRINT | 10 | $619.30 |
| 714-084061-012 | BUILD TO PRINT | 4 | $475.36 |
| 714-084061-013 | BUILD TO PRINT | 4 | $514.08 |
| 714-084061-010 | BUILD TO PRINT | 15 | $571.50 |
| 720-900692-006 | BUILD TO PRINT | 600 | $264.00 |
| 681-006802-210 | ORDER BY DESCRIPTION | 2500 | $275.00 |
| 723-062412-007 | ORDER TO SPECIFICATION | 1000 | $250.00 |

## Next Steps

1. **Load VQs for 50 items** ($87,990.36 total value)
   - Need to source quotes and load into OT with Josh/Stephanie as buyer

2. **14 items ready for PO** ($36,992.45)
   - VQs already loaded, can proceed to PO placement

3. **9 custom items** need separate handling
   - BUILD TO PRINT items require special sourcing

4. **4 items complete** - already shipped

## Key RFQs Referenced

| RFQ | Notes |
|-----|-------|
| 1132040 | LAM EPG Award (older, Aug 2025) |
| 1137922 | Only 1 RFQ line, 5 VQ lines |
| 1141455 | Has VQs for some of the 77 items |
| 1147337 | Recent VQs (June 2026) |

## Files Created

- `/home/analytics_user/workspace/lam-77-approval-email.txt` - Full email text
- `/home/analytics_user/workspace/lam_77_mpns.txt` - Parsed CPC/MPN list
- `/home/analytics_user/workspace/lam_77_status_check.py` - Status report generator
- `Trading Analysis/LAM EPG Award/lam-epg-escalation-table.md` - Escalation tracking
