/**
 * Bridge Client — Promise-based wrapper over the file-based inbox/outbox protocol.
 *
 * Lets cogs/adapters call browser commands like normal async functions:
 *
 *   const { send, navigate, getPage, realClick, realType, realKey } = require('./bridge-client');
 *   await navigate('https://...');
 *   const page = await getPage();
 *   await realClick('atomic-search-box');
 *
 * Each call writes to outbox/, then polls inbox/ for the matching command_result.
 * Times out at 15s by default.
 */

const fs = require('fs');
const path = require('path');

const BRIDGE_DIR = path.join(__dirname, '..');
const OUTBOX_DIR = path.join(BRIDGE_DIR, 'outbox');
const INBOX_DIR = path.join(BRIDGE_DIR, 'inbox');

[OUTBOX_DIR, INBOX_DIR].forEach(d => fs.existsSync(d) || fs.mkdirSync(d, { recursive: true }));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Send a command and wait for its command_result in the inbox.
 * Correlates by id.
 */
async function send(type, payload = {}, opts = {}) {
  const timeout = opts.timeout || 15000;
  const id = `cog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const msg = { type, payload, id };

  // Snapshot inbox state BEFORE writing (so we don't match old results)
  const beforeFiles = new Set(
    fs.readdirSync(INBOX_DIR).filter(f => f.endsWith('.json'))
  );

  // Write to outbox
  fs.writeFileSync(
    path.join(OUTBOX_DIR, `${Date.now()}-${type}.json`),
    JSON.stringify(msg, null, 2)
  );

  // Poll inbox for matching result
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const newFiles = fs.readdirSync(INBOX_DIR)
      .filter(f => f.endsWith('.json') && !beforeFiles.has(f));

    for (const fname of newFiles) {
      try {
        const result = JSON.parse(fs.readFileSync(path.join(INBOX_DIR, fname), 'utf-8'));
        if (result.type === 'command_result' && result.payload?.commandId === id) {
          return result.payload.result;
        }
        if (result.type === 'command_error' && result.payload?.commandId === id) {
          throw new Error(result.payload.error || 'Bridge command failed');
        }
      } catch (e) {
        if (e.message.startsWith('Bridge command failed')) throw e;
        // Otherwise file might be mid-write; skip
      }
    }

    await sleep(100);
  }

  throw new Error(`Bridge command timeout: ${type} (${timeout}ms)`);
}

// === Convenience wrappers ===

const navigate = (url) => send('navigate', { url });
const getPage = (timeout = 8000) => send('get_page', {}, { timeout });
const click = (selector) => send('click', { selector });
const fill = (selector, value) => send('fill', { selector, value });
const scrape = (selector, opts = {}) => send('scrape', { selector, ...opts });
const realClick = (selector) => send('real_click', { selector });
const realType = (text) => send('real_type', { text });
const realFill = (selector, value, options = {}) => send('real_fill', { selector, value, options });
const realKey = (key) => send('real_key', { key });
const evalJs = (expression) => send('eval', { expression });
const stageFile = (filename, base64) => send('stage_file', { filename, base64 }, { timeout: 30000 });
const uploadFile = (selector, paths) => send('upload_file', { selector, paths });
const notify = (message, type = 'info') => send('notify', { message, type });

/**
 * Wait for a navigation to settle by waiting for the URL to change away from a known one.
 * Useful after submit/click that triggers a full page load.
 */
async function waitForNavigation(awayFromUrl, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const page = await getPage(3000);
      if (page?.url && page.url !== awayFromUrl) return page;
    } catch (e) { /* keep waiting */ }
  }
  throw new Error(`Navigation timeout: still at ${awayFromUrl}`);
}

module.exports = {
  send,
  navigate, getPage, click, fill, scrape,
  realClick, realType, realFill, realKey,
  evalJs, stageFile, uploadFile, notify,
  waitForNavigation,
  sleep,
};
