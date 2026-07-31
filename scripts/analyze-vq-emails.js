#!/usr/bin/env node
/**
 * One-time script to analyze email arrival patterns in the vq@ inbox.
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { ImapFlow } = require('imapflow');

const INBOX = 'vq@orangetsunami.com';
const IMAP_HOST = process.env.IMAP_HOST || 'imap.mail.us-east-1.awsapps.com';
const WORKMAIL_PASS = process.env.WORKMAIL_PASS;

(async () => {
  try {
    if (!WORKMAIL_PASS) {
      console.log('Error: WORKMAIL_PASS not set');
      return;
    }

    const client = new ImapFlow({
      host: IMAP_HOST,
      port: 993,
      secure: true,
      auth: { user: INBOX, pass: WORKMAIL_PASS },
      logger: false
    });

    await client.connect();

    // List all folders first
    console.log('Folders in vq@ mailbox:');
    const folders = await client.list();
    for (const folder of folders) {
      try {
        const st = await client.status(folder.path, { messages: true, unseen: true });
        if (st.messages > 0) {
          console.log('  ' + folder.path + ': ' + st.messages + ' messages (' + st.unseen + ' unseen)');
        }
      } catch (e) {
        // skip non-selectable folders
      }
    }
    console.log('');

    const status = await client.status('INBOX', { messages: true, unseen: true });
    console.log('VQ INBOX - total:', status.messages, ', unseen:', status.unseen);

    // Get message dates for last 17 days from PROCESSED folder
    const lock = await client.getMailboxLock('Processed');
    const since = new Date(Date.now() - 17*24*60*60*1000);
    let count = 0;
    const byDayHour = {};

    for await (const msg of client.fetch({ since }, { envelope: true })) {
      count++;
      const d = new Date(msg.envelope.date);
      // Convert to CT (UTC-5)
      const ct = new Date(d.getTime() - 5*3600*1000);
      const day = ct.toISOString().slice(0,10);
      const hour = ct.getUTCHours();
      if (!byDayHour[day]) byDayHour[day] = {};
      byDayHour[day][hour] = (byDayHour[day][hour] || 0) + 1;
    }
    lock.release();

    console.log('Messages in last 17 days:', count);

    const days = Object.keys(byDayHour).sort();
    if (days.length > 0) {
      console.log('Spans', days.length, 'days:', days[0], 'to', days[days.length-1]);

      console.log('');
      console.log('APAC Morning (20:00-23:59 CT = 9am-12pm HKT):');
      console.log('Day          | 20:00 | 21:00 | 22:00 | 23:00 | Total');
      console.log('-------------|-------|-------|-------|-------|------');
      let t = 0;
      days.forEach(day => {
        const h = byDayHour[day];
        const v = [h[20]||0, h[21]||0, h[22]||0, h[23]||0];
        const s = v.reduce((a,b)=>a+b,0);
        t += s;
        if (s > 0) console.log(day + ' |   ' + v.map(x=>String(x).padStart(2)).join('  |   ') + '  |   ' + String(s).padStart(2));
      });
      console.log('SUBTOTAL     |       |       |       |       |  ' + t);

      console.log('');
      console.log('APAC Afternoon (00:00-05:59 CT = 1pm-6pm HKT):');
      console.log('Day          | 00:00 | 01:00 | 02:00 | 03:00 | 04:00 | 05:00 | Total');
      console.log('-------------|-------|-------|-------|-------|-------|-------|------');
      t = 0;
      days.forEach(day => {
        const h = byDayHour[day];
        const v = [h[0]||0, h[1]||0, h[2]||0, h[3]||0, h[4]||0, h[5]||0];
        const s = v.reduce((a,b)=>a+b,0);
        t += s;
        if (s > 0) console.log(day + ' |   ' + v.map(x=>String(x).padStart(2)).join('  |   ') + '  |   ' + String(s).padStart(2));
      });
      console.log('SUBTOTAL     |       |       |       |       |       |       |  ' + t);

      // Also show Western hours
      console.log('');
      console.log('Western Hours (06:00-16:00 CT):');
      console.log('Day          | 06  07  08  09  10  11  12  13  14  15  16 | Total');
      console.log('-------------|---------------------------------------------|------');
      t = 0;
      days.forEach(day => {
        const h = byDayHour[day];
        const v = [6,7,8,9,10,11,12,13,14,15,16].map(hr => h[hr]||0);
        const s = v.reduce((a,b)=>a+b,0);
        t += s;
        if (s > 0) console.log(day + ' | ' + v.map(x=>String(x).padStart(2)).join('  ') + ' |   ' + String(s).padStart(2));
      });
      console.log('SUBTOTAL     |                                             |  ' + t);
    }

    await client.logout();
  } catch (e) {
    console.log('Error:', e.message);
    console.log(e.stack);
  }
})();
