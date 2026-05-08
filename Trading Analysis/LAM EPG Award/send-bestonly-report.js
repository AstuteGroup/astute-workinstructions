const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const fs = require('fs');
const { createNotifier } = require('../../shared/notifier');

const FILE = path.join(__dirname, 'EPG_Remaining_BestOnly_20260409.xlsx');

const body = `Hi Jake,

REFRESHED sourcing report — same 58 SIPOC-remaining lines, restructured per your feedback:

KEY CHANGES VS PRIOR REPORT
  1. Each line appears on EXACTLY ONE tab (its best franchise vendor). No more cross-tab duplicates.
  2. MOQ-aware: when a vendor has 0 stock and only quotes at lead time, the report uses the vendor's MOQ as the effective buy qty (max(need, moq)). MOQ-violation lines are excluded from "best vendor" consideration unless that vendor is the only option for the line.
  3. Already-loaded CPCs are flagged "YES (skip)" so you don't re-pick anything we already pushed today (Fuses + Tracy + Amatom + DigiKey).

NEW COLUMN LAYOUT (per-vendor tabs)
  Line, CPC, MPN, MFR, Need Qty, Resale, Unit Cost, Eff Buy Qty, Total Cost,
  Stock?, Avail Qty, MOQ, Full Qty?, Lead Time,
  Margin %, Line GP,
  Next Best Alt Vendor, Next Best Alt Cost, Δ vs Best,
  Quote Count, Already Loaded?

  - Eff Buy Qty = what you actually have to commit to. For stock rows: min(need, stock). For LT rows: max(need, moq).
  - Total Cost = unit × Eff Buy Qty (so MOQ overhang is visible).
  - Margin / GP computed against revenue = need × resale (LAM only pays for need, not the MOQ overhang).
  - Δ vs Best shows how much more the runner-up vendor would cost (consolidation trade-off).

SUMMARY
  Vendor          Best-of  Remaining   Total Cost   Total Resale   GP             Avg Margin
  --------------  -------  ---------   -----------  ------------   ------------   ----------
  DigiKey         18       15          $14,190.32   $42,716.62     +$28,526.30    66.8%
  Newark/Farnell  8        8           $8,017.35    $9,109.76      +$1,092.41     12.0%
  Future          8        8           $1,217.84    $2,827.82      +$1,609.98     56.9%
  Mouser          4        4           $1,530.29    $1,329.04      -$201.26       -15.1%
  TTI             3        3           $4,276.80    $942.67        -$3,334.13     -353.7%   <-- MOQ overhang
  Arrow           3        3           $656.50      $932.98        +$276.48       29.6%
  Master          1        0           $0           $0             $0             0.0%
  ----------------------------------------------------------------------------------------------
  TOTAL           45       41          $29,889.10   $57,858.88     +$27,969.78    48.3%

  No-Source Lines: 10

WORTH INVESTIGATING
  TTI -353% margin is almost certainly an MOQ violation on one or more lines. The picking rule excludes MOQ-violators unless that vendor is the only option, so the lines where TTI is "best" are lines no one else can quote — and the MOQ overhang dominates the GP. Those are real broker-channel candidates.

  Look at the TTI tab and the MOQ + Eff Buy Qty columns to see which MPNs are in trouble. Compare the No Source tab too — those 10 lines have no franchise hits at all and should also go to broker.

ALREADY LOADED MARKERS
  4 of the 45 lines are flagged "YES skip" — those CPCs already have IsPurchased=Y from today's batches. They show on their winning vendor's tab for completeness but you should not re-pick them.

— Claude via Jake's analytics terminal
`;

const notifier = createNotifier({
  fromEmail: 'vortex@orangetsunami.com',
  fromName: 'Analytics Terminal',
  smtpPass: process.env.WORKMAIL_PASS,
});
notifier.sendWithAttachment(
  'jake.harris@Astutegroup.com',
  'LAM EPG RFQ 1132040 — Remaining-Lines Sourcing Report — BEST VENDOR PER LINE (Apr 9)',
  body,
  [{ filename: 'EPG_Remaining_BestOnly_20260409.xlsx', content: fs.readFileSync(FILE) }],
).then(ok => console.log(ok ? '✓ sent' : '✗ failed')).catch(e => { console.error(e); process.exit(1); });
