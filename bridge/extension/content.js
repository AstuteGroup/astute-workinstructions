/**
 * Claude Bridge - Chrome Extension Content Script
 *
 * Inject this into pages to enable communication with the terminal.
 * Handles automation commands and sends data back.
 */

(function() {
  'use strict';

  const SERVER_URL = 'ws://localhost:7681';
  let ws = null;
  let connected = false;
  let reconnectDelay = 1000;

  // ============================================================
  // WebSocket Connection
  // ============================================================

  function connect() {
    console.log('[claude-bridge] Connecting to', SERVER_URL);

    ws = new WebSocket(SERVER_URL);

    ws.onopen = () => {
      console.log('[claude-bridge] Connected');
      connected = true;
      reconnectDelay = 1000;

      // Announce ourselves
      send('client_ready', {
        url: window.location.href,
        title: document.title
      });
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        console.log('[claude-bridge] Received:', msg.type);
        handleCommand(msg);
      } catch (err) {
        console.error('[claude-bridge] Error parsing message:', err);
      }
    };

    ws.onclose = () => {
      console.log('[claude-bridge] Disconnected');
      connected = false;
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.error('[claude-bridge] WebSocket error');
    };
  }

  function scheduleReconnect() {
    console.log(`[claude-bridge] Reconnecting in ${reconnectDelay / 1000}s...`);
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      connect();
    }, reconnectDelay);
  }

  function send(type, payload = {}) {
    if (!connected) {
      console.warn('[claude-bridge] Not connected');
      return;
    }

    const msg = {
      type,
      payload,
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    };

    ws.send(JSON.stringify(msg));
    return msg.id;
  }

  // ============================================================
  // Command Handlers
  // ============================================================

  // Message types that are server replies, not commands — ignore silently
  const IGNORE_TYPES = new Set(['ack', 'pong', 'error', 'connected']);

  async function handleCommand(msg) {
    const { type, payload, id } = msg;

    // Ignore reply messages — don't try to execute them as commands
    if (IGNORE_TYPES.has(type)) {
      return;
    }

    try {
      let result;

      switch (type) {

        case 'navigate':
          window.location.href = payload.url;
          result = { navigating: payload.url };
          break;

        case 'click':
          result = await handleClick(payload);
          break;

        case 'fill':
          result = await handleFill(payload);
          break;

        case 'select':
          result = await handleSelect(payload);
          break;

        case 'wait_for':
          result = await handleWaitFor(payload);
          break;

        case 'scrape':
          result = handleScrape(payload);
          break;

        case 'get_page':
          result = getPageContent();
          break;

        case 'scroll':
          result = handleScroll(payload);
          break;

        case 'keypress':
          result = handleKeypress(payload);
          break;

        case 'notify':
          result = showNotification(payload);
          break;

        case 'nudge':
          result = handleNudge(payload);
          break;

        // === Privileged commands — forwarded to background.js (chrome.debugger) ===
        case 'real_type':
        case 'real_fill':
        case 'real_key':
        case 'real_click':
        case 'upload_file':
        case 'stage_file':
        case 'eval':
        case 'detach':
          result = await forwardToBackground(type, payload);
          break;

        case 'sequence':
          result = await handleSequence(payload);
          break;

        case 'screenshot':
          // Note: Full screenshot requires extension background script
          result = { error: 'Screenshot requires background script permissions' };
          break;

        default:
          result = { error: `Unknown command: ${type}` };
      }

      if (id && result) {
        send('command_result', { commandId: id, type, result });
      }

    } catch (err) {
      console.error(`[claude-bridge] Error handling ${type}:`, err);
      if (id) {
        send('command_error', { commandId: id, type, error: err.message });
      }
    }
  }

  async function handleClick(payload) {
    const { selector, delay, waitFor } = payload;

    if (delay) {
      await sleep(delay);
    }

    const el = document.querySelector(selector);
    if (!el) {
      return { error: `Element not found: ${selector}` };
    }

    el.click();

    if (waitFor) {
      await waitForElement(waitFor);
    }

    return { clicked: selector };
  }

  async function handleFill(payload) {
    const { selector, value, clear, trigger } = payload;

    const el = document.querySelector(selector);
    if (!el) {
      return { error: `Element not found: ${selector}` };
    }

    if (clear) {
      el.value = '';
    }

    el.value = value;

    // Trigger events
    const events = {
      'input': new Event('input', { bubbles: true }),
      'change': new Event('change', { bubbles: true }),
      'blur': new Event('blur', { bubbles: true })
    };

    if (trigger && events[trigger]) {
      el.dispatchEvent(events[trigger]);
    } else {
      el.dispatchEvent(events.input);
      el.dispatchEvent(events.change);
    }

    return { filled: selector, value };
  }

  async function handleSelect(payload) {
    const { selector, value } = payload;

    const el = document.querySelector(selector);
    if (!el) {
      return { error: `Element not found: ${selector}` };
    }

    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));

    return { selected: selector, value };
  }

  async function handleWaitFor(payload) {
    const { selector, timeout, visible } = payload;

    try {
      await waitForElement(selector, timeout, visible);
      return { found: selector };
    } catch (err) {
      return { error: err.message };
    }
  }

  function handleScrape(payload) {
    const { selector, attribute, all } = payload;

    if (all) {
      const elements = document.querySelectorAll(selector);
      const results = Array.from(elements).map(el => {
        return attribute ? el.getAttribute(attribute) : el.innerText.trim();
      });
      return { selector, count: results.length, results };
    } else {
      const el = document.querySelector(selector);
      if (!el) {
        return { error: `Element not found: ${selector}` };
      }
      const value = attribute ? el.getAttribute(attribute) : el.innerText.trim();
      return { selector, value };
    }
  }

  function getPageContent() {
    return {
      url: window.location.href,
      title: document.title,
      html: document.documentElement.outerHTML,
      text: document.body.innerText
    };
  }

  function handleScroll(payload) {
    const { selector, direction, amount } = payload;

    const target = selector ? document.querySelector(selector) : window;
    if (selector && !target) {
      return { error: `Element not found: ${selector}` };
    }

    let pixels;
    if (amount === 'page') {
      pixels = window.innerHeight;
    } else if (amount === 'end') {
      pixels = document.body.scrollHeight;
    } else {
      pixels = parseInt(amount, 10) || 500;
    }

    if (direction === 'up') pixels = -pixels;

    if (selector) {
      target.scrollBy(0, pixels);
    } else {
      window.scrollBy(0, pixels);
    }

    return { scrolled: direction, amount };
  }

  function handleKeypress(payload) {
    const { keys } = payload;

    const event = new KeyboardEvent('keydown', {
      key: keys,
      bubbles: true
    });
    document.activeElement.dispatchEvent(event);

    return { pressed: keys };
  }

  /**
   * Forward a privileged command to the background service worker.
   * The background page holds the chrome.debugger session and can fire
   * trusted CDP events (real keystrokes, real clicks, file upload, eval).
   */
  function forwardToBackground(type, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
          return;
        }
        if (response?.ok) {
          resolve(response.result);
        } else {
          resolve({ error: response?.error || 'Unknown error' });
        }
      });
    });
  }

  function handleNudge(payload) {
    const { selector } = payload;
    const el = document.querySelector(selector);
    if (!el) return { error: `Element not found: ${selector}` };

    // For React/Vue forms: must use the native value setter to bypass framework guards
    const proto = Object.getPrototypeOf(el);
    const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const currentValue = el.value;

    el.focus();

    // Re-set the same value via native setter — this signals "user input" to React/Vue
    if (valueSetter) {
      valueSetter.call(el, currentValue);
    }

    // Fire the full event sequence a real user would trigger
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));

    return { nudged: selector, length: currentValue.length };
  }

  function showNotification(payload) {
    const { message, type, duration } = payload;

    // Create notification element
    const notif = document.createElement('div');
    notif.textContent = message;
    notif.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 12px 20px;
      border-radius: 4px;
      color: white;
      font-family: system-ui, sans-serif;
      font-size: 14px;
      z-index: 999999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      transition: opacity 0.3s;
    `;

    const colors = {
      info: '#2196F3',
      success: '#4CAF50',
      warning: '#FF9800',
      error: '#F44336'
    };
    notif.style.backgroundColor = colors[type] || colors.info;

    document.body.appendChild(notif);

    setTimeout(() => {
      notif.style.opacity = '0';
      setTimeout(() => notif.remove(), 300);
    }, duration || 3000);

    return { notified: message };
  }

  async function handleSequence(payload) {
    const { commands, stopOnError } = payload;
    const results = [];

    for (const cmd of commands) {
      try {
        const result = await handleCommand({ type: cmd.type, payload: cmd.payload });
        results.push({ type: cmd.type, result });

        if (cmd.delay) {
          await sleep(cmd.delay);
        }
      } catch (err) {
        results.push({ type: cmd.type, error: err.message });
        if (stopOnError) break;
      }
    }

    return { sequence: results };
  }

  // ============================================================
  // Utilities
  // ============================================================

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function waitForElement(selector, timeout = 10000, visible = true) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const check = () => {
        const el = document.querySelector(selector);
        if (el && (!visible || el.offsetParent !== null)) {
          resolve(el);
          return;
        }

        if (Date.now() - startTime > timeout) {
          reject(new Error(`Timeout waiting for: ${selector}`));
          return;
        }

        requestAnimationFrame(check);
      };

      check();
    });
  }

  // ============================================================
  // User Actions (triggered by user, not automation)
  // ============================================================

  // Send selection when user presses Ctrl+Shift+S
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'S') {
      e.preventDefault();
      const selection = window.getSelection().toString();
      if (selection) {
        send('selection', {
          text: selection,
          url: window.location.href,
          title: document.title
        });
        showNotification({ message: 'Selection sent to Claude', type: 'success', duration: 2000 });
      }
    }
  });

  // Send full page when user presses Ctrl+Shift+P
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'P') {
      e.preventDefault();
      send('page_content', getPageContent());
      showNotification({ message: 'Page sent to Claude', type: 'success', duration: 2000 });
    }
  });

  // ============================================================
  // Initialize
  // ============================================================

  connect();
  console.log('[claude-bridge] Content script loaded');
  console.log('[claude-bridge] Shortcuts: Ctrl+Shift+S (send selection), Ctrl+Shift+P (send page)');

})();
