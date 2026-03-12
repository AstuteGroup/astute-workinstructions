const fs = require('fs');
const dir = '/home/analytics_user/workspace/astute-workinstructions/rfq_sourcing/vq_loading/output';

['2026-03-10-erp-ready.csv', '2026-03-11-erp-ready.csv', '2026-03-12-erp-ready.csv'].forEach(f => {
  const p = `${dir}/${f}`;
  if (!fs.existsSync(p)) {
    console.log(`${f}: NOT FOUND`);
    return;
  }
  const lines = fs.readFileSync(p, 'utf-8').trim().split('\n');
  let bad = 0;
  lines.forEach((l, i) => {
    const c = l.split(',').length;
    if (c !== 17) {
      bad++;
      console.log(`${f} line ${i + 1}: ${c} cols`);
    }
  });
  console.log(`${f}: ${bad === 0 ? 'ALL 17 COLUMNS ✓' : bad + ' rows with wrong column count'}`);
});
