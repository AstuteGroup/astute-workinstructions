/**
 * Claude Bridge Client - Example for Chrome Extension
 *
 * This code would go in your Chrome extension's background script or content script.
 * Copy and adapt as needed.
 */

class ClaudeBridge {
  constructor(serverUrl = 'ws://localhost:7681') {
    this.serverUrl = serverUrl;
    this.ws = null;
    this.connected = false;
    this.messageHandlers = new Map();
    this.pendingRequests = new Map();
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
  }

  connect() {
    console.log('[bridge] Connecting to', this.serverUrl);

    this.ws = new WebSocket(this.serverUrl);

    this.ws.onopen = () => {
      console.log('[bridge] Connected');
      this.connected = true;
      this.reconnectDelay = 1000; // Reset on successful connection
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        console.log('[bridge] Received:', msg.type);

        // Check for pending request response
        if (msg.id && this.pendingRequests.has(msg.id)) {
          const { resolve } = this.pendingRequests.get(msg.id);
          this.pendingRequests.delete(msg.id);
          resolve(msg);
          return;
        }

        // Call registered handlers
        if (this.messageHandlers.has(msg.type)) {
          this.messageHandlers.get(msg.type).forEach(handler => handler(msg));
        }

        // Call wildcard handlers
        if (this.messageHandlers.has('*')) {
          this.messageHandlers.get('*').forEach(handler => handler(msg));
        }
      } catch (err) {
        console.error('[bridge] Error parsing message:', err);
      }
    };

    this.ws.onclose = () => {
      console.log('[bridge] Disconnected');
      this.connected = false;
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('[bridge] WebSocket error:', err);
    };
  }

  scheduleReconnect() {
    console.log(`[bridge] Reconnecting in ${this.reconnectDelay / 1000}s...`);
    setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      this.connect();
    }, this.reconnectDelay);
  }

  /**
   * Send a message to the terminal
   */
  send(type, payload = {}) {
    if (!this.connected) {
      console.warn('[bridge] Not connected, message queued');
      return;
    }

    const msg = { type, payload, id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}` };
    this.ws.send(JSON.stringify(msg));
    return msg.id;
  }

  /**
   * Send a message and wait for response
   */
  request(type, payload = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = this.send(type, payload);

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }, timeout);

      this.pendingRequests.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
  }

  /**
   * Register a handler for a message type
   */
  on(type, handler) {
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, []);
    }
    this.messageHandlers.get(type).push(handler);
  }

  /**
   * Send current page content to terminal
   */
  sendPageContent() {
    const content = {
      url: window.location.href,
      title: document.title,
      html: document.documentElement.outerHTML,
      text: document.body.innerText,
      timestamp: new Date().toISOString()
    };
    return this.send('page_content', content);
  }

  /**
   * Send selected text to terminal
   */
  sendSelection() {
    const selection = window.getSelection().toString();
    if (!selection) {
      console.warn('[bridge] No text selected');
      return;
    }
    return this.send('selection', {
      text: selection,
      url: window.location.href,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Send arbitrary data to terminal
   */
  sendData(data, label = 'data') {
    return this.send('data', {
      label,
      data,
      url: window.location.href,
      timestamp: new Date().toISOString()
    });
  }
}

// ============================================================
// Example Usage (in Chrome extension)
// ============================================================

/*
// In background.js or content.js:

const bridge = new ClaudeBridge('ws://localhost:7681');
bridge.connect();

// Listen for commands from terminal
bridge.on('navigate', (msg) => {
  window.location.href = msg.payload.url;
});

bridge.on('scrape', (msg) => {
  // Scrape requested data and send back
  const data = document.querySelector(msg.payload.selector)?.innerText;
  bridge.send('scrape_result', { data, selector: msg.payload.selector });
});

bridge.on('click', (msg) => {
  document.querySelector(msg.payload.selector)?.click();
});

// Send page content when extension button is clicked
chrome.action.onClicked.addListener((tab) => {
  bridge.sendPageContent();
});

// Or bind to keyboard shortcut, context menu, etc.
*/

// Export for use
if (typeof module !== 'undefined') {
  module.exports = { ClaudeBridge };
}
