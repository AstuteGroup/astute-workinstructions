require('dotenv').config({ path: require('path').join(process.env.HOME, 'workspace/.env') });
const { validateCQForSold } = require('../../../shared/cq-sold-validator');

(async () => {
  const report = await validateCQForSold(1264300);
  console.log('ok:', report.ok);
  console.log('violations:', report.violations);
  console.log('purchasedVq id:', report.purchasedVq?.chuboe_vq_line_id);
  console.log('mirror fields on VQ:');
  for (const k of ['datepromised','chuboe_lead_time','chuboe_date_code','chuboe_packaging_id','chuboe_rohs','c_country_id']) {
    console.log(`  ${k}: VQ=${report.purchasedVq?.[k]} CQ=${report.cq?.[k]}`);
  }
  process.exit(0);
})();
