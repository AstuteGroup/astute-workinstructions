'use strict';
/**
 * Email the full-flow-doc.md to Jake — both as inline HTML and as a .md attachment.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env') });
const fs = require('fs');

const { sendWithFallback } = require('../../../shared/verified-send');

// Minimal markdown-to-HTML converter sized for this specific doc.
// Handles: # ## ### ####, ```code blocks```, tables, - bullets, **bold**,
// `inline code`, blockquotes (>), paragraphs.
function mdToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  let inCode = false;
  let codeLang = '';
  let codeBuf = [];

  function escape(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function inline(s) {
    // Order matters: code first (so we don't try to format inside it), then bold, then italic, then links
    s = s.replace(/`([^`]+)`/g, (_, c) => `<code style="background:#f4f4f4;padding:2px 5px;border-radius:3px;font-family:Consolas,Monaco,monospace;font-size:0.9em">${escape(c)}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|\W)\*([^*\s][^*]*?)\*(\W|$)/g, '$1<em>$2</em>$3');
    return s;
  }

  function emitTable(tbl) {
    if (tbl.length < 2) return;
    // tbl[0] = header, tbl[1] = separator, tbl[2:] = rows
    const headers = tbl[0].split('|').slice(1, -1).map(s => s.trim());
    const rows = tbl.slice(2).map(r => r.split('|').slice(1, -1).map(s => s.trim()));
    out.push('<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;font-size:13px;font-family:Arial,sans-serif;margin:10px 0;width:100%">');
    out.push('<thead><tr style="background:#2c3e50;color:#fff">');
    headers.forEach(h => out.push(`<th style="text-align:left">${inline(h)}</th>`));
    out.push('</tr></thead><tbody>');
    rows.forEach((row, idx) => {
      const bg = idx % 2 ? '#f9f9f9' : '#fff';
      out.push(`<tr style="background:${bg}">`);
      row.forEach(c => out.push(`<td style="vertical-align:top">${inline(c)}</td>`));
      out.push('</tr>');
    });
    out.push('</tbody></table>');
  }

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      if (inCode) {
        out.push(`<pre style="background:#2c3e50;color:#ecf0f1;padding:12px;border-radius:4px;overflow-x:auto;font-family:Consolas,Monaco,monospace;font-size:12px;line-height:1.5">${escape(codeBuf.join('\n'))}</pre>`);
        inCode = false; codeBuf = []; codeLang = '';
      } else {
        inCode = true; codeLang = line.slice(3).trim();
      }
      i++; continue;
    }
    if (inCode) { codeBuf.push(line); i++; continue; }

    // Tables: a line starting with | followed by |---|---| separator
    if (line.startsWith('|') && i + 1 < lines.length && /^\|[\s|:-]+\|$/.test(lines[i + 1])) {
      const tbl = [];
      while (i < lines.length && lines[i].startsWith('|')) { tbl.push(lines[i]); i++; }
      emitTable(tbl);
      continue;
    }

    // Headers
    if (line.startsWith('#### ')) { out.push(`<h4 style="color:#2c3e50;margin-top:18px">${inline(escape(line.slice(5)))}</h4>`); i++; continue; }
    if (line.startsWith('### ')) { out.push(`<h3 style="color:#2c3e50;border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:22px">${inline(escape(line.slice(4)))}</h3>`); i++; continue; }
    if (line.startsWith('## ')) { out.push(`<h2 style="color:#1a5490;border-bottom:2px solid #2c3e50;padding-bottom:6px;margin-top:30px">${inline(escape(line.slice(3)))}</h2>`); i++; continue; }
    if (line.startsWith('# ')) { out.push(`<h1 style="color:#1a5490;font-size:26px;margin-top:0">${inline(escape(line.slice(2)))}</h1>`); i++; continue; }

    // Horizontal rule
    if (/^-{3,}$/.test(line.trim())) { out.push('<hr style="border:none;border-top:1px solid #ccc;margin:25px 0">'); i++; continue; }

    // Blockquote
    if (line.startsWith('> ')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('> ')) { buf.push(lines[i].slice(2)); i++; }
      out.push(`<blockquote style="border-left:4px solid #f39c12;background:#fef9e7;padding:8px 14px;margin:10px 0">${inline(escape(buf.join(' ')))}</blockquote>`);
      continue;
    }

    // Bullets
    if (line.startsWith('- ')) {
      out.push('<ul style="line-height:1.6">');
      while (i < lines.length && lines[i].startsWith('- ')) {
        out.push(`<li>${inline(escape(lines[i].slice(2)))}</li>`);
        i++;
      }
      out.push('</ul>');
      continue;
    }

    // Empty line
    if (line.trim() === '') { i++; continue; }

    // Regular paragraph
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^[#>\-`|]/.test(lines[i])) { buf.push(lines[i]); i++; }
    out.push(`<p style="line-height:1.6;font-family:Arial,sans-serif">${inline(escape(buf.join(' ')))}</p>`);
  }

  return out.join('\n');
}

(async () => {
  const mdPath = path.resolve(__dirname, 'full-flow-doc.md');
  const md = fs.readFileSync(mdPath, 'utf8');
  const html = `<!doctype html><html><body style="max-width:1100px;margin:0 auto;padding:20px;font-family:Arial,sans-serif;color:#333">${mdToHtml(md)}</body></html>`;

  const recipient = process.env.OPERATOR_EMAIL || 'jake.harris@astutegroup.com';
  const subject = 'Customer Excess — Full Pipeline Work Instructions (every branch, every cog)';

  const pass = process.env.WORKMAIL_PASS || process.env.SMTP_PASS;
  if (!pass) throw new Error('WORKMAIL_PASS / SMTP_PASS not set in env');

  const result = await sendWithFallback({
    primary: { from: 'excess@orangetsunami.com', pass, displayName: 'Customer Excess Pipeline' },
    fallback: { from: 'stockRFQ@orangetsunami.com', pass, displayName: 'Customer Excess Pipeline (fallback)' },
    mail: {
      to: recipient,
      subject,
      html,
      attachments: [
        { filename: 'customer-excess-full-flow.md', content: md, contentType: 'text/markdown' },
      ],
    },
    log: (...args) => console.log('[verified-send]', ...args),
  });

  console.log(`Sent to ${recipient}: delivered=${result.delivered}, messageId=${result.messageId}, bounceDetected=${result.bounceDetected}`);
})().catch(e => { console.error(e); process.exit(1); });
