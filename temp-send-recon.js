#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { createNotifier } = require('./shared/notifier');

async function main() {
  const notifier = createNotifier({
    fromEmail: 'lamkitting@orangetsunami.com',
    fromName: 'LAM Reconciliation'
  });

  const body = `MOUSER INVOICE RECONCILIATION - POV0075257 (RFQ 1139512)
==========================================================

12 Invoice PDFs found: 89497435, 89519101, 89568193, 89765460, 89821186, 90172966, 90302299, 90441161, 90893594, 90945447, 90969889, 91087894

PART VQs CREATED TODAY (24 lines):
----------------------------------
VQ ID    | MPN                          | Qty    | Unit Cost | Line Total
---------|------------------------------|--------|-----------|------------
2228014  | 42819-5223                   |     25 | $  11.94  | $    298.50
2228015  | SSW-104-06-G-S               |    150 | $   1.21  | $    181.50
2228016  | SL-120-G-10                  |     35 | $   8.75  | $    306.25
2228017  | SCT3022ALGC11                |     50 | $  40.29  | $  2,014.50
2228018  | RA73F1J200RBTDF              |    165 | $   1.46  | $    240.90
2228019  | IP5-04-05.0-L-S-1-L-TR       |     50 | $   9.86  | $    493.00
2228020  | RG2012P-2742-B-T5            |    561 | $   0.073 | $     40.95
2228021  | 0505012.MXP                  |    160 | $   3.08  | $    492.80
2228022  | IXFY26N30X3                  |     70 | $   2.49  | $    174.30
2228023  | SRU2013-2R2Y                 |    350 | $   0.518 | $    181.30
2228024  | TNPW120690K9BEEA             |    650 | $   0.272 | $    176.80
2228025  | C0805C102JBRACTU             |   1000 | $   0.137 | $    137.00
2228026  | RG2012P-1071-B-T5            |   3000 | $   0.069 | $    207.00
2228027  | RG2012P-2101-B-T5            |   3000 | $   0.069 | $    207.00
2228028  | C1812C224J1RACTU             |    300 | $   0.649 | $    194.70
2228029  | RG2012P-1961-B-T5            |    555 | $   0.098 | $     54.39
2228030  | SHV24-1A85-78D3K             |    431 | $   9.54  | $  4,111.74
2228031  | SMCJ1.5KE30A-TP              |    630 | $   0.293 | $    184.59
2228032  | 10139781-122402LF            |    105 | $   5.29  | $    555.45
2228033  | ECS-TXO-3225MV-160-TR        |    150 | $   1.59  | $    238.50
2228034  | TNPW08051K91BEEN             |    625 | $   0.388 | $    242.50
2228035  | TNPW0402249RBYEP             |    650 | $   0.333 | $    216.45
2228036  | H11N1SR2M                    |    200 | $   1.08  | $    216.00
2228037  | 0216.200MXP                  |    140 | $   1.19  | $    166.60
---------|------------------------------|--------|-----------|------------
                                        Parts Subtotal:      $ 11,332.72


TARIFF VQs CREATED TODAY (5 lines):
-----------------------------------
VQ ID    | Invoice      | Tariff Amount
---------|--------------|---------------
2228067  | 89497435     | $     99.65
2228068  | 89519101     | $     94.41
2228069  | 89568193     | $    778.90
2228070  | 89765460     | $      7.28
2228071  | 90441161     | $      0.31
---------|--------------|---------------
                 Tariff Subtotal: $    980.55


INVOICE STATUS:
---------------
✓ 89497435 - tariff $99.65
✓ 89519101 - tariff $94.41
✓ 89568193 - tariff $778.90
✓ 89765460 - tariff $7.28
✓ 90441161 - tariff $0.31
? 89821186 - no tariff line (verify if $0 tariff or missing)
? 90172966 - no tariff line
? 90302299 - no tariff line
? 90893594 - no tariff line
? 90945447 - no tariff line
? 90969889 - no tariff line
? 91087894 - no tariff line


GRAND TOTAL:
------------
Parts:   $ 11,332.72
Tariffs: $    980.55
----------------------
TOTAL:   $ 12,313.27

VQs: 29 total (24 parts + 5 tariffs)


ACTION NEEDED:
- Verify the 7 invoices without tariff lines - do they have $0 tariff or did we miss them?
`;

  await notifier.sendEmail(
    'jake.harris@astutegroup.com',
    'Mouser Invoice Reconciliation - POV0075257',
    body
  );

  console.log('Reconciliation email sent!');
}

main().catch(console.error);
