/**
 * Tick VQ 2135330 (Taxan Excess for Masline PO 304068) as IsPurchased='Y'.
 * Validator enforces DatePromised + all pre-approval fields.
 */
require('dotenv').config({ path: require('path').join(process.env.HOME, 'workspace/.env') });

const { tickVQForPurchase } = require('../../../shared/vq-patcher');

(async () => {
  // Stock delivery — 2 business days from today (2026-04-23) → 2026-04-27
  const DATE_PROMISED = '2026-04-27';
  const result = await tickVQForPurchase(2135330, {
    program: null, // Not LAM_KITTING/LAM_EPG — stock RFQ
    extra: {
      DatePromised: DATE_PROMISED,
    },
  });
  console.log('Tick result:', JSON.stringify(result, null, 2));
})().catch(e => {
  console.error('FATAL:', e.message);
  if (e.violations) console.error('Violations:', e.violations);
  process.exit(1);
});
