#!/usr/bin/env node
/**
 * Read messages from the inbox (sent by Chrome extension)
 *
 * Usage:
 *   node read-inbox.js              # List all pending messages
 *   node read-inbox.js --latest     # Show the most recent message
 *   node read-inbox.js --watch      # Watch for new messages
 *   node read-inbox.js --clear      # Archive all messages
 */

const fs = require('fs');
const path = require('path');

const INBOX_DIR = path.join(__dirname, 'inbox');
const ARCHIVE_DIR = path.join(INBOX_DIR, 'processed');

// Ensure directories exist
[INBOX_DIR, ARCHIVE_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function getMessages() {
  return fs.readdirSync(INBOX_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(filename => {
      const filepath = path.join(INBOX_DIR, filename);
      const content = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
      return { filename, filepath, ...content };
    });
}

function archiveMessage(filepath, filename) {
  fs.renameSync(filepath, path.join(ARCHIVE_DIR, filename));
}

const args = process.argv.slice(2);

if (args.includes('--watch')) {
  console.log('[inbox] Watching for new messages... (Ctrl+C to stop)\n');

  fs.watch(INBOX_DIR, (eventType, filename) => {
    if (eventType !== 'rename' || !filename.endsWith('.json')) return;

    setTimeout(() => {
      const filepath = path.join(INBOX_DIR, filename);
      if (!fs.existsSync(filepath)) return;

      try {
        const content = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
        console.log(`\n[${new Date().toISOString()}] New message: ${content.type}`);
        console.log(JSON.stringify(content, null, 2));
      } catch (err) {
        console.error('Error reading message:', err.message);
      }
    }, 100);
  });

} else if (args.includes('--latest')) {
  const messages = getMessages();
  if (messages.length === 0) {
    console.log('[inbox] No messages');
  } else {
    const latest = messages[messages.length - 1];
    console.log(JSON.stringify(latest, null, 2));
  }

} else if (args.includes('--clear')) {
  const messages = getMessages();
  messages.forEach(msg => archiveMessage(msg.filepath, msg.filename));
  console.log(`[inbox] Archived ${messages.length} message(s)`);

} else {
  const messages = getMessages();
  if (messages.length === 0) {
    console.log('[inbox] No messages');
  } else {
    console.log(`[inbox] ${messages.length} message(s):\n`);
    messages.forEach(msg => {
      console.log(`  ${msg.filename}`);
      console.log(`    Type: ${msg.type}`);
      if (msg.payload?.url) console.log(`    URL: ${msg.payload.url}`);
      console.log();
    });
  }
}
