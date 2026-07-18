#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { createNotifier } = require('./shared/notifier');

async function main() {
  const notifier = createNotifier({
  fromEmail: 'lamkitting@orangetsunami.com',
  fromName: 'LAM Reorder'
});

  const file = '/home/analytics_user/workspace/astute-workinstructions/Trading Analysis/LAM 3PL/output/LAM_Reorder_Alerts_2026-07-14_sourced.xlsx';

  await notifier.sendWithAttachment(
    'jake.harris@astutegroup.com',
    'LAM Reorder Alerts 2026-07-14 (Fixed)',
    `LAM Reorder Alerts with fixes:
- Stale 2024 POVs filtered out (was 972 lines, now 80)
- Recent POV column now shows PO issue date (not promise date)
- Last Promise Date column shows vendor ETA

80 items below threshold.`,
    [{ filename: 'LAM_Reorder_Alerts_2026-07-14_sourced.xlsx', path: file }]
  );

  console.log('Email sent!');
}

main().catch(console.error);
