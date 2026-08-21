#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { execSync } = require('child_process');
const { parseShippingEmail } = require('../shared/tracking-parser.js');

const IMAP_HOST = process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com';
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993', 10);
const WORKMAIL_PASS = process.env.WORKMAIL_PASS;
const INBOX = 'tracking@orangetsunami.com';

const UIDS = [710,561,499,496,421,418,416,414,412,397,394,389,316,313,241,158,152,146,140,137,134,131,124,119,115,109,84,81,79,72,66,62,38,17,8,5];

function psql(sql) {
  try {
    const out = execSync(
      `psql -U analytics_user -d idempiere_replica -t -A -F'|' -c "${sql.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8' }
    );
    return out.trim();
  } catch (e) {
    return 'ERR:' + (e.stderr || e.message);
  }
}

function lookupPO(ref) {
  if (ref.type === 'ot_po') {
    const sql = `SELECT c_order_id, documentno, bp.name, chuboe_trackingnumbers FROM adempiere.c_order o JOIN adempiere.c_bpartner bp ON o.c_bpartner_id=bp.c_bpartner_id WHERE o.issotrx='N' AND o.isactive='Y' AND o.documentno='${ref.reference}'`;
    return psql(sql);
  } else if (ref.type === 'infor_pov') {
    const povDigits = ref.reference.replace('POV', '');
    const sql = `SELECT o.c_order_id, o.documentno, bp.name, o.chuboe_trackingnumbers, count(ol.c_orderline_id) as line_count FROM adempiere.c_orderline ol JOIN adempiere.c_order o ON ol.c_order_id=o.c_order_id JOIN adempiere.c_bpartner bp ON o.c_bpartner_id=bp.c_bpartner_id WHERE ol.chuboe_po_string ILIKE '%${povDigits}%' AND o.isactive='Y' GROUP BY o.c_order_id,o.documentno,bp.name,o.chuboe_trackingnumbers`;
    return psql(sql);
  }
  return '';
}

(async () => {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: INBOX, pass: WORKMAIL_PASS },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock('NeedsReview');
  const results = [];
  try {
    for (const uid of UIDS) {
      const msg = await client.fetchOne(String(uid), { envelope: true, source: true }, { uid: true });
      if (!msg) { results.push({ uid, error: 'not found' }); continue; }
      const parsed = await simpleParser(msg.source);
      const text = (parsed.text || parsed.html || '').toString();
      const env = msg.envelope || {};
      const from = env.from && env.from[0] ? `${env.from[0].mailbox}@${env.from[0].host}` : '';
      const parsedShip = parseShippingEmail(text);

      const poLookups = parsedShip.poRefs.map(ref => ({ ref: ref.reference, db: lookupPO(ref) }));

      results.push({
        uid,
        subject: env.subject,
        from,
        date: env.date,
        tracking: parsedShip.tracking,
        poRefs: parsedShip.poRefs.map(r => r.reference),
        poLookups,
        bodySnippet: text.slice(0, 1500),
      });
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  require('fs').writeFileSync(__dirname + '/triage-needsreview-2026-08-21-output.json', JSON.stringify(results, null, 2));
  console.log('wrote', results.length, 'results');
})();
