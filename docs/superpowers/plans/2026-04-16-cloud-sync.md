# Cloud Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add encrypted cloud sync (Gist + WebDAV) to cookie-sync-extension, enabling cross-device cookie and localStorage synchronization.

**Architecture:** Modular Service Worker with new `background/cloud/` directory containing independent modules for encryption, storage backends, data collection, conflict resolution, and sync orchestration. UI uses tab-based navigation in the existing popup.

**Tech Stack:** Chrome Extension Manifest V3, Web Crypto API (AES-256-GCM), GitHub Gist API, WebDAV protocol, chrome.scripting API for localStorage.

**Design spec:** `docs/superpowers/specs/2026-04-16-cloud-sync-design.md`

**Important note:** WebDAV URLs need dynamic host permission. When user configures a WebDAV backend, the cloud-tab.js setup flow must call `chrome.permissions.request({ origins: [webdavOrigin + "/*"] })` to grant the service worker access to the WebDAV server. This is handled in the "保存配置" button handler in Task 11.

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `background/cloud/crypto.js` | AES-256-GCM encryption, key generation/import/export |
| `background/cloud/storage-adapter.js` | Abstract base class for storage backends |
| `background/cloud/gist-adapter.js` | GitHub Gist storage implementation |
| `background/cloud/webdav-adapter.js` | WebDAV storage implementation |
| `background/cloud/data-collector.js` | Collect cookies + localStorage by whitelist |
| `background/cloud/conflict.js` | Timestamp-based conflict resolution |
| `background/cloud/sync-engine.js` | Orchestrate push/pull/bidirectional sync |
| `background/cloud/config.js` | Cloud sync configuration management |
| `popup/cloud-tab.js` | Cloud sync tab UI logic |
| `popup/cloud-tab.css` | Cloud sync tab styles |

### Modified files
| File | Changes |
|------|---------|
| `manifest.json` | Add `scripting` permission, add `https://api.github.com/*` host permission |
| `background/main.js` | Import cloud module, register cloud message handlers, add cloud sync alarm |
| `popup/popup.html` | Add tab bar structure, cloud sync tab container, include cloud-tab.css |
| `popup/popup.js` | Add tab switching logic |

---

## Task 1: Project Setup — manifest.json and Directory Structure

**Files:**
- Modify: `manifest.json`
- Create: `background/cloud/` directory

- [ ] **Step 1: Update manifest.json**

Add `scripting` permission (for localStorage access via content scripts) and GitHub API host permission:

```json
{
  "manifest_version": 3,
  "name": "Cookie Sync",
  "version": "1.0.0",
  "description": "Syncs browser cookies with a local daemon over WebSocket. User-controlled domain whitelist for security.",
  "permissions": [
    "cookies",
    "storage",
    "alarms",
    "scripting"
  ],
  "optional_host_permissions": [
    "http://*/*",
    "https://*/*"
  ],
  "host_permissions": [
    "http://localhost:19825/*",
    "http://127.0.0.1:19825/*",
    "https://api.github.com/*"
  ],
  "background": {
    "service_worker": "background/main.js",
    "type": "module"
  },
  "action": {
    "default_title": "Cookie Sync",
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png"
    }
  },
  "icons": {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  }
}
```

- [ ] **Step 2: Create cloud module directory**

Run: `mkdir -p cookie-sync-extension/background/cloud`

- [ ] **Step 3: Verify**

Load extension in `chrome://extensions` → Developer mode → Load unpacked → select `cookie-sync-extension/`. Confirm no errors.

- [ ] **Step 4: Commit**

```bash
git add cookie-sync-extension/manifest.json
git commit -m "feat: add scripting permission and github api host for cloud sync"
```

---

## Task 2: Config Module — Cloud Sync Configuration Management

**Files:**
- Create: `background/cloud/config.js`

This module manages all cloud sync configuration stored in `chrome.storage.local`. Other modules depend on it for settings.

- [ ] **Step 1: Implement config.js**

```javascript
// background/cloud/config.js — Cloud sync configuration management

const STORAGE_KEY = "cloudSync";

const DEFAULTS = {
  enabled: false,
  mode: "push-only",
  scheduleEnabled: false,
  scheduleIntervalMinutes: 30,
  storageType: null,
  storageConfig: {
    gist: { token: "", gistId: "" },
    webdav: { url: "", username: "", password: "", filePath: "/cookie-sync/cookies.enc" },
  },
  keyConfig: {
    type: null,
    exportedKey: null,
  },
  lastSyncTime: null,
  lastSyncStatus: null,
  lastSyncError: null,
  syncLog: [],
};

let cached = null;

export async function init() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  cached = { ...DEFAULTS, ...(result[STORAGE_KEY] || {}) };
  cached.storageConfig = { ...DEFAULTS.storageConfig, ...(cached.storageConfig || {}) };
  cached.storageConfig.gist = { ...DEFAULTS.storageConfig.gist, ...(cached.storageConfig.gist || {}) };
  cached.storageConfig.webdav = { ...DEFAULTS.storageConfig.webdav, ...(cached.storageConfig.webdav || {}) };
  cached.keyConfig = { ...DEFAULTS.keyConfig, ...(cached.keyConfig || {}) };
}

export function get() {
  return cached || { ...DEFAULTS };
}

export function getKeyConfig() {
  return cached?.keyConfig || DEFAULTS.keyConfig;
}

export function getStorageConfig() {
  const type = cached?.storageType;
  if (type === "gist") return cached.storageConfig.gist;
  if (type === "webdav") return cached.storageConfig.webdav;
  return null;
}

export function isConfigured() {
  if (!cached?.keyConfig?.exportedKey) return false;
  if (!cached?.storageType) return false;
  if (cached.storageType === "gist") {
    return !!(cached.storageConfig.gist?.token);
  }
  if (cached.storageType === "webdav") {
    return !!(cached.storageConfig.webdav?.url && cached.storageConfig.webdav?.username);
  }
  return false;
}

export async function update(partial) {
  if (!cached) await init();
  cached = { ...cached, ...partial };
  await save();
}

export async function updateKeyConfig(keyConfig) {
  if (!cached) await init();
  cached.keyConfig = { ...cached.keyConfig, ...keyConfig };
  await save();
}

export async function updateStorageConfig(type, config) {
  if (!cached) await init();
  cached.storageType = type;
  cached.storageConfig[type] = { ...cached.storageConfig[type], ...config };
  await save();
}

export async function addSyncLogEntry(entry) {
  if (!cached) await init();
  cached.syncLog.unshift(entry);
  if (cached.syncLog.length > 20) cached.syncLog = cached.syncLog.slice(0, 20);
  cached.lastSyncTime = entry.time;
  cached.lastSyncStatus = entry.status;
  cached.lastSyncError = entry.status === "error" ? entry.error : null;
  await save();
}

async function save() {
  await chrome.storage.local.set({ [STORAGE_KEY]: cached });
}
```

- [ ] **Step 2: Verify**

Open extension service worker console, run:
```javascript
import * as config from './background/cloud/config.js';
await config.init();
JSON.stringify(config.get());
```
Expected: default config object as JSON string.

- [ ] **Step 3: Commit**

```bash
git add cookie-sync-extension/background/cloud/config.js
git commit -m "feat: add cloud sync config module"
```

---

## Task 3: Crypto Module — AES-256-GCM Encryption and Key Management

**Files:**
- Create: `background/cloud/crypto.js`

- [ ] **Step 1: Implement crypto.js**

```javascript
// background/cloud/crypto.js — AES-256-GCM encryption and key management

const ALGO = "AES-GCM";
const KEY_LENGTH = 256;
const IV_LENGTH = 12;
const PBKDF2_ITERATIONS = 100000;

export async function generateKey() {
  return await crypto.subtle.generateKey(
    { name: ALGO, length: KEY_LENGTH },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function importFromPassword(password, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt || encoder.encode("cookie-sync-salt"),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: ALGO, length: KEY_LENGTH },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function exportKey(key) {
  const raw = await crypto.subtle.exportKey("raw", key);
  return arrayBufferToBase64(raw);
}

export async function importKey(base64Str) {
  const raw = base64ToArrayBuffer(base64Str);
  return await crypto.subtle.importKey(
    "raw",
    raw,
    { name: ALGO, length: KEY_LENGTH },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function encrypt(plaintext, key) {
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const data = encoder.encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    key,
    data
  );
  return {
    iv: arrayBufferToBase64(iv.buffer),
    data: arrayBufferToBase64(ciphertext),
  };
}

export async function decrypt(encrypted, key) {
  const iv = base64ToArrayBuffer(encrypted.iv);
  const ciphertext = base64ToArrayBuffer(encrypted.data);
  const decrypted = await crypto.subtle.decrypt(
    { name: ALGO, iv },
    key,
    ciphertext
  );
  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
```

- [ ] **Step 2: Verify encryption round-trip**

Open service worker console:
```javascript
import * as crypto from './background/cloud/crypto.js';
const key = await crypto.generateKey();
const exported = await crypto.exportKey(key);
const plain = '{"test": true}';
const enc = await crypto.encrypt(plain, key);
const dec = await crypto.decrypt(enc, key);
console.log(dec === plain); // true
// Test import/export round-trip
const key2 = await crypto.importKey(exported);
const dec2 = await crypto.decrypt(enc, key2);
console.log(dec2 === plain); // true
```

- [ ] **Step 3: Verify password-derived key**

```javascript
import * as crypto from './background/cloud/crypto.js';
const key = await crypto.importFromPassword("mypassword");
const exported = await crypto.exportKey(key);
console.log("Key length:", exported.length); // Base64 string of 32 bytes
const plain = '{"test": true}';
const enc = await crypto.encrypt(plain, key);
const dec = await crypto.decrypt(enc, key);
console.log(dec === plain); // true
```

- [ ] **Step 4: Commit**

```bash
git add cookie-sync-extension/background/cloud/crypto.js
git commit -m "feat: add AES-256-GCM crypto module with key management"
```

---

## Task 4: Storage Adapter Interface and Gist Adapter

**Files:**
- Create: `background/cloud/storage-adapter.js`
- Create: `background/cloud/gist-adapter.js`

