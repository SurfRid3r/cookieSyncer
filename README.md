# Cookie Sync

[中文文档](docs/zh-cn.md)

Retrieve browser cookies from the command line via a Chrome extension + local daemon.

## Architecture

```
Chrome Extension  ←──WebSocket (localhost:38247)──→  cookie_sync_daemon.py
   │                                                     │
   ├─ Domain management (local + cloud)                   ├─ CLI output
   ├─ Cookie capture & filtering                          └─ Cookie Header
   ├─ Cloud sync (Gist/WebDAV + AES-256-GCM)
   └─ Popup UI
```

## Quick Start

### 1. Install Chrome Extension

1. Open `chrome://extensions/` and enable Developer Mode
2. Click "Load unpacked" and select the `cookie-sync-extension/` directory
3. Click the extension icon and add target domains (each domain can independently control local daemon access and cloud sync)

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
│   │   ├── whitelist.js      # Unified domain management (localAccess + cloudSync)
│   │   └── cloud/            # Cloud sync modules
│   │       ├── sync-engine.js  # Sync orchestration
│   │       ├── crypto.js       # AES-256-GCM encryption
│   │       ├── config.js       # Configuration management
│   │       ├── storage-adapter.js  # Storage interface
│   │       ├── gist-adapter.js     # GitHub Gist backend
│   │       ├── webdav-adapter.js   # WebDAV backend
│   │       ├── data-collector.js   # Cookie + localStorage collector
│   │       └── conflict.js        # Conflict resolution
│   ├── popup/                # Popup UI
│   │   ├── popup.html        # Tab-based layout
│   │   ├── popup.js          # Tab routing + domain management
│   │   ├── cloud-tab.js      # Cloud sync tab
│   │   └── cloud-tab.css     # Cloud sync styles
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

## Cloud Sync

Encrypted cross-device cookie sync via GitHub Gist or WebDAV.

### Setup

1. Open the extension popup and switch to the **☁️ Cloud Sync** tab
2. Configure encryption key (auto-generate recommended)
3. Choose storage backend and configure:
   - **GitHub Gist**: Enter a GitHub Token (see below)
   - **WebDAV**: Enter server URL, username, and password
4. Click **Save** to activate

### Multi-device Sync

After first push on device A, the status card shows the **Gist ID**. On device B, enter the same Token + that Gist ID to sync to the same data.

### Domain Management

Each domain has two independent controls:
- **Local Access** (本地ON/OFF): Whether the local daemon can retrieve cookies for this domain
- **Cloud Sync** (云端ON/OFF): Whether this domain's cookies participate in cloud sync

When pulling from cloud, newly discovered domains appear as "Pending" and require user confirmation before syncing.

### GitHub Token Permissions

When creating a Personal Access Token (classic) at https://github.com/settings/tokens, only one scope is required:

| Scope | Required | Purpose |
|-------|----------|---------|
| `gist` | **Yes** | Create, read, and update gists |

No other scopes are needed. The token only needs gist access — it does not need access to your repos, issues, or any other GitHub resources.

## Dependencies

- Chrome browser
- Python 3 + `websockets` (`pip install websockets`)

## Security

- Only reads/writes cookies for domains with respective access enabled
- WebSocket listens on localhost only
- Browser permission granted at install (`<all_urls>`), actual access controlled by per-domain settings
- Cloud sync uses AES-256-GCM encryption with random IV per upload
- Encryption key stored locally only (chrome.storage.local, not synced by Chrome)
- GitHub Token only needs `gist` scope, no repo access required
