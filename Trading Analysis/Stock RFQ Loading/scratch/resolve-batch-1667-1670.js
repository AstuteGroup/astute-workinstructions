require('dotenv').config({ path: require('path').join(process.env.HOME, 'workspace/.env') });
const { resolvePartner } = require('../../../shared/partner-lookup');
const { lookupMfr } = require('../../../shared/mfr-lookup');

(async () => {
  const cases = [
    { uid: 1667, email: 'lll@xinketaiic.cn', mfrText: 'Micron' },
    { uid: 1668, email: 'y@xinyuanxin.net', mfrText: 'Texas Instruments' },
    { uid: 1670, email: 'yangtuo0212@163.com', mfrText: 'ISSI' },
  ];

  for (const c of cases) {
    let partner = null;
    try {
      partner = await resolvePartner({ email: c.email, partnerType: 'customer' });
    } catch (e) {
      partner = { error: e.message };
    }
    let mfr = null;
    try {
      mfr = await lookupMfr(c.mfrText);
    } catch (e) {
      mfr = { error: e.message };
    }
    console.log(JSON.stringify({ uid: c.uid, email: c.email, partner, mfr }));
  }
})();