- [ ] **Step 1: Implement storage-adapter.js (interface documentation)**

```javascript
// background/cloud/storage-adapter.js — Storage adapter factory
//
// Interface contract (duck-typed):
//   init(config) -> Promise<void>
//   upload(encryptedPayload: string) -> Promise<boolean>
//   download() -> Promise<string | null>
//   getLastModified() -> Promise<number | null>
//   testConnection() -> Promise<boolean>

import { createGistAdapter } from "./gist-adapter.js";
import { createWebdavAdapter } from "./webdav-adapter.js";

export function createAdapter(type, config) {
  switch (type) {
    case "gist":
      return createGistAdapter(config);
    case "webdav":
      return createWebdavAdapter(config);
    default:
      throw new Error(`Unknown storage type: ${type}`);
  }
}
```

- [ ] **Step 2: Implement gist-adapter.js**

```javascript
// background/cloud/gist-adapter.js — GitHub Gist storage backend

const GITHUB_API = "https://api.github.com";
const FILENAME = "cookie-sync.enc";

export function createGistAdapter(config) {
  let token = config.token || "";
  let gistId = config.gistId || "";

  async function apiFetch(path, options = {}) {
    const url = `${GITHUB_API}${path}`;
    const headers = {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      ...options.headers,
    };
    const resp = await fetch(url, { ...options, headers });
    if (resp.status === 401) throw new Error("GitHub authentication failed");
    if (resp.status === 403 || resp.status === 429) {
      const remaining = resp.headers.get("X-RateLimit-Remaining");
      throw new Error(`GitHub API rate limited. Remaining: ${remaining}`);
    }
    return resp;
  }

  async function init(configUpdate) {
    if (configUpdate?.token) token = configUpdate.token;
    if (configUpdate?.gistId) gistId = configUpdate.gistId;
  }

  async function testConnection() {
    try {
      if (!token) return false;
      const resp = await apiFetch("/user");
      return resp.ok;
    } catch {
      return false;
    }
  }

  async function upload(encryptedPayload) {
    try {
      if (!gistId) {
        // Create new gist
        const resp = await apiFetch("/gists", {
          method: "POST",
          body: JSON.stringify({
            description: "Cookie Sync encrypted data",
            public: false,
            files: { [FILENAME]: { content: encryptedPayload } },
          }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.message || `Failed to create gist: ${resp.status}`);
        }
        const data = await resp.json();
        gistId = data.id;
        return gistId;
      }

      // Update existing gist
      const resp = await apiFetch(`/gists/${gistId}`, {
        method: "PATCH",
        body: JSON.stringify({
          files: { [FILENAME]: { content: encryptedPayload } },
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.message || `Failed to update gist: ${resp.status}`);
      }
      return true;
    } catch (err) {
      console.error("[cloud-sync] Gist upload error:", err);
      throw err;
    }
  }

  async function download() {
    try {
      if (!gistId) return null;
      const resp = await apiFetch(`/gists/${gistId}`);
      if (resp.status === 404) return null;
      if (!resp.ok) throw new Error(`Failed to fetch gist: ${resp.status}`);
      const data = await resp.json();
      const file = data.files?.[FILENAME];
      return file?.content || null;
    } catch (err) {
      console.error("[cloud-sync] Gist download error:", err);
      throw err;
    }
  }

  async function getLastModified() {
    try {
      if (!gistId) return null;
      const resp = await apiFetch(`/gists/${gistId}`);
      if (!resp.ok) return null;
      const data = await resp.json();
      const dateStr = data.updated_at || data.created_at;
      return dateStr ? new Date(dateStr).getTime() : null;
    } catch {
      return null;
    }
  }

  function getGistId() {
    return gistId;
  }

  return { init, testConnection, upload, download, getLastModified, getGistId };
}
```

- [ ] **Step 3: Verify Gist adapter**

Set up a GitHub Personal Access Token with `gist` scope, then test in service worker console:
```javascript
import { createGistAdapter } from './background/cloud/gist-adapter.js';
const adapter = createGistAdapter({ token: "ghp_YOUR_TOKEN" });
const ok = await adapter.testConnection();
console.log("Connection:", ok);
const result = await adapter.upload('test-encrypted-data');
console.log("Upload result:", result);
const data = await adapter.download();
console.log("Downloaded:", data);
```

- [ ] **Step 4: Commit**

```bash
git add cookie-sync-extension/background/cloud/storage-adapter.js cookie-sync-extension/background/cloud/gist-adapter.js
git commit -m "feat: add storage adapter interface and GitHub Gist backend"
```

---

## Task 5: WebDAV Adapter

**Files:**
- Create: `background/cloud/webdav-adapter.js`

- [ ] **Step 1: Implement webdav-adapter.js**

```javascript
// background/cloud/webdav-adapter.js — WebDAV storage backend

export function createWebdavAdapter(config) {
  let url = (config.url || "").replace(/\/+$/, "");
  let username = config.username || "";
  let password = config.password || "";
  let filePath = config.filePath || "/cookie-sync/cookies.enc";

  function getAuthHeader() {
    const credentials = btoa(`${username}:${password}`);
    return `Basic ${credentials}`;
  }

  function getFileUrl() {
    const path = filePath.startsWith("/") ? filePath : `/${filePath}`;
    return `${url}${path}`;
  }

  async function init(configUpdate) {
    if (configUpdate?.url) url = configUpdate.url.replace(/\/+$/, "");
    if (configUpdate?.username) username = configUpdate.username;
    if (configUpdate?.password) password = configUpdate.password;
    if (configUpdate?.filePath) filePath = configUpdate.filePath;
  }

  async function testConnection() {
    try {
      if (!url || !username) return false;
      const resp = await fetch(url, {
        method: "PROPFIND",
        headers: {
          Authorization: getAuthHeader(),
          Depth: "0",
        },
      });
      return resp.status === 207 || resp.status === 200;
    } catch {
      return false;
    }
  }

  async function upload(encryptedPayload) {
    try {
      const fileUrl = getFileUrl();
      const resp = await fetch(fileUrl, {
        method: "PUT",
        headers: {
          Authorization: getAuthHeader(),
          "Content-Type": "application/octet-stream",
        },
        body: encryptedPayload,
      });
      if (resp.status === 201 || resp.status === 204 || resp.status === 200) {
        return true;
      }
      if (resp.status === 401) throw new Error("WebDAV authentication failed");
      if (resp.status === 404) throw new Error("WebDAV path not found. Check file path and ensure parent directory exists.");
      if (resp.status === 409) throw new Error("WebDAV conflict: parent directory does not exist");
      throw new Error(`WebDAV upload failed: ${resp.status}`);
    } catch (err) {
      console.error("[cloud-sync] WebDAV upload error:", err);
      throw err;
    }
  }

  async function download() {
    try {
      const fileUrl = getFileUrl();
      const resp = await fetch(fileUrl, {
        method: "GET",
        headers: {
          Authorization: getAuthHeader(),
        },
      });
      if (resp.status === 404) return null;
      if (!resp.ok) throw new Error(`WebDAV download failed: ${resp.status}`);
      return await resp.text();
    } catch (err) {
      console.error("[cloud-sync] WebDAV download error:", err);
      throw err;
    }
  }

  async function getLastModified() {
    try {
      const fileUrl = getFileUrl();
      const resp = await fetch(fileUrl, {
        method: "HEAD",
        headers: {
          Authorization: getAuthHeader(),
        },
      });
      if (!resp.ok) return null;
      const lastModified = resp.headers.get("Last-Modified");
      return lastModified ? new Date(lastModified).getTime() : null;
    } catch {
      return null;
    }
  }

  return { init, testConnection, upload, download, getLastModified };
}
```

- [ ] **Step 2: Verify WebDAV adapter**

Test with a WebDAV service (e.g., 坚果云):
```javascript
import { createWebdavAdapter } from './background/cloud/webdav-adapter.js';
const adapter = createWebdavAdapter({
  url: "https://dav.jianguoyun.com/dav",
  username: "your-email@example.com",
  password: "your-app-password",
  filePath: "/cookie-sync/test.enc"
});
const ok = await adapter.testConnection();
console.log("Connection:", ok);
await adapter.upload("test-data");
const data = await adapter.download();
console.log("Downloaded:", data);
```

- [ ] **Step 3: Commit**

```bash
git add cookie-sync-extension/background/cloud/webdav-adapter.js
git commit -m "feat: add WebDAV storage backend adapter"
```

---

## Task 6: Data Collector — Cookie and localStorage Collection

**Files:**
- Create: `background/cloud/data-collector.js`

- [ ] **Step 1: Implement data-collector.js**

```javascript
// background/cloud/data-collector.js — Collect cookies and localStorage by whitelist

import * as whitelist from "../whitelist.js";

export async function collectAll(lastKnown) {
  const domains = whitelist.getAllowedDomains();
  if (domains.length === 0) {
    return { cookies: {}, localStorages: {}, timestamp: Date.now(), domainCount: 0, cookieCount: 0 };
  }

  const now = Date.now();
  const cookiesByDomain = {};
  let totalCookies = 0;

  for (const domain of domains) {
    try {
      const cookies = await chrome.cookies.getAll({ domain });
      const filtered = cookies.filter((c) => whitelist.isAllowed(c.domain));
      cookiesByDomain[domain] = filtered.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: c.expirationDate,
        lastModified: lastKnown?.[cookieKey(c)] || now,
      }));
      totalCookies += filtered.length;
    } catch (err) {
      console.warn(`[cloud-sync] Failed to collect cookies for ${domain}:`, err);
    }
  }

  const localStorages = await collectLocalStorages(domains);

  return {
    version: 1,
    timestamp: now,
    cookies: cookiesByDomain,
    localStorages,
    domainCount: domains.length,
    cookieCount: totalCookies,
  };
}

async function collectLocalStorages(domains) {
  const storages = {};
  const tabs = await chrome.tabs.query({});

  for (const domain of domains) {
    const matchingTabs = tabs.filter((tab) => {
      try {
        const hostname = new URL(tab.url).hostname;
        return hostname === domain || hostname.endsWith(`.${domain}`);
      } catch {
        return false;
      }
    });

    for (const tab of matchingTabs) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const data = {};
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              data[key] = localStorage.getItem(key);
            }
            return data;
          },
        });
        if (results?.[0]?.result && Object.keys(results[0].result).length > 0) {
          const origin = new URL(tab.url).origin;
          if (!storages[origin]) storages[origin] = {};
          Object.assign(storages[origin], results[0].result);
        }
      } catch (err) {
        // Tab may not be accessible (chrome://, about:, etc.)
      }
    }
  }

  return storages;
}

export async function writeCookies(cookiesByDomain) {
  let written = 0;
  let deleted = 0;

  for (const [domain, cookies] of Object.entries(cookiesByDomain)) {
    for (const c of cookies) {
      try {
        const url = `http${c.secure ? "s" : ""}://${c.domain.replace(/^\./, "")}${c.path}`;
        if (c.expirationDate && c.expirationDate < Date.now() / 1000) {
          // Expired cookie — delete locally
          await chrome.cookies.remove({ url, name: c.name });
          deleted++;
          continue;
        }
        await chrome.cookies.set({
          url,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: mapSameSite(c.sameSite),
          expirationDate: c.expirationDate,
        });
        written++;
      } catch (err) {
        console.warn(`[cloud-sync] Failed to write cookie ${c.name}@${domain}:`, err);
      }
    }
  }

  return { written, deleted };
}

