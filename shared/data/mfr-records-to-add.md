# MFR Records to Add to OT (chuboe_mfr)

Manufacturers encountered during writes that have no record in `adempiere.chuboe_mfr`. The MPN text is preserved on the affected lines, but the FK link (`chuboe_mfr_id`) is null. A trader/admin should create these in OT, then re-run any affected resolution.

When a record is added, remove it from this list (or strike it through with the date).

| MFR Text | First Seen | Source RFQ / Workflow | Affected MPNs | Notes |
|---|---|---|---|---|
| Orbel Corporation | 2026-04-06 | RFQ 1132040 (LAM EPG Award for Purchasing) | L-1300SA1750-0340XF, L-1300CC1750-0340XC | Etched/photochemical EMI shielding gaskets. No fuzzy match candidates found. |
