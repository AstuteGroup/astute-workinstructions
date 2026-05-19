#!/usr/bin/env node
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { ImapFlow } = require('imapflow');

(async () => {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: 993, secure: true,
    auth: { user: 'vq@orangetsunami.com', pass: process.env.WORKMAIL_PASS },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const uids = await client.search({ since }, { uid: true });
    console.log(`INBOX has ${uids?.length || 0} msgs in last 3d`);
    if (uids?.length) {
      for await (const m of client.fetch(uids.slice(-30), { envelope: true, bodyStructure: true }, { uid: true })) {
        const env = m.envelope || {};
        const from = env.from && env.from[0] ? `${env.from[0].mailbox || ''}@${env.from[0].host || ''}` : '';
        const atts = [];
        const walk = (n) => {
          if (!n) return;
          if (Array.isArray(n.childNodes)) n.childNodes.forEach(walk);
          const disp = (n.disposition || '').toLowerCase();
          const fname = (n.dispositionParameters && n.dispositionParameters.filename) ||
                        (n.parameters && n.parameters.name) || null;
          if (disp === 'attachment' && fname && !/^image\//i.test(n.type || '')) atts.push(fname);
        };
        walk(m.bodyStructure);
        const flag = /amat|master|mcmaster|1134421/i.test((env.subject || '')) ? ' <-- MATCH' : '';
        console.log(`uid=${m.uid}  ${env.date ? env.date.toISOString() : ''}  from=${from}  subj=${(env.subject || '').slice(0,90)}  atts=${atts.join(',')}${flag}`);
      }
    }
  } finally { lock.release(); }
  await client.logout();
})().catch(e => { console.error(e); process.exit(1); });
