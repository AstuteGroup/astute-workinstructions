require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { createFetcher } = require('../../shared/email-fetcher');
const fetcher = createFetcher('excess');

(async () => {
  const envs = await fetcher.listEnvelopes('INBOX', 30);
  envs.sort((a, b) => new Date(b.date) - new Date(a.date));
  console.log('Recent excess@ messages (newest first):');
  for (const e of envs.slice(0, 25)) {
    const who = e.from.addr || '(unknown)';
    const atts = e.attachmentNames && e.attachmentNames.length ? ` [📎 ${e.attachmentNames.join(', ')}]` : '';
    console.log(`  ${e.date.slice(0,16)}  uid=${e.id}  ${who.padEnd(40)} | ${e.subject}${atts}`);
  }
})();
