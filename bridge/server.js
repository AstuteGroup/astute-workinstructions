/**
 * Claude Bridge Server
 *
 * WebSocket server that enables communication between the Claude Chrome extension
 * and this terminal session. Listens on port 7681.
 *
 * Protocol:
 *   Messages are JSON with { type, payload, id? }
 *   - type: string identifying the message type
 *   - payload: arbitrary data
 *   - id: optional correlation ID for request/response pairing
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = 7681;
const INBOX_DIR = path.join(__dirname, 'inbox');
const OUTBOX_DIR = path.join(__dirname, 'outbox');

// Ensure directories exist
[INBOX_DIR, OUTBOX_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Track connected clients
const clients = new Set();

// Create WebSocket server
const wss = new WebSocket.Server({ port: PORT });

console.log(`[bridge] WebSocket server listening on ws://localhost:${PORT}`);
console.log(`[bridge] Inbox:  ${INBOX_DIR}`);
console.log(`[bridge] Outbox: ${OUTBOX_DIR}`);

wss.on('connection', (ws, req) => {
  const clientId = `client-${Date.now()}`;
  clients.add(ws);

  console.log(`[bridge] Client connected: ${clientId} (${clients.size} total)`);

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connected',
    payload: {
      clientId,
      serverTime: new Date().toISOString(),
      message: 'Connected to Claude Bridge'
    }
  }));

  // Replay any commands queued while no clients were connected
  setTimeout(flushOutbox, 200);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log(`[bridge] Received: ${msg.type}`, msg.payload ? '(has payload)' : '');

      // Write to inbox for terminal to process
      const filename = `${Date.now()}-${msg.type}.json`;
      const filepath = path.join(INBOX_DIR, filename);
      fs.writeFileSync(filepath, JSON.stringify(msg, null, 2));
      console.log(`[bridge] Saved to inbox: ${filename}`);

      // Message types that are themselves responses — never ack them (would create a loop)
      const RESPONSE_TYPES = new Set([
        'ack', 'pong', 'error', 'command_result', 'command_error',
        'client_ready', 'connected'
      ]);

      switch (msg.type) {
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', id: msg.id }));
          break;

        case 'page_content':
          console.log(`[bridge] Page content received: ${msg.payload?.url || 'unknown URL'}`);
          // No ack — page_content is a one-way push; client doesn't need a reply
          break;

        default:
          if (!RESPONSE_TYPES.has(msg.type)) {
            ws.send(JSON.stringify({
              type: 'ack',
              id: msg.id,
              payload: { received: true, filename }
            }));
          }
      }
    } catch (err) {
      console.error(`[bridge] Error processing message:`, err.message);
      ws.send(JSON.stringify({ type: 'error', payload: { message: err.message } }));
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[bridge] Client disconnected: ${clientId} (${clients.size} remaining)`);
  });

  ws.on('error', (err) => {
    console.error(`[bridge] WebSocket error:`, err.message);
  });
});

/**
 * Try to deliver a single outbox file to all connected clients.
 * Returns true if delivered to at least one client (file is then archived);
 * false if no clients connected (file stays in outbox for retry).
 */
function tryDeliver(filepath, filename) {
  try {
    if (!fs.existsSync(filepath)) return true; // already gone

    const liveClients = [...clients].filter(c => c.readyState === WebSocket.OPEN);
    if (liveClients.length === 0) {
      // No clients connected — leave file in outbox; we'll retry on next client connect
      return false;
    }

    const content = fs.readFileSync(filepath, 'utf-8');
    console.log(`[bridge] Sending from outbox: ${filename} → ${liveClients.length} client(s)`);

    liveClients.forEach(client => client.send(content));

    // Move to processed
    const processedDir = path.join(OUTBOX_DIR, 'sent');
    if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir);
    fs.renameSync(filepath, path.join(processedDir, filename));
    return true;
  } catch (err) {
    console.error(`[bridge] Error sending outbox message ${filename}:`, err.message);
    return false;
  }
}

/**
 * Flush any pending outbox files. Called when a client connects (so commands
 * queued during a page reload / disconnect get replayed) and on file watch.
 */
function flushOutbox() {
  const pending = fs.readdirSync(OUTBOX_DIR)
    .filter(f => f.endsWith('.json'))
    .sort();
  for (const filename of pending) {
    if (!tryDeliver(path.join(OUTBOX_DIR, filename), filename)) {
      // Stop on first failure (no clients) — preserves order
      break;
    }
  }
}

// Watch outbox for new commands
fs.watch(OUTBOX_DIR, (eventType, filename) => {
  if (eventType !== 'rename' || !filename.endsWith('.json')) return;
  // Small delay to ensure file is fully written
  setTimeout(flushOutbox, 100);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[bridge] Shutting down...');
  wss.close(() => {
    console.log('[bridge] Server closed');
    process.exit(0);
  });
});

console.log('[bridge] Ready. Waiting for connections...');
