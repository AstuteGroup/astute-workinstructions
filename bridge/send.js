#!/usr/bin/env node
/**
 * Send a message to connected Chrome extension clients
 *
 * Usage:
 *   node send.js <type> [payload-json]
 *   node send.js navigate '{"url": "https://example.com"}'
 *   node send.js notify '{"message": "Processing complete!"}'
 *   echo '{"type":"custom","payload":{}}' | node send.js --stdin
 */

const fs = require('fs');
const path = require('path');

const OUTBOX_DIR = path.join(__dirname, 'outbox');

// Ensure outbox exists
if (!fs.existsSync(OUTBOX_DIR)) {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
}

async function main() {
  let msg;

  if (process.argv.includes('--stdin')) {
    // Read from stdin
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    msg = JSON.parse(Buffer.concat(chunks).toString());
  } else {
    const type = process.argv[2];
    const payloadStr = process.argv[3];

    if (!type) {
      console.error('Usage: node send.js <type> [payload-json]');
      console.error('       echo \'{"type":"x","payload":{}}\' | node send.js --stdin');
      process.exit(1);
    }

    msg = {
      type,
      payload: payloadStr ? JSON.parse(payloadStr) : {},
      id: `msg-${Date.now()}`
    };
  }

  const filename = `${Date.now()}-${msg.type}.json`;
  const filepath = path.join(OUTBOX_DIR, filename);

  fs.writeFileSync(filepath, JSON.stringify(msg, null, 2));
  console.log(`[send] Queued: ${filename}`);
  console.log(`[send] Message:`, JSON.stringify(msg, null, 2));
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
