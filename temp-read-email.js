const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
require('dotenv').config({ path: '/home/analytics_user/workspace/.env' });

async function main() {
  const pass = process.env.WORKMAIL_PASS || process.env.SMTP_PASS;
  if (!pass) throw new Error('No password configured');

  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com',
    port: parseInt(process.env.IMAP_PORT || '993'),
    secure: true,
    auth: {
      user: 'rfqloading@orangetsunami.com',
      pass: pass
    },
    logger: false
  });

  await client.connect();
  await client.mailboxOpen('INBOX');

  const msg = await client.fetchOne('229', { source: true, envelope: true });
  console.log('Subject:', msg.envelope.subject);
  console.log('From:', JSON.stringify(msg.envelope.from));
  console.log('Date:', msg.envelope.date);

  const parsed = await simpleParser(msg.source);
  console.log('---TEXT BODY---');
  console.log(parsed.text || '(no text)');
  console.log('---ATTACHMENTS---');
  if (parsed.attachments && parsed.attachments.length > 0) {
    for (const att of parsed.attachments) {
      console.log('Attachment:', att.filename, att.contentType, att.size, 'bytes');
    }
  }

  await client.logout();
}
main().catch(e => console.error('Error:', e.message));
