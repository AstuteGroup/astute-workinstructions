/**
 * Claude Bridge - Background Service Worker
 *
 * Holds debugger sessions per-tab and exposes Chrome DevTools Protocol commands
 * to the content script. CDP commands fire real keyboard/mouse events that
 * Chrome treats as trusted user input — bypasses autofill protection,
 * file-input restrictions, and form-validation guards that synthetic events trigger.
 *
 * Architecture:
 *   content.js  --(chrome.runtime.sendMessage)-->  background.js  --(chrome.debugger.sendCommand)-->  CDP
 *                                                       │
 *                                                       └─ attaches debugger to active tab on demand
 */

// Track which tabs we've attached the debugger to
const attachedTabs = new Set();

const DEBUGGER_VERSION = '1.3';

/**
 * Attach debugger to a tab if not already attached
 */
async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;

  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, DEBUGGER_VERSION, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        attachedTabs.add(tabId);
        resolve();
      }
    });
  });

  // Enable required CDP domains
  await sendCommand(tabId, 'DOM.enable', {});
  await sendCommand(tabId, 'Page.enable', {});
  await sendCommand(tabId, 'Runtime.enable', {});
}

/**
 * Send a CDP command and return the result
 */
function sendCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

/**
 * Type real text into the focused element using CDP keyboard events.
 * Each character fires keyDown + char + keyUp — Chrome treats this as trusted input,
 * which unlocks autofilled password reads and triggers React/Vue input handlers.
 */
async function realType(tabId, text) {
  for (const char of text) {
    await sendCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: char,
      unmodifiedText: char,
    });
    await sendCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      text: char,
      unmodifiedText: char,
    });
  }
}

/**
 * Press a single key (e.g., 'Tab', 'Enter', 'Backspace')
 */
async function realKey(tabId, key) {
  const keyCodes = {
    'Tab': { windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab' },
    'Enter': { windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' },
    'Backspace': { windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' },
    'Escape': { windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' },
    'ArrowDown': { windowsVirtualKeyCode: 40, code: 'ArrowDown', key: 'ArrowDown' },
    'ArrowUp': { windowsVirtualKeyCode: 38, code: 'ArrowUp', key: 'ArrowUp' },
  };
  const k = keyCodes[key];
  if (!k) throw new Error(`Unknown key: ${key}`);

  await sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...k });
  await sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...k });
}

/**
 * Click an element via CDP — fires real mouse events at element coordinates.
 * More reliable than el.click() for sites that check isTrusted.
 */
async function realClick(tabId, selector) {
  // Get element box via CDP
  const { root } = await sendCommand(tabId, 'DOM.getDocument', { depth: 0 });
  const { nodeId } = await sendCommand(tabId, 'DOM.querySelector', {
    nodeId: root.nodeId,
    selector,
  });
  if (!nodeId) throw new Error(`Element not found: ${selector}`);

  const { model } = await sendCommand(tabId, 'DOM.getBoxModel', { nodeId });
  if (!model) throw new Error(`No box model for: ${selector}`);

  // Center of the content box
  const [x1, y1, x2, , , y3] = model.content;
  const x = (x1 + x2) / 2;
  const y = (y1 + y3) / 2;

  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1,
  });
  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
  });
  return { clicked: selector, x, y };
}

/**
 * Focus an element by selector (so realType targets it)
 */
async function focusElement(tabId, selector) {
  await sendCommand(tabId, 'Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})?.focus()`,
  });
}

/**
 * Real fill: focus the element, then type every character via CDP.
 * Triggers React/Vue/Angular input handlers correctly.
 */
async function realFill(tabId, selector, value, options = {}) {
  await focusElement(tabId, selector);

  if (options.clear !== false) {
    // Select all + delete
    await sendCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown', windowsVirtualKeyCode: 65, code: 'KeyA', key: 'a', modifiers: 2, // Ctrl
    });
    await sendCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', windowsVirtualKeyCode: 65, code: 'KeyA', key: 'a', modifiers: 2,
    });
    await realKey(tabId, 'Backspace');
  }

  await realType(tabId, value);
  return { filled: selector, length: value.length };
}

/**
 * Attach a file to a file input via CDP.
 * Files must exist on the local Chrome machine — paths are absolute paths
 * on the user's laptop. Use the "stage_file" command to download a file
 * to the local downloads folder first.
 */
async function uploadFile(tabId, selector, filePaths) {
  const { root } = await sendCommand(tabId, 'DOM.getDocument', { depth: 0 });
  const { nodeId } = await sendCommand(tabId, 'DOM.querySelector', {
    nodeId: root.nodeId,
    selector,
  });
  if (!nodeId) throw new Error(`File input not found: ${selector}`);

  await sendCommand(tabId, 'DOM.setFileInputFiles', {
    nodeId,
    files: Array.isArray(filePaths) ? filePaths : [filePaths],
  });
  return { uploaded: filePaths };
}

/**
 * Stage a file to the user's local downloads folder.
 * Takes base64 content, writes via chrome.downloads, returns the local path
 * so it can be passed to uploadFile.
 */
async function stageFile(filename, base64Content) {
  // Convert base64 to a data: URL (chrome.downloads accepts these)
  const dataUrl = `data:application/octet-stream;base64,${base64Content}`;

  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: dataUrl,
      filename,
      conflictAction: 'overwrite',
      saveAs: false,
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      // Wait for download completion to get the absolute path
      const listener = (delta) => {
        if (delta.id === downloadId && delta.state?.current === 'complete') {
          chrome.downloads.onChanged.removeListener(listener);
          chrome.downloads.search({ id: downloadId }, (items) => {
            resolve({ downloadId, path: items[0]?.filename });
          });
        }
      };
      chrome.downloads.onChanged.addListener(listener);
    });
  });
}

/**
 * Evaluate arbitrary JS in the page (including shadow DOM access).
 * Use sparingly — bypasses content script sandboxing.
 */
async function evalJs(tabId, expression) {
  const result = await sendCommand(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Eval failed');
  }
  return result.result?.value;
}

// ============================================================
// Message router — content.js sends commands here
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (!tabId) {
    sendResponse({ error: 'No tab ID' });
    return false;
  }

  (async () => {
    try {
      await ensureAttached(tabId);
      let result;

      switch (msg.type) {
        case 'real_type':
          await focusElement(tabId, msg.selector);
          await realType(tabId, msg.text);
          result = { typed: msg.text.length + ' chars' };
          break;

        case 'real_fill':
          result = await realFill(tabId, msg.selector, msg.value, msg.options);
          break;

        case 'real_key':
          await realKey(tabId, msg.key);
          result = { pressed: msg.key };
          break;

        case 'real_click':
          result = await realClick(tabId, msg.selector);
          break;

        case 'upload_file':
          result = await uploadFile(tabId, msg.selector, msg.paths);
          break;

        case 'stage_file':
          result = await stageFile(msg.filename, msg.base64);
          break;

        case 'eval':
          result = await evalJs(tabId, msg.expression);
          break;

        case 'detach':
          if (attachedTabs.has(tabId)) {
            chrome.debugger.detach({ tabId });
            attachedTabs.delete(tabId);
          }
          result = { detached: true };
          break;

        default:
          result = { error: `Unknown background command: ${msg.type}` };
      }

      sendResponse({ ok: true, result });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // async response
});

// Detach debugger when tab closes
chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
});

// Detach if user closes the debug bar manually
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});

console.log('[claude-bridge:bg] Service worker ready');
