/**
 * Browser Automation Workflow
 *
 * Send commands to the Chrome extension to interact with web pages.
 * Commands are queued in the outbox and sent to connected clients.
 */

const fs = require('fs');
const path = require('path');

const OUTBOX_DIR = path.join(__dirname, '../outbox');

// Ensure outbox exists
if (!fs.existsSync(OUTBOX_DIR)) {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
}

/**
 * Queue a command for the extension
 */
function queueCommand(type, payload) {
  const msg = {
    type,
    payload,
    id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  };

  const filename = `${Date.now()}-${type}.json`;
  fs.writeFileSync(path.join(OUTBOX_DIR, filename), JSON.stringify(msg, null, 2));

  console.log(`[automation] Queued: ${type}`);
  return msg.id;
}

/**
 * Navigate to a URL
 */
function navigate(url) {
  return queueCommand('navigate', { url });
}

/**
 * Click an element by selector
 */
function click(selector, options = {}) {
  return queueCommand('click', {
    selector,
    waitFor: options.waitFor || null,  // Optional selector to wait for after click
    delay: options.delay || 0           // Delay before clicking (ms)
  });
}

/**
 * Fill a form field
 */
function fill(selector, value, options = {}) {
  return queueCommand('fill', {
    selector,
    value,
    clear: options.clear !== false,  // Clear field first (default true)
    trigger: options.trigger || 'change'  // Event to trigger: 'change', 'input', 'blur'
  });
}

/**
 * Select an option from a dropdown
 */
function select(selector, value) {
  return queueCommand('select', { selector, value });
}

/**
 * Wait for an element to appear
 */
function waitFor(selector, options = {}) {
  return queueCommand('wait_for', {
    selector,
    timeout: options.timeout || 10000,
    visible: options.visible !== false
  });
}

/**
 * Scrape content by selector
 */
function scrape(selector, options = {}) {
  return queueCommand('scrape', {
    selector,
    attribute: options.attribute || null,  // Specific attribute, or null for text
    all: options.all || false              // Get all matching elements
  });
}

/**
 * Take a screenshot
 */
function screenshot(options = {}) {
  return queueCommand('screenshot', {
    selector: options.selector || null,  // Specific element, or null for full page
    format: options.format || 'png'
  });
}

/**
 * Execute a sequence of commands
 */
function sequence(commands) {
  return queueCommand('sequence', {
    commands,
    stopOnError: true
  });
}

/**
 * Request current page content
 */
function getPage() {
  return queueCommand('get_page', {});
}

/**
 * Scroll the page
 */
function scroll(options = {}) {
  return queueCommand('scroll', {
    selector: options.selector || null,  // Element to scroll, or null for page
    direction: options.direction || 'down',
    amount: options.amount || 'page'  // 'page', 'end', or pixel amount
  });
}

/**
 * Press keyboard keys
 */
function keypress(keys) {
  return queueCommand('keypress', { keys });
}

/**
 * Show a notification/alert in the browser
 */
function notify(message, options = {}) {
  return queueCommand('notify', {
    message,
    type: options.type || 'info',  // 'info', 'success', 'warning', 'error'
    duration: options.duration || 3000
  });
}

module.exports = {
  queueCommand,
  navigate,
  click,
  fill,
  select,
  waitFor,
  scrape,
  screenshot,
  sequence,
  getPage,
  scroll,
  keypress,
  notify
};