export async function writeLocalStorages(localStorages) {
  let written = 0;
  const tabs = await chrome.tabs.query({});

  for (const [origin, data] of Object.entries(localStorages)) {
    const url = new URL(origin);
    const matchingTabs = tabs.filter((tab) => {
      try {
        return new URL(tab.url).origin === origin;
      } catch {
        return false;
      }
    });

    for (const tab of matchingTabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (items) => {
            for (const [key, value] of Object.entries(items)) {
              localStorage.setItem(key, value);
            }
          },
          args: [data],
        });
        written += Object.keys(data).length;
      } catch {
        // Tab not accessible
      }
    }
  }

  return { written };
}

function cookieKey(c) {
  return `${c.domain}:${c.name}:${c.path}`;
}

function mapSameSite(sameSite) {
  switch (sameSite) {
    case "strict": return "strict";
    case "lax": return "lax";
    case "no_restriction": return "no_restriction";
    default: return "lax";
  }
}

export { cookieKey };
```

- [ ] **Step 2: Verify data collection**

Ensure whitelist has at least one domain with cookies, then in service worker console:
```javascript
import * as dc from './background/cloud/data-collector.js';
const data = await dc.collectAll({});
console.log("Collected:", data.domainCount, "domains,", data.cookieCount, "cookies");
console.log("Sample:", JSON.stringify(data).substring(0, 200));
```

- [ ] **Step 3: Commit**

```bash
git add cookie-sync-extension/background/cloud/data-collector.js
git commit -m "feat: add cookie and localStorage data collector"
```

---

## Task 7: Conflict Resolver — Timestamp-Based Conflict Resolution

**Files:**
- Create: `background/cloud/conflict.js`

- [ ] **Step 1: Implement conflict.js**

```javascript
// background/cloud/conflict.js — Timestamp-based conflict resolution for bidirectional sync

import { cookieKey } from "./data-collector.js";

/**
 * Resolve conflicts between local and remote data.
 * Returns a merged result ready to be written locally + re-uploaded.
 *
 * @param {object} localData  - Current local snapshot (from data-collector)
 * @param {object} remoteData - Decrypted remote snapshot
 * @param {object} lastKnown  - Last known timestamps for local cookies
 * @returns {object} { merged, stats: { localKept, remoteKept, added, deleted } }
 */
export function resolve(localData, remoteData, lastKnown) {
  const stats = { localKept: 0, remoteKept: 0, added: 0, deleted: 0 };
  const mergedCookies = {};
  const now = Date.now();

  // Build remote cookie index
  const remoteIndex = {};
  if (remoteData?.cookies) {
    for (const [domain, cookies] of Object.entries(remoteData.cookies)) {
      for (const c of cookies) {
        remoteIndex[cookieKey(c)] = { ...c, _domain: domain };
      }
    }
  }

  // Build local cookie index
  const localIndex = {};
  if (localData?.cookies) {
    for (const [domain, cookies] of Object.entries(localData.cookies)) {
      for (const c of cookies) {
        localIndex[cookieKey(c)] = { ...c, _domain: domain };
      }
    }
  }

  const allKeys = new Set([...Object.keys(localIndex), ...Object.keys(remoteIndex)]);

  for (const key of allKeys) {
    const local = localIndex[key];
    const remote = remoteIndex[key];

    if (!local && remote) {
      // Only remote has it → add to local
      if (remote.expirationDate && remote.expirationDate < now / 1000) {
        // Remote cookie expired → skip (don't add expired cookie)
        stats.deleted++;
      } else {
        if (!mergedCookies[remote._domain]) mergedCookies[remote._domain] = [];
        mergedCookies[remote._domain].push(remote);
        stats.added++;
      }
    } else if (local && !remote) {
      // Only local has it → keep local (will be pushed in bidirectional)
      if (!mergedCookies[local._domain]) mergedCookies[local._domain] = [];
      mergedCookies[local._domain].push(local);
      stats.localKept++;
    } else if (local && remote) {
      // Both have it → compare timestamps
      const localTs = lastKnown?.[key] || local.lastModified || 0;
      const remoteTs = remote.lastModified || 0;

      if (remote.expirationDate && remote.expirationDate < now / 1000) {
        // Remote says delete → delete locally
        stats.deleted++;
      } else if (remoteTs > localTs) {
        // Remote is newer → use remote
        if (!mergedCookies[remote._domain]) mergedCookies[remote._domain] = [];
        mergedCookies[remote._domain].push(remote);
        stats.remoteKept++;
      } else {
        // Local is newer or equal → keep local
        if (!mergedCookies[local._domain]) mergedCookies[local._domain] = [];
        mergedCookies[local._domain].push(local);
        stats.localKept++;
      }
    }
  }

  // Merge localStorage: remote overwrites local, local-only keys preserved
  const mergedStorages = { ...(localData?.localStorages || {}) };
  if (remoteData?.localStorages) {
    for (const [origin, data] of Object.entries(remoteData.localStorages)) {
      mergedStorages[origin] = { ...(mergedStorages[origin] || {}), ...data };
    }
  }

  return {
    merged: {
      version: 1,
      timestamp: now,
      cookies: mergedCookies,
      localStorages: mergedStorages,
    },
    stats,
  };
}
```

- [ ] **Step 2: Verify conflict resolution logic**

In service worker console:
```javascript
import * as conflict from './background/cloud/conflict.js';
const local = {
  cookies: {
    ".example.com": [
      { name: "a", value: "local-new", domain: ".example.com", path: "/", secure: true, httpOnly: false, sameSite: "Lax", lastModified: 2000 }
    ]
  },
  localStorages: {}
};
const remote = {
  cookies: {
    ".example.com": [
      { name: "a", value: "remote-old", domain: ".example.com", path: "/", secure: true, httpOnly: false, sameSite: "Lax", lastModified: 1000 },
      { name: "b", value: "remote-only", domain: ".example.com", path: "/", secure: true, httpOnly: false, sameSite: "Lax", lastModified: 1500 }
    ]
  },
  localStorages: {}
};
const result = conflict.resolve(local, remote, {});
console.log("Stats:", result.stats); // { localKept: 1, remoteKept: 0, added: 1, deleted: 0 }
```

- [ ] **Step 3: Commit**

```bash
git add cookie-sync-extension/background/cloud/conflict.js
git commit -m "feat: add timestamp-based conflict resolver"
```

---

## Task 8: Sync Engine — Push/Pull/Bidirectional Orchestration

**Files:**
- Create: `background/cloud/sync-engine.js`

- [ ] **Step 1: Implement sync-engine.js**

```javascript
// background/cloud/sync-engine.js — Sync orchestration engine

import * as config from "./config.js";
import * as crypto from "./crypto.js";
import { createAdapter } from "./storage-adapter.js";
import * as dataCollector from "./data-collector.js";
import * as conflict from "./conflict.js";

const ALARM_NAME = "cloud-sync";
const MIN_INTERVAL = 5;
const LAST_KNOWN_KEY = "cloudSyncLastKnown";

let adapter = null;
let cryptoKey = null;

export async function init() {
  await config.init();
  await initAdapter();
  await initCryptoKey();
  setupAlarm();
}

export function getStatus() {
  const cfg = config.get();
  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    configured: config.isConfigured(),
    storageType: cfg.storageType,
    scheduleEnabled: cfg.scheduleEnabled,
    scheduleInterval: cfg.scheduleIntervalMinutes,
    lastSyncTime: cfg.lastSyncTime,
    lastSyncStatus: cfg.lastSyncStatus,
    lastSyncError: cfg.lastSyncError,
  };
}

export async function push() {
  if (!config.isConfigured()) throw new Error("Cloud sync not configured");
  const lastKnown = await loadLastKnown();
  const data = await dataCollector.collectAll(lastKnown);
  if (data.cookieCount === 0 && Object.keys(data.localStorages).length === 0) {
    throw new Error("No data to sync. Add domains to whitelist first.");
  }
  const plaintext = JSON.stringify(data);
  const encrypted = await crypto.encrypt(plaintext, cryptoKey);
  const payload = JSON.stringify({
    version: 1,
    crypto: "aes-256-gcm",
    keyType: config.getKeyConfig().type,
    iv: encrypted.iv,
    data: encrypted.data,
  });
  const result = await adapter.upload(payload);
  // Save gistId if newly created
  if (typeof result === "string" && config.get().storageType === "gist") {
    await config.updateStorageConfig("gist", { gistId: result });
    adapter.init({ gistId: result });
  }
  await saveLastKnown(data);
  await config.addSyncLogEntry({
    time: Date.now(),
    action: "push",
    status: "success",
    domains: data.domainCount,
    cookies: data.cookieCount,
  });
  return { success: true, domains: data.domainCount, cookies: data.cookieCount };
}

