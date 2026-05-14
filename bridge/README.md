# Claude Bridge

WebSocket bridge for bidirectional communication between Chrome and this terminal.

## Architecture

```
Chrome Browser  <--WebSocket-->  Bridge Server  <--File System-->  Terminal/Claude
  (extension)       :7681          (server)        inbox/outbox      (cli.js)
```

**Connection path:** Your local machine runs the Chrome extension. SSH tunnel (`ssh -L 7681:localhost:7681 ...`) forwards port 7681 to this server.

## Quick Start

### 1. Install the Chrome Extension

1. Open Chrome → `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `~/workspace/bridge/extension/` folder

### 2. Start SSH Tunnel (on your local machine)

```bash
ssh -L 7681:localhost:7681 analytics_user@44.222.126.129
```

### 3. Start the Bridge Server (on this server)

```bash
node ~/workspace/bridge/cli.js server
```

### 4. Use It

**From browser:**
- `Ctrl+Shift+S` — Send selected text to terminal
- `Ctrl+Shift+P` — Send full page to terminal
- Click extension icon for popup controls

**From terminal:**
```bash
# See incoming messages
node ~/workspace/bridge/cli.js inbox --watch

# Send commands to browser
node ~/workspace/bridge/cli.js navigate "https://example.com"
node ~/workspace/bridge/cli.js click "#submit-button"
node ~/workspace/bridge/cli.js notify "Processing complete!"
```

## Message Protocol

All messages are JSON:
```json
{
  "type": "message_type",
  "payload": { ... },
  "id": "msg-123456"
}
```

### Built-in Message Types

| Type | Direction | Description |
|------|-----------|-------------|
| `page_content` | Extension → Terminal | Full page HTML/text |
| `selection` | Extension → Terminal | Selected text |
| `data` | Extension → Terminal | Arbitrary data |
| `navigate` | Terminal → Extension | Navigate to URL |
| `scrape` | Terminal → Extension | Request element content |
| `click` | Terminal → Extension | Click an element |
| `notify` | Terminal → Extension | Show notification |

## File Structure

```
bridge/
├── server.js         # WebSocket server (run this)
├── send.js           # CLI to send messages to extension
├── read-inbox.js     # CLI to read messages from extension
├── client-example.js # Copy this into your Chrome extension
├── inbox/            # Messages FROM extension
│   └── processed/    # Archived messages
└── outbox/           # Messages TO extension
    └── sent/         # Sent messages
```

## Example Workflows

### Scrape a table from a webpage
1. Extension sends `page_content` with full HTML
2. Terminal parses the HTML, extracts table
3. Terminal processes data, loads to database
4. Terminal sends `notify` with result

### Click through a form
1. Terminal sends `navigate` to form URL
2. Terminal sends `click` for each button
3. Extension sends confirmation after each action
4. Terminal sends `scrape` for result page
