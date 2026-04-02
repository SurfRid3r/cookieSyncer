# Cookie Sync

[中文文档](docs/zh-cn.md)

Retrieve browser cookies from the command line via a Chrome extension + local daemon.

## Architecture

```
Chrome Extension  ←──WebSocket (localhost:19825)──→  cookie_sync_daemon.py
   │                                                     │
   ├─ Domain whitelist management                         ├─ CLI output
   ├─ Capture cookies                                     └─ Cookie Header
   └─ Popup UI
```

## Quick Start

### 1. Install Chrome Extension

1. Open `chrome://extensions/` and enable Developer Mode
2. Click "Load unpacked" and select the `cookie-sync-extension/` directory
3. Click the extension icon and add target domains to the whitelist

### 2. Use with Claude Code

```bash
# Cookie Header format (for curl)
python skills/cookie-sync/scripts/cookie_sync_daemon.py example.com

# List whitelisted domains
python skills/cookie-sync/scripts/cookie_sync_daemon.py --list
```

### 3. Use with curl

```bash
curl -H "Cookie: $(python skills/cookie-sync/scripts/cookie_sync_daemon.py example.com)" \
  https://api.example.com/me
```

## Directory Structure

```
├── cookie-sync-extension/   # Chrome Extension (Manifest V3)
│   ├── background/           # Service Worker
│   │   ├── main.js           # Entry point
│   │   ├── connection.js     # WebSocket connection
│   │   ├── cookie-ops.js     # Cookie operations
│   │   ├── domain-utils.js   # Domain utilities
│   │   └── whitelist.js      # Whitelist management
│   ├── popup/                # Popup UI
│   ├── icons/                # Extension icons
│   └── manifest.json
│
└── skills/cookie-sync/       # Claude Code Skill
    ├── SKILL.md              # Skill definition
    ├── agents/
    │   └── openai.yaml       # Agent config
    └── scripts/
        └── cookie_sync_daemon.py  # Daemon script
```

## Dependencies

- Chrome browser
- Python 3 + `websockets` (`pip install websockets`)

## Security

- Only reads cookies for whitelisted domains
- WebSocket listens on localhost only
- Extension requires manual host permission grants