export async function pull() {
  if (!config.isConfigured()) throw new Error("Cloud sync not configured");
  const encryptedPayload = await adapter.download();
  if (!encryptedPayload) throw new Error("No remote data found");
  const payload = JSON.parse(encryptedPayload);
  const plaintext = await crypto.decrypt({ iv: payload.iv, data: payload.data }, cryptoKey);
  const remoteData = JSON.parse(plaintext);
  const lastKnown = await loadLastKnown();
  const localData = await dataCollector.collectAll(lastKnown);
  const { merged, stats } = conflict.resolve(localData, remoteData, lastKnown);
  const writeResult = await dataCollector.writeCookies(merged.cookies);
  await dataCollector.writeLocalStorages(merged.localStorages);
  await saveLastKnown(merged);
  await config.addSyncLogEntry({
    time: Date.now(),
    action: "pull",
    status: "success",
    domains: Object.keys(merged.cookies).length,
    cookies: writeResult.written,
  });
  return { success: true, ...stats, written: writeResult.written, deleted: writeResult.deleted };
}

export async function sync() {
  if (!config.isConfigured()) throw new Error("Cloud sync not configured");
  // Bidirectional: pull first, then push merged result
  await pull();
  await push();
  await config.addSyncLogEntry({
    time: Date.now(),
    action: "sync",
    status: "success",
  });
  return { success: true };
}

export async function testConnection() {
  if (!adapter) return false;
  return adapter.testConnection();
}

export async function generateAndStoreKey() {
  const key = await crypto.generateKey();
  const exported = await crypto.exportKey(key);
  await config.updateKeyConfig({ type: "random", exportedKey: exported });
  cryptoKey = key;
  return exported;
}

export async function importAndStoreKey(base64Key) {
  const key = await crypto.importKey(base64Key);
  const exported = await crypto.exportKey(key);
  await config.updateKeyConfig({ type: "random", exportedKey: exported });
  cryptoKey = key;
  return exported;
}

export async function deriveAndStoreKey(password) {
  const key = await crypto.importFromPassword(password);
  const exported = await crypto.exportKey(key);
  await config.updateKeyConfig({ type: "pbkdf2", exportedKey: exported });
  cryptoKey = key;
  return exported;
}

export async function updateSettings(settings) {
  if (settings.mode) await config.update({ mode: settings.mode });
  if (settings.scheduleEnabled !== undefined) await config.update({ scheduleEnabled: settings.scheduleEnabled });
  if (settings.scheduleIntervalMinutes) {
    const interval = Math.max(MIN_INTERVAL, settings.scheduleIntervalMinutes);
    await config.update({ scheduleIntervalMinutes: interval });
  }
  setupAlarm();
}

export async function updateStorage(type, storageConfig) {
  await config.updateStorageConfig(type, storageConfig);
  await initAdapter();
}

// --- Internal ---

async function initAdapter() {
  const cfg = config.get();
  if (cfg.storageType) {
    adapter = createAdapter(cfg.storageType, config.getStorageConfig());
  }
}

async function initCryptoKey() {
  const keyCfg = config.getKeyConfig();
  if (keyCfg.exportedKey) {
    cryptoKey = await crypto.importKey(keyCfg.exportedKey);
  }
}

function setupAlarm() {
  chrome.alarms.onAlarm.removeListener(handleAlarm);
  chrome.alarms.clear(ALARM_NAME);

  const cfg = config.get();
  if (!cfg.scheduleEnabled || !cfg.enabled) return;

  const interval = Math.max(MIN_INTERVAL, cfg.scheduleIntervalMinutes);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: interval });
  chrome.alarms.onAlarm.addListener(handleAlarm);
}

function handleAlarm(alarm) {
  if (alarm.name !== ALARM_NAME) return;
  const mode = config.get().mode;
  if (mode === "push-only") push().catch(handleSyncError);
  else if (mode === "pull-only") pull().catch(handleSyncError);
  else sync().catch(handleSyncError);
}

function handleSyncError(err) {
  console.error("[cloud-sync] Scheduled sync failed:", err);
  config.addSyncLogEntry({
    time: Date.now(),
    action: config.get().mode,
    status: "error",
    error: err.message,
  });
}

async function loadLastKnown() {
  const result = await chrome.storage.local.get(LAST_KNOWN_KEY);
  return result[LAST_KNOWN_KEY] || {};
}

async function saveLastKnown(data) {
  const lastKnown = {};
  if (data?.cookies) {
    for (const cookies of Object.values(data.cookies)) {
      for (const c of cookies) {
        const key = `${c.domain}:${c.name}:${c.path}`;
        lastKnown[key] = c.lastModified || Date.now();
      }
    }
  }
  await chrome.storage.local.set({ [LAST_KNOWN_KEY]: lastKnown });
}
```

- [ ] **Step 2: Commit**

```bash
git add cookie-sync-extension/background/cloud/sync-engine.js
git commit -m "feat: add sync engine with push/pull/bidirectional orchestration"
```

---

## Task 9: Background Integration — Wire Cloud Sync into main.js

**Files:**
- Modify: `cookie-sync-extension/background/main.js`

- [ ] **Step 1: Update main.js imports and initialization**

Add cloud sync module import and initialization call. Add cloud sync message handlers to `popupHandlers`:

```javascript
// main.js — Entry point: initialization, alarm, command routing, popup messages

import * as connection from "./connection.js";
import * as cookieOps from "./cookie-ops.js";
import * as whitelist from "./whitelist.js";
import * as cloudSync from "./cloud/sync-engine.js";

let initialized = false;
let initPromise = null;
let pendingDomain = null;
const popupHandlers = {
  getStatus: () => connection.getStatus(),
  popupOpened: async () => {
    await ensureReady({ resetReconnect: true });
    return connection.getStatus();
  },
  getDomains: async () => {
    await ensureReady();
    return { domains: whitelist.getAllowedDomains() };
  },
  pendingDomain: ({ domain }) => {
    pendingDomain = domain;
    return { ok: true };
  },
  confirmDomain: async ({ domain }) => {
    await ensureReady();
    pendingDomain = null;
    const result = await whitelist.addDomain(domain);
    if (!result.ok && result.error === "Domain already allowed") {
      return { ok: true };
    }
    return result;
  },
  removeDomain: async ({ domain, skipPermissionRevoke }) => {
    await ensureReady();
    const result = await whitelist.removeDomain(domain, {
      skipPermissionRevoke: skipPermissionRevoke === true,
    });
    console.log("[cookie-sync] removeDomain completed:", result);
    return result;
  },
  // Cloud sync handlers
  cloudGetStatus: async () => {
    return cloudSync.getStatus();
  },
  cloudPush: async () => {
    return await cloudSync.push();
  },
  cloudPull: async () => {
    return await cloudSync.pull();
  },
  cloudSync: async () => {
    return await cloudSync.sync();
  },
  cloudTestConnection: async () => {
    const ok = await cloudSync.testConnection();
    return { ok };
  },
  cloudGenerateKey: async () => {
    const exported = await cloudSync.generateAndStoreKey();
    return { ok: true, key: exported };
  },
  cloudImportKey: async ({ key }) => {
    const exported = await cloudSync.importAndStoreKey(key);
    return { ok: true, key: exported };
  },
  cloudDeriveKey: async ({ password }) => {
    const exported = await cloudSync.deriveAndStoreKey(password);
    return { ok: true, key: exported };
  },
  cloudExportKey: async () => {
    const cfg = (await import("./cloud/config.js")).get();
    return { ok: true, key: cfg.keyConfig.exportedKey };
  },
  cloudUpdateSettings: async ({ settings }) => {
    await cloudSync.updateSettings(settings);
    return { ok: true };
  },
  cloudUpdateStorage: async ({ type, config }) => {
    await cloudSync.updateStorage(type, config);
    return { ok: true };
  },
  cloudGetSyncLog: async () => {
    const cfg = (await import("./cloud/config.js")).get();
    return { log: cfg.syncLog || [] };
  },
};

async function initialize() {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await whitelist.init();
    connection.init(onDaemonMessage);
    await cloudSync.init();
    chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
    console.log("[cookie-sync] Extension initialized");
    initialized = true;
  })().catch((err) => {
    initPromise = null;
    throw err;
  });

  return initPromise;
}

async function ensureReady(options = {}) {
  await initialize();
  const action = options.resetReconnect
    ? connection.restartShortRetryWindow
    : connection.tryConnect;
  action();
}

// --- Daemon command handler ---
async function onDaemonMessage(cmd) {
  const id = cmd.id;
  try {
    switch (cmd.action) {
      case "getCookies":
        return { id, ...await cookieOps.handleGetCookies(cmd) };
      case "listAllowed":
        return { id, ...await cookieOps.handleListAllowed() };
      case "ping":
        return { id, ok: true, data: { pong: true } };
      default:
        return { id, ok: false, error: `Unknown action: ${cmd.action}` };
    }
  } catch (err) {
    return { id, ok: false, error: err.message || String(err) };
  }
}

// --- Permission granted fallback ---
chrome.permissions.onAdded.addListener(async (permissions) => {
  if (!pendingDomain) return;
  await initialize();
  const origins = permissions.origins || [];
  const patterns = whitelist.getOriginPatterns(pendingDomain);
  if (patterns.some((p) => origins.includes(p))) {
    await whitelist.addDomain(pendingDomain).catch(() => {});
    pendingDomain = null;
  }
});

// --- Alarm: keep SW alive + reconnect ---
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    void ensureReady();
  }
});

// --- Popup messages ---
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = popupHandlers[msg?.type];
  if (!handler) {
    return false;
  }

  if (msg?.type === "getStatus") {
    sendResponse(handler(msg));
    return false;
  }

  Promise.resolve(handler(msg))
    .then((result) => {
      sendResponse(result ?? { ok: true });
    })
    .catch((err) => {
      const error = err.message || String(err);
      sendResponse(msg?.type === "getDomains" ? { domains: [], error } : { ok: false, error });
    });
  return msg?.type !== "getStatus";
});

// --- Lifecycle ---
chrome.runtime.onInstalled.addListener(() => initialize());
chrome.runtime.onStartup.addListener(() => initialize());
```

- [ ] **Step 2: Verify extension loads without errors**

Reload extension in `chrome://extensions`, check service worker console for `[cookie-sync] Extension initialized`.

