require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { createFetcher } = require('../../shared/email-fetcher');
const fetcher = createFetcher('excess');

(async () => {
  const outDir = '/tmp/lam_static';
  require('fs').mkdirSync(outDir, { recursive: true });
  const result = await fetcher.downloadAttachments(577, 'INBOX', outDir);
  console.log(JSON.stringify(result, null, 2));
})();
