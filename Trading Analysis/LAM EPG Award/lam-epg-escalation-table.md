# LAM EPG RFQ 1132040 — Escalation Candidates

Parts that cannot be sourced per LAM's current agreement. Need LAM approval for MOQ, price, lead-time, or MPN variant deviations.

**Last updated:** 2026-06-24

## Escalation Table

| LAM CPC | MFR | MPN | LAM Qty | Contract Base | Contract LT | Supplier Price | Supplier MOQ / Stock | Supplier LT | Issue | Delta | Notes (internal) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 779-002694-001 | Henkel | QII-0.006-00-61 | 500 | $0.5500 | 3 wks | $0.082 | MOQ 9,217 | 29 wks | MOQ + LT | Cost far below base — MOQ overage creates huge exposure | Non-stock/factory-order; consider requoting LAM at actual cost. |
| 630-340553-001 | Renesas | 551SCMGI | 150 | $1.6822 | 17 wks | NAC $2.29 | Stock 400 | Stock | Price + excess qty | +$0.61/unit; buying 400 (150 need + 250 excess) | NAC on preferred MPN; PO809706 shipped — tracking 1Z019F050396474319. |
| 648-004248-471 | ATC (Kyocera AVX) | 100E471GW2500X | 10 | $47.51 | 28 wks | Richardson alt pending (~$57+) | TBD | TBD | Price | ~$10+/unit uplift on alt | Preferred blocked by MFR acquisition gap; Richardson alt quote pending. |
| 644-059699-005 | Comus Group | 500-231 | 750 | $0.3500 | 12 wks | Relays Unltd pending | TBD | TBD | No franchise source | TBD | No online purchase path. MFR acquisition gap (Computer Components → Comus Group). |
| 630-087790-001 | Beckhoff | ET1100 | 1,750 | $0.1598 | 0 wks | Tracy APAC pending | TBD | TBD | No online source | TBD | Beckhoff direct only; sent to Tracy. |
| 630-120971-001 | Micron | MT47H128M16RT-25E:C **TR** | 20 | $14.7792 | 7 wks | Astute own stock **non-TR** @ $5.00 orig | Stock 2,000 | In-house | MPN variant deviation | Way under base, but reel vs non-reel substitution | 🚨 LAM approved MPN is TR (tape-reel); Astute has 2,000 of non-TR in Austin. LAM approval needed. |
| 630-A92150-002 | Micron | MTFC64GBCAQTC-WT | 30 | $65.38 | 33 wks | Newark $116.46 (at risk) | Stock 200 (Newark, at risk) | Stock | Price + Supply | +$51.08/unit at Newark (78% uplift) | ⚠ **LIKELY CANCELLATION 2026-04-21** — PO809809 / POV0075745 still IP in OT but Newark signaling cancellation. No Astute internal stock. Franchise alternatives: none at original pull. Broker offers are -IT/-AAT/-AIT substrate variants ONLY; LAM has NOT approved an alt variant. If Newark confirms cancel: (a) re-sweep all 10 franchise APIs fresh, (b) LAM escalation for alt-variant approval (-IT closest spec), or (c) accept delay. LAM cost deviation already approved for -WT (req 1156822) — re-approval needed if variant changes. |
| 630-257348-001 | Analog Devices | LTC2312HTS8-14#TRMPBF | 100 | $18.49 | 18 wks | DigiKey $19.68 / 261 stock (fresh) | Stock 261 | Stock | Price | +$1.19/unit over base (~6.5% uplift) | **Check with Amalfi** — DigiKey has 261 in stock at $19.68 (over base). Our API parser missed it; confirmed via direct DigiKey fetch. Broker alts DC 16+ (rejected). |
| 630-260287-001 | Analog Devices | LTC2313CTS8-12#TRMPBF | 30 | $10.67 | 22 wks | DigiKey stock confirmed per Jake (price TBD) | Stock (Jake saw on DigiKey site) | Stock | Franchise — price pending | TBD | **Check with Amalfi** — DigiKey has stock per Jake (parser returning not-found, confirmed broken for this LT family). Amalfi to pull fresh price. |
| 723-008848-003 | Amatom | 9724-SS-7 | 50 | $34.80 | 10 wks | Amatom direct (pending) | TBD | TBD | **Incomplete MPN** | TBD | **Waiting on LAM to confirm full MPN** — 9724-SS-7 is incomplete per Amatom nomenclature; can't source without full part number. |
| 669-C00309-007 | Molex | 203263-0066 | 75 | $3.80 | 5 wks | Mouser $4.48 | Stock 75 | 10 wks | Price | +$0.68/unit (18% over base) | Mouser only franchise source; $4.48 vs $3.80 base. Needs LAM approval on cost deviation. |
| 630-268428-001 | FTDI | FT234XD-R | 125 | $2.25 | 30 wks | Newark | Stock | Stock | ~~LT~~ RESOLVED | PO810491 shipped | ✅ Shipped — tracking 526134749325. |
| 630-248896-001 | ISSI | IS25LP128-JBLE | 130 | $5.14 | — | Newark | Stock | Stock | RESOLVED | PO810491 shipped | ✅ Shipped — tracking 1Z97X570AT04717123. |
| 631-099701-003 | Broadcom | HFBR-1531ETZ | 15 | $17.72 | — | Mouser | Stock | Stock | RESOLVED | PO809925 shipped | ✅ Shipped — tracking 528979457439. |

| 668-096777-009 | Kycon | K85X-ED-9P-CBR | 300 | $5.62 | 5 wks | Hughes-Peters no bid | MOQ 10,024 | TBD | MOQ + contractual price | MFR no bid — LAM's contractual price prevents quoting; MOQ 10,024 per original Dec quote to Elena | Alt DLS1XP4AA35X (Conec) appears EOL — 0 stock across all distributors. Newer variant DLS1XP4AA35X**E** exists (35 stock, $1.49-$1.94) but different MPN + only 35 vs 300 needed. |

## Pending Data

- [ ] Richardson quote for 100E471GW2500X alt
- [ ] Relays Unlimited quote for 500-231
- [ ] Tracy APAC response for ET1100
- [ ] Requote decision on QII-0.006-00-61
- [ ] LAM approval on MT47H128M16RT non-TR substitution
- [x] LAM approval on MTFC64GBCAQTC-WT cost deviation ($116.46 Newark vs $65.38 base) — approved 2026-04-17; PO809809 placed 2026-04-20
- [ ] ⚠ **MTFC64GBCAQTC-WT — Newark likely cancelling (2026-04-21)**: on confirm, run fresh franchise sweep + escalate to LAM for either alt-variant approval (-IT) or delay acceptance

## Workflow Context

- Source of truth: `Lam_EPG_SIPOC.xlsx` (Base Price, LAM Qty derived from Total Cost ÷ Base, Lead time)
- AVL: `Trading Analysis/LAM New Parts Pricing/Copy of Lam-Astute_NewParts - 02122026.xlsx` (AVL tab)
- Columns: **Contract** = LAM's agreed terms; **Supplier** = actual quote received

## To Do Tomorrow

- Finalize deltas once Richardson / Relays Unltd / Tracy counter-quotes are in
- Confirm with Jake whether QII-0.006-00-61 should be quoted back at real cost or held at base
- Draft formal LAM escalation email from this table once complete