- [ ] **Step 3: Commit**

```bash
git add cookie-sync-extension/background/main.js
git commit -m "feat: integrate cloud sync module into extension background"
```

---

## Task 10: Popup UI — Tab Structure Refactor

**Files:**
- Modify: `cookie-sync-extension/popup/popup.html`
- Modify: `cookie-sync-extension/popup/popup.js`

- [ ] **Step 1: Refactor popup.html with tab structure**

Replace the entire `popup.html` with tab-based layout. The domain management content moves into a tab pane, and a new cloud sync tab pane is added:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: 320px;
      max-height: 500px;
      overflow-y: auto;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      color: #333;
      background: #fff;
    }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px 0;
    }
    .header img { width: 24px; height: 24px; }
    .header h1 { font-size: 15px; font-weight: 600; }

    /* Tab bar */
    .tab-bar {
      display: flex;
      border-bottom: 1px solid #e0e0e0;
      padding: 0 16px;
      margin-top: 8px;
    }
    .tab-btn {
      flex: 1;
      padding: 8px 0;
      border: none;
      background: none;
      font-size: 12px;
      color: #999;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      font-weight: 500;
    }
    .tab-btn.active {
      color: #007aff;
      border-bottom-color: #007aff;
      font-weight: 600;
    }
    .tab-btn:hover:not(.active) {
      color: #666;
    }

    /* Tab content */
    .tab-content {
      display: none;
      padding: 14px 16px;
    }
    .tab-content.active {
      display: block;
    }

    /* Status row */
    .status-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-radius: 8px;
      background: #f5f5f5;
    }
    .dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .dot.connected { background: #34c759; }
    .dot.disconnected { background: #ff3b30; }
    .dot.connecting { background: #ff9500; }
    .status-text { font-size: 13px; color: #555; }
    .status-text strong { color: #333; }

    /* Domain section */
    .domain-section {
      margin-top: 14px;
    }
    .domain-section h2 {
      font-size: 13px;
      font-weight: 600;
      color: #555;
      margin-bottom: 8px;
    }
    .domain-input-row {
      display: flex;
      gap: 6px;
    }
    .domain-input-row input {
      flex: 1;
      padding: 6px 10px;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 12px;
      outline: none;
    }
    .domain-input-row input:focus {
      border-color: #007aff;
    }
    .domain-input-row button {
      padding: 6px 12px;
      border: none;
      border-radius: 6px;
      background: #007aff;
      color: #fff;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
    }
    .domain-input-row button:hover {
      background: #0066d6;
    }
    .domain-error {
      font-size: 11px;
      color: #ff3b30;
      margin-top: 4px;
      min-height: 16px;
    }

    /* Domain group */
    .domain-list { margin-top: 8px; }
    .domain-empty {
      font-size: 11px;
      color: #999;
      text-align: center;
      padding: 12px 0;
    }
    .domain-group {
      margin-bottom: 6px;
      border-radius: 8px;
      background: #f5f5f5;
      overflow: hidden;
    }
    .group-header {
      display: flex;
      align-items: center;
      padding: 8px 10px;
      cursor: pointer;
      user-select: none;
    }
    .group-header:hover { background: #eee; }
    .group-arrow {
      font-size: 10px;
      color: #999;
      margin-right: 6px;
      width: 12px;
      text-align: center;
      transition: transform 0.15s;
      flex-shrink: 0;
    }
    .group-arrow.expanded { transform: rotate(90deg); }
    .group-name {
      font-size: 12px;
      font-weight: 600;
      color: #333;
      flex: 1;
      word-break: break-all;
    }
    .group-count {
      font-size: 11px;
      color: #999;
      margin-right: 4px;
      flex-shrink: 0;
    }
    .group-children { display: none; }
    .group-children.expanded { display: block; }
    .subdomain-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 5px 10px 5px 28px;
      border-top: 1px solid #eee;
    }
    .subdomain-item span {
      font-size: 11px;
      color: #555;
      word-break: break-all;
    }
    .subdomain-item button {
      border: none;
      background: none;
      color: #bbb;
      font-size: 10px;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 4px;
      flex-shrink: 0;
    }
    .subdomain-item button:hover {
      color: #ff3b30;
      background: #fff;
    }

    /* Pagination */
    .pagination {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      margin-top: 10px;
    }
    .pagination button {
      border: none;
      background: #f5f5f5;
      color: #555;
      font-size: 11px;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
    }
    .pagination button:hover:not(:disabled) { background: #e0e0e0; }
    .pagination button:disabled { color: #ccc; cursor: default; }
    .pagination .page-info { font-size: 11px; color: #999; }

    .footer {
      margin-top: 14px;
      text-align: center;
      font-size: 11px;
      color: #999;
      padding-bottom: 4px;
    }
  </style>
</head>
<body>
  <div class="header">
    <img src="../icons/icon-48.png" alt="Cookie Sync">
    <h1>Cookie Sync</h1>
  </div>

  <div class="tab-bar">
    <button class="tab-btn active" data-tab="domains">域名管理</button>
    <button class="tab-btn" data-tab="cloud">☁️ 云同步</button>
  </div>

  <!-- Domain Management Tab -->
  <div class="tab-content active" id="tab-domains">
    <div class="status-row">
      <span class="dot disconnected" id="dot"></span>
      <span class="status-text" id="status">Checking...</span>
    </div>

    <div class="domain-section">
      <h2>Allowed Domains</h2>
      <div class="domain-input-row">
        <input type="text" id="domainInput" placeholder="e.g. example.com">
        <button id="addBtn">Add</button>
      </div>
      <div class="domain-error" id="domainError"></div>
      <div class="domain-list" id="domainList"></div>
      <div class="pagination" id="pagination"></div>
    </div>
  </div>

  <!-- Cloud Sync Tab -->
  <div class="tab-content" id="tab-cloud">
    <div id="cloud-content"></div>
  </div>

  <div class="footer">Cookie Sync v1.0.0</div>

  <script type="module" src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 2: Update popup.js with tab switching and cloud tab initialization**

```javascript
// popup.js — Popup logic: tab switching, domain management, cloud sync

import { normalizeDomain, getOriginPatterns, getRootDomain } from "../background/domain-utils.js";
import { initCloudTab } from "./cloud-tab.js";

// --- Tab switching ---
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "cloud") {
      initCloudTab();
    }
  });
});

// --- Domain Management ---
const PAGE_SIZE = 5;

const dot = document.getElementById("dot");
const status = document.getElementById("status");
const domainInput = document.getElementById("domainInput");
const addBtn = document.getElementById("addBtn");
const domainError = document.getElementById("domainError");
const domainList = document.getElementById("domainList");
const pagination = document.getElementById("pagination");

let allDomains = [];
let groupedData = [];
let currentPage = 1;
let expandedGroups = new Set();
let isAddingDomain = false;
let statusPollTimer = null;
const STATUS_HTML = {
  connected: "<strong>Connected to daemon</strong>",
  connecting: "<strong>Reconnecting...</strong>",
  disconnected: "<strong>No daemon connected</strong>",
};

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function setStatus(state) {
  dot.className = `dot ${state}`;
  status.innerHTML = STATUS_HTML[state];
}

function setConnectionStatus(resp) {
  if (resp?.connected) setStatus("connected");
  else if (resp?.reconnecting) setStatus("connecting");
  else setStatus("disconnected");
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}

function updateOriginsPermission(method, origins) {
  return new Promise((resolve, reject) => {
    chrome.permissions[method]({ origins }, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result !== false);
    });
  });
}

// --- Init ---
notifyPopupOpened();
refreshDomains();

// --- Connection status ---
function refreshStatus() {
  sendMessage({ type: "getStatus" })
    .then((resp) => {
      setConnectionStatus(resp);
      syncStatusPolling(resp);
    })
    .catch(() => {
      stopStatusPolling();
      setStatus("disconnected");
    });
}

function notifyPopupOpened() {
  sendMessage({ type: "popupOpened" })
    .then((resp) => {
      setConnectionStatus(resp);
      syncStatusPolling(resp);
    })
    .catch(() => refreshStatus());
}

function syncStatusPolling(resp) {
  if (resp?.connected || !resp?.reconnecting) {
    stopStatusPolling();
    return;
  }
  if (statusPollTimer !== null) return;
  statusPollTimer = window.setInterval(() => refreshStatus(), 1000);
}

function stopStatusPolling() {
  if (statusPollTimer === null) return;
  window.clearInterval(statusPollTimer);
  statusPollTimer = null;
}

// --- Domain list ---
function refreshDomains() {
  sendMessage({ type: "getDomains" })
    .then((resp) => {
      allDomains = resp?.domains || [];
      buildGroups();
      render();
    })
    .catch(() => {});
}

function buildGroups() {
  const map = new Map();
  for (const d of allDomains) {
    const root = getRootDomain(d);
    const group = map.get(root) || [];
    group.push(d);
    map.set(root, group);
  }

  groupedData = [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([root, domains]) => ({ root, domains: domains.sort() }));
}

function render() {
  renderDomainList();
  renderPagination();
}

function renderDomainList() {
  if (groupedData.length === 0) {
    domainList.innerHTML = '<div class="domain-empty">No domains allowed yet. Add one above.</div>';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(groupedData.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = 1;

  const start = (currentPage - 1) * PAGE_SIZE;
  const pageGroups = groupedData.slice(start, start + PAGE_SIZE);

  domainList.innerHTML = pageGroups.map((group, groupIdx) => {
    const isExpanded = expandedGroups.has(group.root);

    const childrenHtml = group.domains.map((d, domainIdx) => `
      <div class="subdomain-item">
        <span>${escapeHtml(d)}</span>
        <button data-group-idx="${groupIdx}" data-domain-idx="${domainIdx}">Remove</button>
      </div>
    `).join("");

    return `
      <div class="domain-group">
        <div class="group-header" data-group-root="${groupIdx}">
          <span class="group-arrow ${isExpanded ? 'expanded' : ''}">&#9654;</span>
          <span class="group-name">${escapeHtml(group.root)}</span>
          <span class="group-count">${group.domains.length}</span>
        </div>
        <div class="group-children ${isExpanded ? 'expanded' : ''}">
          ${childrenHtml}
        </div>
      </div>`;
  }).join("");

  domainList.querySelectorAll(".group-header").forEach((header) => {
    header.addEventListener("click", () => {
      const groupIdx = parseInt(header.dataset.groupRoot, 10);
      const root = pageGroups[groupIdx]?.root;
      if (!root) return;
      if (expandedGroups.has(root)) expandedGroups.delete(root);
      else expandedGroups.add(root);
      render();
    });
  });

  domainList.querySelectorAll("button[data-domain-idx]").forEach((btn) => {
    btn.addEventListener("click", (e) => handleRemoveDomain(e, btn, pageGroups));
  });
}

function renderPagination() {
  const totalPages = Math.max(1, Math.ceil(groupedData.length / PAGE_SIZE));
  if (totalPages <= 1) {
    pagination.innerHTML = "";
    return;
  }

  pagination.innerHTML = `
    <button id="prevPage" ${currentPage <= 1 ? "disabled" : ""}>Prev</button>
    <span class="page-info">${currentPage} / ${totalPages}</span>
    <button id="nextPage" ${currentPage >= totalPages ? "disabled" : ""}>Next</button>
  `;

  document.getElementById("prevPage").addEventListener("click", () => {
    if (currentPage > 1) { currentPage--; render(); }
  });
  document.getElementById("nextPage").addEventListener("click", () => {
    if (currentPage < totalPages) { currentPage++; render(); }
  });
}

// --- Add domain ---
addBtn.addEventListener("click", async () => {
  if (isAddingDomain) return;

  const raw = domainInput.value.trim();
  const domain = normalizeDomain(raw);

  domainError.textContent = "";

  if (!domain) {
    domainError.textContent = "Please enter a valid domain";
    return;
  }
  if (!domain.includes(".")) {
    domainError.textContent = "Domain must contain a dot (e.g. example.com)";
    return;
  }
  if (allDomains.includes(domain)) {
    domainError.textContent = "Domain already allowed";
    return;
  }

  isAddingDomain = true;
  addBtn.disabled = true;

  try {
    await sendMessage({ type: "pendingDomain", domain });

    let granted = false;
    try {
      granted = await updateOriginsPermission("request", getOriginPatterns(domain));
    } catch (err) {
      domainError.textContent = err.message;
    }

    if (!granted) {
      if (!domainError.textContent) domainError.textContent = "Permission denied by user";
      return;
    }

    const resp = await sendMessage({ type: "confirmDomain", domain });
    if (resp?.ok) {
      domainInput.value = "";
      domainError.textContent = "";
      expandedGroups.add(getRootDomain(domain));
      refreshDomains();
    } else {
      domainError.textContent = resp?.error || "Failed to add domain";
    }
  } finally {
    isAddingDomain = false;
    addBtn.disabled = false;
  }
});

domainInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addBtn.click();
});

async function handleRemoveDomain(event, button, pageGroups) {
  event.stopPropagation();
  const groupIdx = parseInt(button.dataset.groupIdx, 10);
  const domainIdx = parseInt(button.dataset.domainIdx, 10);
  const domain = pageGroups[groupIdx]?.domains[domainIdx];
  if (!domain) return;

  button.disabled = true;
  domainError.textContent = "";

  try {
    let removed = false;
    try {
      removed = await updateOriginsPermission("remove", getOriginPatterns(domain));
    } catch (err) {
      domainError.textContent = err.message;
      return;
    }

    if (!removed) {
      domainError.textContent = "Chrome did not revoke the site permission";
      return;
    }

    const resp = await sendMessage({ type: "removeDomain", domain, skipPermissionRevoke: true });
    if (resp?.ok) {
      refreshDomains();
      domainError.textContent = "Domain removed from whitelist.";
      return;
    }

    domainError.textContent = "";
    alert("Failed to remove domain: " + (resp?.error || "Unknown error"));
  } finally {
    button.disabled = false;
  }
}
```

- [ ] **Step 3: Verify**

Reload extension, open popup. Confirm:
- Tab bar shows "域名管理" and "☁️ 云同步"
- Domain management tab works as before
- Clicking "☁️ 云同步" tab switches content (shows empty container for now)

- [ ] **Step 4: Commit**

```bash
git add cookie-sync-extension/popup/popup.html cookie-sync-extension/popup/popup.js
git commit -m "feat: add tab structure to popup for domain management and cloud sync"
```

---

## Task 11: Cloud Tab UI — Full Cloud Sync Interface

**Files:**
- Create: `cookie-sync-extension/popup/cloud-tab.css`
- Create: `cookie-sync-extension/popup/cloud-tab.js`

- [ ] **Step 1: Create cloud-tab.css**

```css
/* cloud-tab.css — Cloud sync tab styles */

/* Status card */
.cloud-card {
  background: #f5f5f5;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.cloud-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}
.cloud-card-title {
  font-size: 13px;
  font-weight: 600;
  color: #333;
}
.cloud-card-subtitle {
  font-size: 11px;
  color: #999;
}
.cloud-status-badge {
  font-size: 11px;
}
.cloud-status-badge.connected { color: #34c759; }
.cloud-status-badge.disconnected { color: #ff3b30; }

/* Sync mode selector */
.mode-selector {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}
.mode-btn {
  flex: 1;
  padding: 6px 4px;
  border: 1px solid #ddd;
  border-radius: 6px;
  background: #fff;
  font-size: 11px;
  color: #666;
  cursor: pointer;
  text-align: center;
}
.mode-btn.active {
  background: #007aff;
  color: #fff;
  border-color: #007aff;
  font-weight: 600;
}
.mode-btn:hover:not(.active) {
  background: #f0f0f0;
}

/* Schedule config */
.schedule-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.schedule-row label {
  font-size: 12px;
  color: #555;
}
.schedule-row input[type="number"] {
  width: 50px;
  padding: 4px 6px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 12px;
  text-align: center;
  outline: none;
}
.schedule-row input[type="number"]:focus {
  border-color: #007aff;
}
.schedule-row span {
  font-size: 11px;
  color: #999;
}
.toggle-switch {
  position: relative;
  width: 36px;
  height: 20px;
  background: #ddd;
  border-radius: 10px;
  cursor: pointer;
  flex-shrink: 0;
}
.toggle-switch.on {
  background: #34c759;
}
.toggle-switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s;
}
.toggle-switch.on::after {
  transform: translateX(16px);
}

/* Action buttons */
.action-buttons {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
.action-btn {
  flex: 1;
  padding: 10px;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  text-align: center;
}
.action-btn.primary {
  background: #007aff;
  color: #fff;
}
.action-btn.primary:hover {
  background: #0066d6;
}
.action-btn.secondary {
  background: #f5f5f5;
  color: #333;
  border: 1px solid #ddd;
}
.action-btn.secondary:hover {
  background: #eee;
}
.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Collapsible sections */
.section-toggle {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  background: #f5f5f5;
  border-radius: 8px;
  margin-bottom: 6px;
  cursor: pointer;
  user-select: none;
}
.section-toggle:hover {
  background: #eee;
}
.section-toggle-title {
  font-size: 12px;
  font-weight: 600;
  color: #333;
}
.section-toggle-info {
  font-size: 11px;
  color: #999;
}
.section-body {
  display: none;
  padding: 10px 12px;
  background: #fafafa;
  border-radius: 0 0 8px 8px;
  margin-top: -6px;
  margin-bottom: 6px;
}
.section-body.open {
  display: block;
}

/* Form elements */
.form-group {
  margin-bottom: 8px;
}
.form-group label {
  display: block;
  font-size: 11px;
  color: #666;
  margin-bottom: 3px;
}
.form-group input, .form-group select {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid #ddd;
  border-radius: 6px;
  font-size: 12px;
  outline: none;
}
.form-group input:focus, .form-group select:focus {
  border-color: #007aff;
}
.form-group input[type="password"] {
  font-family: monospace;
}
.btn-sm {
  padding: 5px 10px;
  border: none;
  border-radius: 5px;
  font-size: 11px;
  cursor: pointer;
  font-weight: 500;
}
.btn-sm.primary {
  background: #007aff;
  color: #fff;
}
.btn-sm.primary:hover {
  background: #0066d6;
}
.btn-sm.outline {
  background: none;
  border: 1px solid #007aff;
  color: #007aff;
}
.btn-sm.outline:hover {
  background: #f0f7ff;
}
.btn-row {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

/* Cloud messages */
.cloud-msg {
  font-size: 11px;
  padding: 6px 8px;
  border-radius: 4px;
  margin-top: 4px;
}
.cloud-msg.info { color: #007aff; background: #f0f7ff; }
.cloud-msg.error { color: #ff3b30; background: #fff0f0; }
.cloud-msg.success { color: #34c759; background: #f0fff0; }

/* Sync log */
.log-entry {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 0;
  border-bottom: 1px solid #eee;
  font-size: 11px;
}
.log-entry:last-child { border-bottom: none; }
.log-time { color: #999; }
.log-action { color: #555; font-weight: 500; }
.log-status { font-size: 10px; }
.log-status.success { color: #34c759; }
.log-status.error { color: #ff3b30; }

/* Setup guide */
.setup-guide {
  text-align: center;
  padding: 20px 0;
}
.setup-guide p {
  font-size: 12px;
  color: #666;
  margin-bottom: 8px;
}
```

- [ ] **Step 2: Add cloud-tab.css to popup.html**

Add this line in the `<head>` section of `popup.html`, after the existing `<style>` block:
```html
<link rel="stylesheet" href="cloud-tab.css">
```

- [ ] **Step 3: Create cloud-tab.js**

```javascript
// cloud-tab.js — Cloud sync tab UI logic

let cloudInitialized = false;
let activeSection = null;

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}

export async function initCloudTab() {
  if (cloudInitialized) return;
  cloudInitialized = true;

  const container = document.getElementById("cloud-content");
  const status = await sendMessage({ type: "cloudGetStatus" });

  if (!status.configured) {
    renderSetupGuide(container);
  } else {
    renderCloudUI(container, status);
  }
}

function renderSetupGuide(container) {
  container.innerHTML = `
    <div class="setup-guide">
      <p>请先配置加密密钥和存储后端以启用云同步。</p>
      <div class="section-toggle" data-section="key-setup">
        <span class="section-toggle-title">🔑 配置加密密钥</span>
        <span class="section-toggle-info">必填 ›</span>
      </div>
      <div class="section-body" id="section-key-setup">
        <div class="form-group">
          <label>选择密钥方式</label>
          <select id="keyType">
            <option value="random">自动生成（推荐）</option>
            <option value="password">从密码派生</option>
            <option value="import">导入已有密钥</option>
          </select>
        </div>
        <div id="key-password-input" style="display:none">
          <div class="form-group">
            <label>输入密码</label>
            <input type="password" id="keyPassword" placeholder="输入密码">
          </div>
        </div>
        <div id="key-import-input" style="display:none">
          <div class="form-group">
            <label>粘贴 Base64 密钥</label>
            <input type="text" id="keyImport" placeholder="粘贴导出的密钥字符串">
          </div>
        </div>
        <div class="btn-row">
          <button class="btn-sm primary" id="generateKeyBtn">生成密钥</button>
        </div>
        <div id="keyMsg"></div>
      </div>

      <div class="section-toggle" data-section="storage-setup" style="margin-top:6px">
        <span class="section-toggle-title">⚙️ 配置存储后端</span>
        <span class="section-toggle-info">必填 ›</span>
      </div>
      <div class="section-body" id="section-storage-setup">
        <div class="form-group">
          <label>后端类型</label>
          <select id="storageType">
            <option value="gist">GitHub Gist</option>
            <option value="webdav">WebDAV</option>
          </select>
        </div>
        <div id="gist-config">
          <div class="form-group">
            <label>GitHub Token</label>
            <input type="password" id="gistToken" placeholder="ghp_xxxxx（需要 gist 权限）">
          </div>
        </div>
        <div id="webdav-config" style="display:none">
          <div class="form-group">
            <label>WebDAV URL</label>
            <input type="text" id="webdavUrl" placeholder="https://dav.jianguoyun.com/dav/">
          </div>
          <div class="form-group">
            <label>用户名</label>
            <input type="text" id="webdavUser" placeholder="user@example.com">
          </div>
          <div class="form-group">
            <label>密码 / 应用专用密码</label>
            <input type="password" id="webdavPass" placeholder="应用专用密码">
          </div>
          <div class="form-group">
            <label>文件路径</label>
            <input type="text" id="webdavPath" placeholder="/cookie-sync/cookies.enc" value="/cookie-sync/cookies.enc">
          </div>
        </div>
        <div class="btn-row">
          <button class="btn-sm primary" id="testConnBtn">测试连接</button>
          <button class="btn-sm outline" id="saveStorageBtn">保存配置</button>
        </div>
        <div id="storageMsg"></div>
      </div>
    </div>
  `;

  bindSetupEvents(container);
}

function renderCloudUI(container, status) {
  const lastSyncText = status.lastSyncTime
    ? new Date(status.lastSyncTime).toLocaleString()
    : "从未同步";

  container.innerHTML = `
    <!-- Status card -->
    <div class="cloud-card">
      <div class="cloud-card-header">
        <span class="cloud-card-title">同步状态</span>
        <span class="cloud-status-badge ${status.configured ? 'connected' : 'disconnected'}">${status.configured ? '● 已配置' : '● 未配置'}</span>
      </div>
      <div class="cloud-card-subtitle">后端: ${status.storageType === 'gist' ? 'GitHub Gist' : 'WebDAV'}</div>
      <div class="cloud-card-subtitle">上次同步: ${lastSyncText}</div>
    </div>

    <!-- Sync mode -->
    <div class="cloud-card">
      <div class="cloud-card-title" style="margin-bottom:6px">同步模式</div>
      <div class="mode-selector">
        <div class="mode-btn ${status.mode === 'push-only' ? 'active' : ''}" data-mode="push-only">⬆ 仅推送</div>
        <div class="mode-btn ${status.mode === 'pull-only' ? 'active' : ''}" data-mode="pull-only">⬇ 仅拉取</div>
        <div class="mode-btn ${status.mode === 'bidirectional' ? 'active' : ''}" data-mode="bidirectional">↕ 双向</div>
      </div>
      <div class="schedule-row">
        <label>定时同步</label>
        <div class="toggle-switch ${status.scheduleEnabled ? 'on' : ''}" id="scheduleToggle"></div>
        <input type="number" id="scheduleInterval" value="${status.scheduleInterval || 30}" min="5" ${!status.scheduleEnabled ? 'disabled' : ''}>
        <span>分钟</span>
      </div>
    </div>

    <!-- Action buttons -->
    <div class="action-buttons" id="actionButtons"></div>

    <!-- Key management -->
    <div class="section-toggle" data-section="key">
      <span class="section-toggle-title">🔑 加密密钥</span>
      <span class="section-toggle-info">已配置 ›</span>
    </div>
    <div class="section-body" id="section-key">
      <div class="btn-row">
        <button class="btn-sm outline" id="exportKeyBtn">导出密钥</button>
      </div>
      <div id="keyManageMsg"></div>
    </div>

    <!-- Storage config -->
    <div class="section-toggle" data-section="storage">
      <span class="section-toggle-title">⚙️ 后端配置</span>
      <span class="section-toggle-info">${status.storageType === 'gist' ? 'Gist' : 'WebDAV'} ›</span>
    </div>
    <div class="section-body" id="section-storage"></div>

    <!-- Sync log -->
    <div class="section-toggle" data-section="log">
      <span class="section-toggle-title">📋 同步日志</span>
      <span class="section-toggle-info">查看详情 ›</span>
    </div>
    <div class="section-body" id="section-log"></div>
  `;

  renderActionButtons(status.mode);
  bindCloudEvents(container, status);
}

function renderActionButtons(mode) {
  const container = document.getElementById("actionButtons");
  if (mode === "push-only") {
    container.innerHTML = `<button class="action-btn primary" id="pushBtn">⬆ 立即推送</button>`;
  } else if (mode === "pull-only") {
    container.innerHTML = `<button class="action-btn primary" id="pullBtn">⬇ 立即拉取</button>`;
  } else {
    container.innerHTML = `<button class="action-btn primary" id="syncBtn">↕ 立即同步</button>`;
  }
}

function bindSetupEvents(container) {
  // Section toggles
  container.querySelectorAll(".section-toggle").forEach((el) => {
    el.addEventListener("click", () => {
      const sectionId = `section-${el.dataset.section}`;
      const body = document.getElementById(sectionId);
      if (body) {
        body.classList.toggle("open");
        el.querySelector(".section-toggle-info").textContent =
          body.classList.contains("open") ? "收起 ▾" : "必填 ›";
      }
    });
  });

  // Key type selector
  const keyTypeSelect = document.getElementById("keyType");
  keyTypeSelect.addEventListener("change", () => {
    document.getElementById("key-password-input").style.display =
      keyTypeSelect.value === "password" ? "block" : "none";
    document.getElementById("key-import-input").style.display =
      keyTypeSelect.value === "import" ? "block" : "none";
    document.getElementById("generateKeyBtn").textContent =
      keyTypeSelect.value === "random" ? "生成密钥" :
      keyTypeSelect.value === "password" ? "派生密钥" : "导入密钥";
  });

  // Generate key
  document.getElementById("generateKeyBtn").addEventListener("click", async () => {
    const msg = document.getElementById("keyMsg");
    const type = keyTypeSelect.value;
    try {
      let resp;
      if (type === "random") {
        resp = await sendMessage({ type: "cloudGenerateKey" });
      } else if (type === "password") {
        const password = document.getElementById("keyPassword").value;
        if (!password) { msg.innerHTML = '<div class="cloud-msg error">请输入密码</div>'; return; }
        resp = await sendMessage({ type: "cloudDeriveKey", password });
      } else {
        const key = document.getElementById("keyImport").value.trim();
        if (!key) { msg.innerHTML = '<div class="cloud-msg error">请粘贴密钥</div>'; return; }
        resp = await sendMessage({ type: "cloudImportKey", key });
      }
      if (resp?.ok) {
        msg.innerHTML = '<div class="cloud-msg success">密钥已配置！请安全保存导出的密钥以便在其他设备导入。</div>';
      } else {
        msg.innerHTML = `<div class="cloud-msg error">${resp?.error || "密钥配置失败"}</div>`;
      }
    } catch (err) {
      msg.innerHTML = `<div class="cloud-msg error">${err.message}</div>`;
    }
  });

  // Storage type selector
  const storageTypeSelect = document.getElementById("storageType");
  storageTypeSelect.addEventListener("change", () => {
    document.getElementById("gist-config").style.display =
      storageTypeSelect.value === "gist" ? "block" : "none";
    document.getElementById("webdav-config").style.display =
      storageTypeSelect.value === "webdav" ? "block" : "none";
  });

  // Test connection
  document.getElementById("testConnBtn").addEventListener("click", async () => {
    const msg = document.getElementById("storageMsg");
    msg.innerHTML = '<div class="cloud-msg info">测试连接中...</div>';
    try {
      const type = storageTypeSelect.value;
      let config = {};
      if (type === "gist") {
        config = { token: document.getElementById("gistToken").value };
      } else {
        config = {
          url: document.getElementById("webdavUrl").value,
          username: document.getElementById("webdavUser").value,
          password: document.getElementById("webdavPass").value,
          filePath: document.getElementById("webdavPath").value,
        };
      }
      await sendMessage({ type: "cloudUpdateStorage", config: { type, config } });
      const resp = await sendMessage({ type: "cloudTestConnection" });
      msg.innerHTML = resp?.ok
        ? '<div class="cloud-msg success">连接成功！</div>'
        : '<div class="cloud-msg error">连接失败，请检查配置。</div>';
    } catch (err) {
      msg.innerHTML = `<div class="cloud-msg error">${err.message}</div>`;
    }
  });

  // Save storage config
  document.getElementById("saveStorageBtn").addEventListener("click", async () => {
    const msg = document.getElementById("storageMsg");
    const type = storageTypeSelect.value;
    let config = {};
    if (type === "gist") {
      config = { token: document.getElementById("gistToken").value };
      if (!config.token) { msg.innerHTML = '<div class="cloud-msg error">请输入 GitHub Token</div>'; return; }
    } else {
      config = {
        url: document.getElementById("webdavUrl").value,
        username: document.getElementById("webdavUser").value,
        password: document.getElementById("webdavPass").value,
        filePath: document.getElementById("webdavPath").value || "/cookie-sync/cookies.enc",
      };
      if (!config.url || !config.username) { msg.innerHTML = '<div class="cloud-msg error">请填写必填字段</div>'; return; }
      // Request host permission for WebDAV URL
      try {
        const webdavOrigin = new URL(config.url).origin;
        const granted = await new Promise((resolve) => {
          chrome.permissions.request({ origins: [webdavOrigin + "/*"] }, (result) => {
            resolve(result !== false);
          });
        });
        if (!granted) {
          msg.innerHTML = '<div class="cloud-msg error">需要授予 WebDAV 服务器访问权限</div>';
          return;
        }
      } catch (err) {
        msg.innerHTML = `<div class="cloud-msg error">权限请求失败: ${err.message}</div>`;
        return;
      }
    }
    try {
      await sendMessage({ type: "cloudUpdateStorage", config: { type, config } });
      msg.innerHTML = '<div class="cloud-msg success">配置已保存。</div>';
      // Re-render to show full cloud UI
      setTimeout(() => {
        cloudInitialized = false;
        initCloudTab();
      }, 1000);
    } catch (err) {
      msg.innerHTML = `<div class="cloud-msg error">${err.message}</div>`;
    }
  });
}

function bindCloudEvents(container, status) {
  // Section toggles
  container.querySelectorAll(".section-toggle").forEach((el) => {
    el.addEventListener("click", async () => {
      const sectionId = `section-${el.dataset.section}`;
      const body = document.getElementById(sectionId);
      if (!body) return;
      const isOpen = body.classList.contains("open");
      body.classList.toggle("open");
      el.querySelector(".section-toggle-info").textContent =
        isOpen ? `${el.dataset.section === 'key' ? '已配置' : el.dataset.section === 'storage' ? (status.storageType === 'gist' ? 'Gist' : 'WebDAV') : '查看详情'} ›` : "收起 ▾";

      if (!isOpen && el.dataset.section === "log") {
        await loadSyncLog(body);
      }
      if (!isOpen && el.dataset.section === "storage") {
        await loadStorageConfig(body, status);
      }
    });
  });

  // Mode selector
  container.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      container.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      await sendMessage({ type: "cloudUpdateSettings", settings: { mode: btn.dataset.mode } });
      renderActionButtons(btn.dataset.mode);
      bindSyncActions();
    });
  });
  bindSyncActions();

  // Schedule toggle
  const scheduleToggle = document.getElementById("scheduleToggle");
  const intervalInput = document.getElementById("scheduleInterval");
  scheduleToggle.addEventListener("click", async () => {
    const isOn = scheduleToggle.classList.toggle("on");
    intervalInput.disabled = !isOn;
    await sendMessage({ type: "cloudUpdateSettings", settings: { scheduleEnabled: isOn } });
  });

  // Schedule interval change
  intervalInput.addEventListener("change", async () => {
    const val = parseInt(intervalInput.value, 10);
    if (val >= 5) {
      await sendMessage({ type: "cloudUpdateSettings", settings: { scheduleIntervalMinutes: val } });
    }
  });

  // Export key
  document.getElementById("exportKeyBtn")?.addEventListener("click", async () => {
    const msg = document.getElementById("keyManageMsg");
    try {
      const resp = await sendMessage({ type: "cloudExportKey" });
      if (resp?.ok && resp.key) {
        // Show key in a selectable text area
        msg.innerHTML = `<div class="cloud-msg info" style="word-break:break-all;"><strong>密钥（请安全保存）：</strong><br><input style="width:100%;font-family:monospace;font-size:10px;padding:4px;margin-top:4px;" value="${resp.key}" readonly onclick="this.select()"></div>`;
      }
    } catch (err) {
      msg.innerHTML = `<div class="cloud-msg error">${err.message}</div>`;
    }
  });
}

function bindSyncActions() {
  document.getElementById("pushBtn")?.addEventListener("click", () => doSync("cloudPush", "pushBtn"));
  document.getElementById("pullBtn")?.addEventListener("click", () => doSync("cloudPull", "pullBtn"));
  document.getElementById("syncBtn")?.addEventListener("click", () => doSync("cloudSync", "syncBtn"));
}

async function doSync(type, btnId) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "同步中...";
  try {
    const resp = await sendMessage({ type });
    if (resp?.success) {
      btn.textContent = "✓ 成功";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
        // Refresh status
        cloudInitialized = false;
        initCloudTab();
      }, 1500);
    } else {
      btn.textContent = originalText;
      btn.disabled = false;
      alert(`同步失败: ${resp?.error || "未知错误"}`);
    }
  } catch (err) {
    btn.textContent = originalText;
    btn.disabled = false;
    alert(`同步失败: ${err.message}`);
  }
}

async function loadSyncLog(container) {
  try {
    const resp = await sendMessage({ type: "cloudGetSyncLog" });
    const log = resp?.log || [];
    if (log.length === 0) {
      container.innerHTML = '<div style="font-size:11px;color:#999;text-align:center;padding:8px;">暂无同步记录</div>';
      return;
    }
    container.innerHTML = log.map((entry) => {
      const time = new Date(entry.time).toLocaleString();
      const actionMap = { push: "推送", pull: "拉取", sync: "双向" };
      return `
        <div class="log-entry">
          <span class="log-time">${time}</span>
          <span class="log-action">${actionMap[entry.action] || entry.action}</span>
          <span class="log-status ${entry.status}">${entry.status === "success" ? "成功" : "失败"}</span>
        </div>`;
    }).join("");
  } catch {
    container.innerHTML = '<div style="font-size:11px;color:#ff3b30;">加载日志失败</div>';
  }
}

async function loadStorageConfig(container, status) {
  const cfg = await sendMessage({ type: "cloudGetStatus" });
  if (status.storageType === "gist") {
    container.innerHTML = `
      <div class="form-group">
        <label>GitHub Token</label>
        <input type="password" id="editGistToken" value="${cfg?.storageType === 'gist' ? '●●●●●●●●' : ''}" placeholder="ghp_xxxxx">
      </div>
      <div class="form-group">
        <label>Gist ID</label>
        <input type="text" value="${cfg?.gistId || '自动创建'}" readonly style="background:#f0f0f0">
      </div>
      <div class="btn-row">
        <button class="btn-sm primary" id="updateGistBtn">更新</button>
      </div>
      <div id="storageUpdateMsg"></div>
    `;
    document.getElementById("updateGistBtn")?.addEventListener("click", async () => {
      const token = document.getElementById("editGistToken").value;
      if (token && !token.startsWith("●")) {
        await sendMessage({ type: "cloudUpdateStorage", config: { type: "gist", config: { token } } });
        document.getElementById("storageUpdateMsg").innerHTML = '<div class="cloud-msg success">已更新</div>';
      }
    });
  } else {
    container.innerHTML = `
      <div style="font-size:11px;color:#999;text-align:center;padding:8px;">
        WebDAV 配置在初始设置时已保存。如需修改，请删除配置后重新设置。
      </div>`;
  }
}
```

- [ ] **Step 4: Add CSS link to popup.html**

In `popup.html`, add before `</head>`:
```html
<link rel="stylesheet" href="cloud-tab.css">
```

- [ ] **Step 5: Verify full cloud sync flow**

1. Reload extension
2. Open popup → click "☁️ 云同步" tab
3. Configure encryption key (select "自动生成" → click "生成密钥")
4. Configure storage backend (select "GitHub Gist" → enter token → "测试连接" → "保存配置")
5. After setup, cloud UI should show with sync status card
6. Click "⬆ 立即推送" to test push
7. Verify the encrypted data appears in your GitHub Gist

- [ ] **Step 6: Commit**

```bash
git add cookie-sync-extension/popup/cloud-tab.css cookie-sync-extension/popup/cloud-tab.js cookie-sync-extension/popup/popup.html
git commit -m "feat: add cloud sync tab UI with full configuration and sync controls"
```

---

## Task 12: End-to-End Testing and Final Cleanup

**Files:**
- Verify all files

- [ ] **Step 1: Test push flow end-to-end**

1. Add a domain to whitelist (e.g., `github.com`)
2. Go to cloud sync tab
3. Configure key and storage backend
4. Select "仅推送" mode
5. Click "立即推送"
6. Verify: success message, last sync time updated
7. Check Gist/WebDAV: encrypted data file exists

- [ ] **Step 2: Test pull flow end-to-end**

1. On the same browser, click "立即拉取"
2. Or on a different browser with the same extension configured:
   - Import the same encryption key
   - Configure the same storage backend
   - Click "立即拉取"
3. Verify: cookies are restored in the new browser

- [ ] **Step 3: Test bidirectional sync**

1. Switch mode to "双向"
2. Make a change on browser A (e.g., add a cookie)
3. Click "立即同步" on browser A
4. On browser B, click "立即同步"
5. Verify: browser B has the updated cookie

- [ ] **Step 4: Test scheduled sync**

1. Enable schedule toggle
2. Set interval to minimum (5 minutes)
3. Wait for auto-sync to trigger
4. Check sync log for automatic entries

- [ ] **Step 5: Test error scenarios**

1. Enter wrong GitHub token → "测试连接" should fail
2. Delete encryption key → sync should fail with clear error
3. Empty whitelist → push should report "No data to sync"
4. Disable network → sync should fail gracefully

- [ ] **Step 6: Update extension version**

In `manifest.json`, update version:
```json
"version": "1.1.0"
```

- [ ] **Step 7: Final commit**

```bash
git add cookie-sync-extension/manifest.json
git commit -m "chore: bump version to 1.1.0 for cloud sync feature"
```
