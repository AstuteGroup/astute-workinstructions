require('dotenv').config({ path: require('path').join(process.env.HOME, 'workspace/.env') });
const { markCQSold } = require('../../../shared/cq-patcher');

(async () => {
  const result = await markCQSold(1264300, {
    poReference: '304068',
  });
  console.log(JSON.stringify(result, null, 2));
})().catch(e => {
  console.error('FATAL:', e.message);
  if (e.violations) console.error('Violations:', e.violations);
  process.exit(1);
});
