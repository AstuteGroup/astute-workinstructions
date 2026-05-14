#!/usr/bin/env node
/**
 * Ad-hoc IMAP reader for stockRFQ@ — open any folder, dump message by UID.
 * Usage: node oneoffs/read-imap-uid.js <folder> <uid> [<uid> ...]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const INBOX = 'stockRFQ@orangetsunami.com';
const HOST = process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com';
const PORT = parseInt(process.env.IMAP_PORT || '993', 10);
const PASS = process.env.WORKMAIL_PASS;
if (!PASS) { console.error('WORKMAIL_PASS missing'); process.exit(2); }

const [folder, ...uidArgs] = process.argv.slice(2);
if (!folder || uidArgs.length === 0) {
  console.error('Usage: read-imap-uid.js <folder> <uid> [<uid> ...]');
  process.exit(2);
}

function parseFwd(body) {
  if (!body) return {};
  const text = body
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<\/div>/gi, '\n')
    .replace(/<[a-zA-Z\/][^>@]*>/g, ' ');
  const out = { quotedFroms: [], quotedSubjects: [] };
  const fromRe = /^[ \t>]*From:[ \t]*(.+)$/gim;
  const subjRe = /^[ \t>]*Subject:[ \t]*(.+)$/gim;
  let m;
  while ((m = fromRe.exec(text))) out.quotedFroms.push(m[1].trim());
  while ((m = subjRe.exec(text))) out.quotedSubjects.push(m[1].trim());
  return out;
}

(async () => {
  const client = new ImapFlow({ host: HOST, port: PORT, secure: true,
    auth: { user: INBOX, pass: PASS }, logger: false });
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      for (const uid of uidArgs) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) { console.log(`---\nUID ${uid}: NOT FOUND`); continue; }
        const p = await simpleParser(msg.source);
        const bodyText = p.text || p.html || '';
        const fwd = parseFwd(bodyText);
        console.log('=================================================================');
        console.log(`UID:        ${uid}`);
        console.log(`From:       ${p.from && p.from.text}`);
        console.log(`To:         ${p.to && p.to.text}`);
        console.log(`Subject:    ${p.subject}`);
        console.log(`Date:       ${p.date && p.date.toISOString()}`);
        console.log(`Message-ID: ${p.messageId}`);
        console.log(`In-Reply-To:${p.inReplyTo || ''}`);
        const refs = Array.isArray(p.references) ? p.references : (p.references ? String(p.references).split(/\s+/) : []);
        console.log(`References: ${refs.join(' ')}`);
        console.log(`\n--- Quoted Froms (deepest first):`);
        fwd.quotedFroms.forEach((f, i) => console.log(`  [${i+1}] ${f}`));
        console.log(`\n--- Quoted Subjects:`);
        fwd.quotedSubjects.forEach((s, i) => console.log(`  [${i+1}] ${s}`));
        console.log(`\n--- Body (first 4000 chars):`);
        console.log(bodyText.slice(0, 4000));
      }
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
})().catch(e => { console.error(e); process.exit(1); });
