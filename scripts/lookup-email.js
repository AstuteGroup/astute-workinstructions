#!/usr/bin/env node
/**
 * scripts/lookup-email.js
 *
 * CLI tool to look up emails by tracking ID, Message-ID, or UID.
 *
 * USAGE:
 *   node scripts/lookup-email.js VQ-11948
 *   node scripts/lookup-email.js --message-id "<abc123@host>"
 *   node scripts/lookup-email.js --uid 11948 --inbox vq@orangetsunami.com
 *   node scripts/lookup-email.js --stats
 *   node scripts/lookup-email.js --list vq@orangetsunami.com --status pending_review --limit 10
 */

'use strict';

const path = require('path');
const {
  lookupByTrackingId,
  lookupByMessageId,
  lookupByUid,
  listByInbox,
  getStats,
  INBOX_PREFIXES,
} = require('../shared/tracking-id');

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function formatRecord(record) {
  if (!record) return 'Not found';

  const lines = [
    '',
    `  Tracking ID:    ${record.trackingId}`,
    `  Inbox:          ${record.inbox}`,
    `  Message-ID:     ${record.messageId || '(none)'}`,
    `  Original UID:   ${record.uid}`,
    `  Subject:        ${record.subject || '(none)'}`,
    `  From:           ${record.from || '(none)'}`,
    `  Received:       ${formatDate(record.receivedAt)}`,
    `  Current Folder: ${record.currentFolder || '(unknown)'}`,
    `  Status:         ${record.status || '(unknown)'}`,
    `  Last Updated:   ${formatDate(record.lastUpdated)}`,
  ];

  // Add any extra fields (rfqSearchKey, etc.)
  const standardFields = new Set([
    'trackingId', 'inbox', 'messageId', 'uid', 'subject', 'from',
    'receivedAt', 'currentFolder', 'status', 'lastUpdated'
  ]);
  for (const [key, value] of Object.entries(record)) {
    if (!standardFields.has(key) && value !== null && value !== undefined) {
      lines.push(`  ${key}: ${JSON.stringify(value)}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function formatDate(isoString) {
  if (!isoString) return '(none)';
  try {
    const d = new Date(isoString);
    // Format as "2026-08-05 15:30 CT"
    return d.toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).replace(',', '') + ' CT';
  } catch (e) {
    return isoString;
  }
}

function formatStats(stats) {
  const lines = [
    '',
    '=== Email Tracking Registry Stats ===',
    '',
    `Total Records: ${stats.totalRecords}`,
    '',
    'By Inbox:',
  ];

  for (const [inbox, count] of Object.entries(stats.byInbox).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${inbox}: ${count}`);
  }

  lines.push('');
  lines.push('By Status:');
  for (const [status, count] of Object.entries(stats.byStatus).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${status}: ${count}`);
  }

  lines.push('');
  return lines.join('\n');
}

function formatList(records) {
  if (records.length === 0) return '\nNo records found.\n';

  const lines = [
    '',
    `Found ${records.length} record(s):`,
    '',
    '  ID            | Status          | Folder          | Subject',
    '  --------------|-----------------|-----------------|----------------------------------',
  ];

  for (const r of records) {
    const id = (r.trackingId || '').padEnd(12);
    const status = (r.status || '').padEnd(15);
    const folder = (r.currentFolder || '').padEnd(15);
    const subject = (r.subject || '').substring(0, 34);
    lines.push(`  ${id} | ${status} | ${folder} | ${subject}`);
  }

  lines.push('');
  return lines.join('\n');
}

function printUsage() {
  console.log(`
Usage:
  node lookup-email.js <tracking-id>
  node lookup-email.js --message-id "<message-id>"
  node lookup-email.js --uid <uid> --inbox <inbox>
  node lookup-email.js --stats
  node lookup-email.js --list <inbox> [--status <status>] [--limit <n>]

Examples:
  node lookup-email.js VQ-11948
  node lookup-email.js --message-id "<CAGz8qY=abc@mail.gmail.com>"
  node lookup-email.js --uid 11948 --inbox vq@orangetsunami.com
  node lookup-email.js --stats
  node lookup-email.js --list vq@orangetsunami.com --status pending_review --limit 20

Available Inboxes:
${Object.entries(INBOX_PREFIXES).map(([inbox, prefix]) => `  ${prefix.padEnd(4)} → ${inbox}`).join('\n')}
`);
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  // --stats
  if (args.includes('--stats')) {
    const stats = getStats();
    console.log(formatStats(stats));
    process.exit(0);
  }

  // --list <inbox>
  const listIdx = args.indexOf('--list');
  if (listIdx !== -1) {
    const inbox = args[listIdx + 1];
    if (!inbox) {
      console.error('Error: --list requires an inbox address');
      process.exit(1);
    }

    const statusIdx = args.indexOf('--status');
    const status = statusIdx !== -1 ? args[statusIdx + 1] : undefined;

    const limitIdx = args.indexOf('--limit');
    const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : undefined;

    const records = listByInbox(inbox, { status, limit });
    console.log(formatList(records));
    process.exit(0);
  }

  // --message-id "<mid>"
  const midIdx = args.indexOf('--message-id');
  if (midIdx !== -1) {
    const messageId = args[midIdx + 1];
    if (!messageId) {
      console.error('Error: --message-id requires a Message-ID value');
      process.exit(1);
    }
    const record = lookupByMessageId(messageId);
    console.log(formatRecord(record));
    process.exit(record ? 0 : 1);
  }

  // --uid <uid> --inbox <inbox>
  const uidIdx = args.indexOf('--uid');
  if (uidIdx !== -1) {
    const uid = parseInt(args[uidIdx + 1], 10);
    const inboxIdx = args.indexOf('--inbox');
    const inbox = inboxIdx !== -1 ? args[inboxIdx + 1] : null;

    if (!uid || isNaN(uid)) {
      console.error('Error: --uid requires a numeric UID');
      process.exit(1);
    }
    if (!inbox) {
      console.error('Error: --uid requires --inbox <inbox>');
      process.exit(1);
    }

    const record = lookupByUid(uid, inbox);
    console.log(formatRecord(record));
    process.exit(record ? 0 : 1);
  }

  // Default: first arg is a tracking ID
  const trackingId = args[0];
  if (trackingId) {
    const record = lookupByTrackingId(trackingId.toUpperCase());
    console.log(formatRecord(record));
    process.exit(record ? 0 : 1);
  }

  printUsage();
  process.exit(1);
}

main();
