#!/usr/bin/env node
/**
 * Claude Bridge CLI
 *
 * Terminal-side interface for the browser bridge.
 *
 * Usage:
 *   node cli.js server              Start the WebSocket server
 *   node cli.js inbox               List pending messages from browser
 *   node cli.js inbox --watch       Watch for new messages
 *   node cli.js inbox --latest      Show the most recent message
 *   node cli.js send <type> [json]  Send a command to browser
 *   node cli.js navigate <url>      Navigate browser to URL
 *   node cli.js click <selector>    Click an element
 *   node cli.js scrape <selector>   Get element content
 *   node cli.js page                Request current page content
 *   node cli.js notify <message>    Show notification in browser
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const command = args[0];

const BRIDGE_DIR = __dirname;
const INBOX_DIR = path.join(BRIDGE_DIR, 'inbox');
const OUTBOX_DIR = path.join(BRIDGE_DIR, 'outbox');

// Ensure directories exist
[INBOX_DIR, OUTBOX_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function queueCommand(type, payload) {
  const msg = {
    type,
    payload,
    id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  };

  const filename = `${Date.now()}-${type}.json`;
  fs.writeFileSync(path.join(OUTBOX_DIR, filename), JSON.stringify(msg, null, 2));
  console.log(`Queued: ${type}`);
  return msg;
}

function listInbox() {
  const files = fs.readdirSync(INBOX_DIR)
    .filter(f => f.endsWith('.json') && !fs.statSync(path.join(INBOX_DIR, f)).isDirectory())
    .sort();

  if (files.length === 0) {
    console.log('No messages in inbox');
    return;
  }

  console.log(`${files.length} message(s):\n`);
  files.forEach(filename => {
    const content = JSON.parse(fs.readFileSync(path.join(INBOX_DIR, filename), 'utf-8'));
    console.log(`  ${filename}`);
    console.log(`    Type: ${content.type}`);
    if (content.payload?.url) console.log(`    URL: ${content.payload.url}`);
    console.log();
  });
}

function watchInbox() {
  console.log('Watching for messages... (Ctrl+C to stop)\n');

  fs.watch(INBOX_DIR, (eventType, filename) => {
    if (eventType !== 'rename' || !filename.endsWith('.json')) return;

    setTimeout(() => {
      const filepath = path.join(INBOX_DIR, filename);
      if (!fs.existsSync(filepath)) return;

      try {
        const content = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
        console.log(`\n[${new Date().toISOString()}] ${content.type}`);
        console.log(JSON.stringify(content.payload, null, 2));
      } catch (err) {
        // Ignore
      }
    }, 100);
  });
}

function showLatest() {
  const files = fs.readdirSync(INBOX_DIR)
    .filter(f => f.endsWith('.json') && !fs.statSync(path.join(INBOX_DIR, f)).isDirectory())
    .sort();

  if (files.length === 0) {
    console.log('No messages in inbox');
    return;
  }

  const latest = files[files.length - 1];
  const content = JSON.parse(fs.readFileSync(path.join(INBOX_DIR, latest), 'utf-8'));
  console.log(JSON.stringify(content, null, 2));
}

function showHelp() {
  console.log(`
Claude Bridge CLI

Commands:
  server              Start the WebSocket server
  inbox               List pending messages from browser
  inbox --watch       Watch for new messages
  inbox --latest      Show the most recent message
  send <type> [json]  Send a command to browser
  navigate <url>      Navigate browser to URL
  click <selector>    Click an element
  fill <sel> <value>  Fill a form field
  scrape <selector>   Get element content
  page                Request current page content
  notify <message>    Show notification in browser

Examples:
  node cli.js navigate "https://google.com"
  node cli.js click "#submit-button"
  node cli.js fill "#search" "hello world"
  node cli.js scrape "table" --all
  node cli.js notify "Processing complete!"
`);
}

// Main
switch (command) {
  case 'server':
    require('./server');
    break;

  case 'inbox':
    if (args.includes('--watch')) {
      watchInbox();
    } else if (args.includes('--latest')) {
      showLatest();
    } else {
      listInbox();
    }
    break;

  case 'send':
    const sendType = args[1];
    const sendPayload = args[2] ? JSON.parse(args[2]) : {};
    if (!sendType) {
      console.error('Usage: send <type> [payload-json]');
      process.exit(1);
    }
    queueCommand(sendType, sendPayload);
    break;

  case 'navigate':
    const url = args[1];
    if (!url) {
      console.error('Usage: navigate <url>');
      process.exit(1);
    }
    queueCommand('navigate', { url });
    break;

  case 'click':
    const clickSelector = args[1];
    if (!clickSelector) {
      console.error('Usage: click <selector>');
      process.exit(1);
    }
    queueCommand('click', { selector: clickSelector });
    break;

  case 'fill':
    const fillSelector = args[1];
    const fillValue = args[2];
    if (!fillSelector || fillValue === undefined) {
      console.error('Usage: fill <selector> <value>');
      process.exit(1);
    }
    queueCommand('fill', { selector: fillSelector, value: fillValue });
    break;

  case 'scrape':
    const scrapeSelector = args[1];
    if (!scrapeSelector) {
      console.error('Usage: scrape <selector>');
      process.exit(1);
    }
    queueCommand('scrape', {
      selector: scrapeSelector,
      all: args.includes('--all')
    });
    break;

  case 'page':
    queueCommand('get_page', {});
    break;

  case 'notify':
    const message = args.slice(1).join(' ');
    if (!message) {
      console.error('Usage: notify <message>');
      process.exit(1);
    }
    queueCommand('notify', { message, type: 'info' });
    break;

  // === Debugger-powered commands (require v2 extension with debugger permission) ===
  case 'real_type':
    queueCommand('real_type', { selector: args[1], text: args[2] });
    break;

  case 'real_fill':
    queueCommand('real_fill', { selector: args[1], value: args[2] });
    break;

  case 'real_click':
    queueCommand('real_click', { selector: args[1] });
    break;

  case 'real_key':
    queueCommand('real_key', { key: args[1] });
    break;

  case 'eval':
    queueCommand('eval', { expression: args.slice(1).join(' ') });
    break;

  case 'upload':
    // node cli.js upload <file-on-server> <selector>
    const localFile = args[1];
    const uploadSelector = args[2];
    if (!localFile || !uploadSelector) {
      console.error('Usage: upload <local-file-on-server> <selector>');
      process.exit(1);
    }
    const fileBuffer = fs.readFileSync(localFile);
    const base64 = fileBuffer.toString('base64');
    const filename = path.basename(localFile);
    // Stage in browser, then upload — caller chains via the inbox
    queueCommand('stage_file', { filename, base64 });
    console.log('Staged. Wait for stage_file result, then run: node cli.js send upload_file \'{"selector":"' + uploadSelector + '","paths":["<path-from-stage>"]}\'');
    break;

  case 'help':
  case '--help':
  case '-h':
  default:
    showHelp();
}
