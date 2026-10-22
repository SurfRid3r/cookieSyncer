# Cookie Sync

[中文文档](docs/zh-cn.md)

Read browser cookies from the command line through a Chrome extension. Each command starts a temporary local listener, fetches once, and exits without saving cookies or leaving a background service.

## Quick start

You need Chrome and Python 3.11 or later. Install the Python dependency:

```bash
python3 -m pip install websockets==17.2
```

1. Open `chrome://extensions/` and enable **Developer mode**.
2. Click **Load unpacked** and select `cookie-sync-extension/`.
3. Open the extension popup, add your target domain, and enable **本地ON** (local access).

Run these commands from the repository root:

```bash
# Match cookies for a specific URL, including its protocol and path
python3 skills/cookie-sync/scripts/cookie_sync_daemon.py --url 'https://api.example.com/private/me'

# Query a domain
python3 skills/cookie-sync/scripts/cookie_sync_daemon.py example.com
```

Output is one JSONL record: `{"cookie_header":"sid=value; token=value"}`. Extract the ready-to-use Cookie Header with jq and pass it to curl:

```bash
set -o pipefail
COOKIE=$(python3 skills/cookie-sync/scripts/cookie_sync_daemon.py --url 'https://api.example.com/me' | jq -er '.cookie_header') || exit $?
curl -H "Cookie: $COOKIE" 'https://api.example.com/me'
unset COOKIE
```

Check the command's exit status before using the result; retrieving cookies does not guarantee that the target service accepts them.

For an AI agent, copy `skills/cookie-sync/` to its Skill directory. Keep the script and extension updated together.

## Domain access

Each domain has two controls:

- **本地ON/OFF**: allow local cookie retrieval.
- **云端ON/OFF**: include cookies in cloud sync.

The most specific domain setting wins; unconfigured subdomains inherit their parent's setting. When you have a full URL, use `--url`: it returns cookies matching that URL, including matching parent-domain cookies. Domain queries filter cookies by their owning domains' local settings.

## Troubleshooting

Errors are reported as JSONL on stderr, with empty stdout. Use `--help` for plain-text options or `-v` for JSONL connection progress on stderr.

| Error | Action |
| --- | --- |
| `DOMAIN_NOT_ALLOWED` | Enable **本地ON** for the target domain. |
| `COOKIE_EMPTY` | Check the requested URL or domain; no cookies matched. |
| `EXTENSION_UNAVAILABLE` | Open Chrome and enable the extension. Cold connections may take a while. |
| `LOCAL_UNAVAILABLE` | Run one retrieval at a time; local port 38247 may already be in use. |
| `PROTOCOL_MISMATCH` | Update the script and extension together. |

The total timeout defaults to 85 seconds. Override it with `--timeout <seconds>` (greater than 0, at most 300). Cookies are not printed in diagnostics; avoid saving their values in logs.

## Optional cloud sync

Sync encrypted cookies across devices using GitHub Gist or WebDAV:

1. Open the extension's **☁️ Cloud Sync** tab and configure an encryption key.
2. Choose a storage backend:
   - **GitHub Gist**: enter a [personal access token](https://github.com/settings/tokens) with the `gist` scope. Leave Gist ID empty to create one on first push.
   - **WebDAV**: enter the server URL, credentials, and file path.
3. Save the configuration, enable the domains you want to sync, and choose push, pull, or bidirectional sync. Scheduled sync is optional.

On another device, **import the same encryption key**. For Gist, use the same Token and Gist ID shown after the first push; for WebDAV, use the same server and file path. Newly discovered domains appear as pending for review.

Cloud data uses AES-256-GCM encryption. The encryption key stays in local extension storage; export it from key management and keep it somewhere safe for your other devices.
