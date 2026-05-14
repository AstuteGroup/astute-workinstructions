// Claude Bridge Popup Script

const SERVER_URL = 'ws://localhost:7681';

// Check connection status
function checkConnection() {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');

  const ws = new WebSocket(SERVER_URL);

  ws.onopen = () => {
    dot.className = 'dot connected';
    text.textContent = 'Connected to terminal';
    ws.close();
  };

  ws.onerror = () => {
    dot.className = 'dot disconnected';
    text.textContent = 'Not connected';
  };
}

// Execute script in active tab
async function executeInTab(code) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: new Function(code)
  });
}

// Send page content
document.getElementById('sendPage').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      // Trigger the Ctrl+Shift+P shortcut handler
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'P',
        ctrlKey: true,
        shiftKey: true
      }));
    }
  });

  window.close();
});

// Send selection
document.getElementById('sendSelection').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      // Trigger the Ctrl+Shift+S shortcut handler
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'S',
        ctrlKey: true,
        shiftKey: true
      }));
    }
  });

  window.close();
});

// Check connection on popup open
checkConnection();
