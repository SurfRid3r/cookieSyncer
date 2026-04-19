# 域名与权限管理重设计 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构权限模型为 `<all_urls>` + 统一域名管理，支持本地获取和云端同步两个正交维度。

**Architecture:** 用新的 `cloudDomains` 数据模型替代旧 `whitelist`，每个域名有两个独立属性：`localAccess`（布尔）和 `cloudSync`（enabled/pending/disabled）。云端数据增加明文 `domain_list` 字段。同步引擎按域名状态过滤推送/拉取。Popup UI 分两组展示域名状态。

**Tech Stack:** Chrome Extension Manifest V3, chrome.storage.local, chrome.cookies API, WebSocket, AES-256-GCM (Web Crypto)

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `cookie-sync-extension/manifest.json` | 权限声明改为 `<all_urls>` |
| 重写 | `cookie-sync-extension/background/whitelist.js` | 统一域名管理模块（cloudDomains） |
| 修改 | `cookie-sync-extension/background/cookie-ops.js` | 用新域名管理过滤 daemon 请求 |
| 修改 | `cookie-sync-extension/background/main.js` | 新消息处理器 + 移除权限 API 调用 + 数据迁移 |
| 修改 | `cookie-sync-extension/background/cloud/sync-engine.js` | push/pull 按域名状态过滤 + domain_list 同步 |
| 修改 | `cookie-sync-extension/background/cloud/data-collector.js` | 按传入域名列表收集/写入 |
| 修改 | `cookie-sync-extension/background/cloud/gist-adapter.js` | 上传/下载携带 domain_list |
| 修改 | `cookie-sync-extension/background/cloud/webdav-adapter.js` | 上传/下载携带 domain_list |
| 重写 | `cookie-sync-extension/popup/popup.js` | 统一域名管理 UI（本地获取开关 + 云端同步状态） |
| 修改 | `cookie-sync-extension/popup/cloud-tab.js` | 移除权限请求逻辑 + pending 域名展示 |
| 修改 | `cookie-sync-extension/popup/popup.html` | 更新 Tab 标签 + 域名管理区域 |

---

### Task 1: 修改 manifest.json 权限声明

**Files:**
- Modify: `cookie-sync-extension/manifest.json`

- [ ] **Step 1: 更新权限声明**

将 `optional_host_permissions` 替换为 `<all_urls>` 的 `host_permissions`：

```json
{
  "manifest_version": 3,
  "name": "Cookie Sync",
  "version": "1.2.0",
  "description": "Syncs browser cookies with a local daemon over WebSocket and cloud storage. User-controlled domain management for security.",
  "permissions": [
    "cookies",
    "storage",
    "alarms",
    "scripting"
  ],
  "host_permissions": [
    "<all_urls>"
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

变更点：
- 移除 `optional_host_permissions` 整个字段
- `host_permissions` 中 `<all_urls>` 替代原来的 localhost + github api（`<all_urls>` 已包含这些）
- 版本号 bump 到 1.2.0

- [ ] **Step 2: Commit**

```bash
git add cookie-sync-extension/manifest.json
git commit -m "refactor: change to <all_urls> host permission for simplified access"
```

---

### Task 2: 重写 whitelist.js 为统一域名管理模块

**Files:**
- Rewrite: `cookie-sync-extension/background/whitelist.js`

这是核心模块。重写为管理 `cloudDomains` 数据，提供 `localAccess` 和 `cloudSync` 两维度的查询接口。

- [ ] **Step 1: 重写 whitelist.js**

完整替换文件内容：

```javascript
// whitelist.js — Unified domain management with cloudDomains
// Replaces old whitelist. Each domain has:
//   localAccess: boolean (allowed for local daemon WebSocket access)
//   cloudSync: "enabled" | "pending" | "disabled"

import { normalizeDomain } from "./domain-utils.js";

const STORAGE_KEY = "cloudDomains";
const LEGACY_KEY = "allowedDomains";

let cached = {}; // { "example.com": { localAccess: true, cloudSync: "enabled" } }

export { normalizeDomain };

// --- Init & Migration ---

export async function init() {
  const result = await chrome.storage.local.get([STORAGE_KEY, LEGACY_KEY]);

  if (result[STORAGE_KEY]) {
    cached = result[STORAGE_KEY].domains || {};
  }

  // Migrate from legacy whitelist (chrome.storage.sync)
  if (Object.keys(cached).length === 0) {
    const syncResult = await chrome.storage.sync.get(LEGACY_KEY);
    const legacy = syncResult[LEGACY_KEY] || [];
    if (legacy.length > 0) {
      console.log("[whitelist] Migrating", legacy.length, "domains from legacy whitelist");
      for (const domain of legacy) {
        const d = normalizeDomain(domain);
        if (d && !cached[d]) {
          cached[d] = { localAccess: true, cloudSync: "enabled" };
        }
      }
      await save();
      await chrome.storage.sync.remove(LEGACY_KEY);
      console.log("[whitelist] Migration complete");
    }
  }
}

// --- Queries ---

export function isAllowed(domain) {
  if (!domain) return false;
  const d = normalizeDomain(domain);
  if (!d) return false;
  return getDomainCandidates(d).some((candidate) => {
    const entry = cached[candidate];
    return entry && entry.localAccess === true;
  });
}

export function isCloudEnabled(domain) {
  if (!domain) return false;
  const d = normalizeDomain(domain);
  if (!d) return false;
  return getDomainCandidates(d).some((candidate) => {
    const entry = cached[candidate];
    return entry && entry.cloudSync === "enabled";
  });
}

export function getAllowedDomains() {
  return Object.keys(cached).sort();
}

export function getLocalAccessDomains() {
  return Object.entries(cached)
    .filter(([, v]) => v.localAccess)
    .map(([k]) => k)
    .sort();
}

export function getCloudEnabledDomains() {
  return Object.entries(cached)
    .filter(([, v]) => v.cloudSync === "enabled")
    .map(([k]) => k)
    .sort();
}

export function getPendingDomains() {
  return Object.entries(cached)
    .filter(([, v]) => v.cloudSync === "pending")
    .map(([k]) => k)
    .sort();
}

export function getDomainStatus(domain) {
  const d = normalizeDomain(domain);
  return cached[d] || null;
}

export function getAllDomainEntries() {
  // Returns full entries for UI display
  return Object.entries(cached)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([domain, entry]) => ({ domain, ...entry }));
}

// --- Mutations ---

export async function addDomain(domain, options = {}) {
  const d = normalizeDomain(domain);
  if (!d) return { ok: false, error: "Invalid domain" };
  if (cached[d]) return { ok: false, error: "Domain already exists" };

  cached[d] = {
    localAccess: options.localAccess !== undefined ? options.localAccess : true,
    cloudSync: options.cloudSync || "enabled",
  };
  await save();
  return { ok: true };
}

export async function removeDomain(domain) {
  const d = normalizeDomain(domain);
  if (!d) return { ok: false, error: "Invalid domain" };
  if (!cached[d]) return { ok: false, error: "Domain not found" };

  delete cached[d];
  await save();
  return { ok: true };
}

export async function setLocalAccess(domain, value) {
  const d = normalizeDomain(domain);
  if (!d || !cached[d]) return { ok: false, error: "Domain not found" };
  cached[d].localAccess = !!value;
  await save();
  return { ok: true };
}

export async function setCloudSync(domain, status) {
  const d = normalizeDomain(domain);
  if (!d || !cached[d]) return { ok: false, error: "Domain not found" };
  if (!["enabled", "pending", "disabled"].includes(status)) {
    return { ok: false, error: "Invalid status" };
  }
  cached[d].cloudSync = status;
  await save();
  return { ok: true };
}

export async function addPendingDomains(domains) {
  // Add domains from cloud that are not yet locally known
  const added = [];
  for (const domain of domains) {
    const d = normalizeDomain(domain);
    if (d && !cached[d]) {
      cached[d] = { localAccess: false, cloudSync: "pending" };
      added.push(d);
    }
  }
  if (added.length > 0) await save();
  return { ok: true, added };
}

export async function getDomainList() {
  // Returns the list for cloud sync domain_list field
  return Object.keys(cached).filter((d) => cached[d].cloudSync === "enabled").sort();
}

// --- Internal ---

async function save() {
  await chrome.storage.local.set({ [STORAGE_KEY]: { domains: cached } });
}

function getDomainCandidates(domain) {
  const parts = domain.split(".");
  return parts.map((_, index) => parts.slice(index).join("."));
}
```

关键变更：
- 存储从 `chrome.storage.sync` → `chrome.storage.local`
- 数据结构从 `Set<string>` → `{ [domain]: { localAccess, cloudSync } }`
- 新增 `isCloudEnabled()`、`setLocalAccess()`、`setCloudSync()`、`addPendingDomains()` 等接口
- 自动从旧 `allowedDomains` 迁移
- 移除所有 `chrome.permissions` API 调用

- [ ] **Step 2: Commit**

```bash
git add cookie-sync-extension/background/whitelist.js
git commit -m "refactor: rewrite whitelist.js as unified domain management with cloudDomains"
```

---

### Task 3: 更新 cookie-ops.js

**Files:**
- Modify: `cookie-sync-extension/background/cookie-ops.js`

- [ ] **Step 1: 简化 cookie-ops.js**

移除权限相关逻辑，只保留基于 `localAccess` 的过滤：

```javascript
// cookie-ops.js — Cookie read operations with domain access validation

import * as whitelist from "./whitelist.js";

export async function handleGetCookies(params) {
  if (!params.domain && !params.url) {
    return { ok: false, error: "Cookie scope required: provide domain or url" };
  }

  const domain = params.domain || new URL(params.url).hostname;

  if (!whitelist.isAllowed(domain)) {
    return { ok: false, error: `Domain not allowed: ${domain}` };
  }

  try {
    const cookies = await chrome.cookies.getAll({ domain });
    return {
      ok: true,
      data: cookies.filter((c) => whitelist.isAllowed(c.domain)).map(serializeCookie),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function handleListAllowed() {
  return { ok: true, data: whitelist.getLocalAccessDomains() };
}

function serializeCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate,
  };
}
```

变更：
- `handleListAllowed` 返回 `getLocalAccessDomains()` 而非 `getAllowedDomains()`
- `isAllowed` 内部已基于 `localAccess` 字段，无需额外改动

- [ ] **Step 2: Commit**

```bash
git add cookie-sync-extension/background/cookie-ops.js
git commit -m "refactor: update cookie-ops to use new domain management"
```

---

### Task 4: 更新 main.js

**Files:**
- Modify: `cookie-sync-extension/background/main.js`

- [ ] **Step 1: 更新 main.js 消息处理器**

移除权限相关处理器（`pendingDomain`、`chrome.permissions.onAdded`），新增域名状态管理处理器：

```javascript
// main.js — Entry point: initialization, alarm, command routing, popup messages

import * as connection from "./connection.js";
import * as cookieOps from "./cookie-ops.js";
import * as whitelist from "./whitelist.js";
import * as cloudSync from "./cloud/sync-engine.js";

let initialized = false;
let initPromise = null;

const popupHandlers = {
  getStatus: () => connection.getStatus(),
  popupOpened: async () => {
    await ensureReady({ resetReconnect: true });
    return connection.getStatus();
  },
  getDomains: async () => {
    await ensureReady();
    return { domains: whitelist.getAllowedDomains(), entries: whitelist.getAllDomainEntries() };
  },
  addDomain: async ({ domain }) => {
    await ensureReady();
    return whitelist.addDomain(domain);
  },
  removeDomain: async ({ domain }) => {
    await ensureReady();
    return whitelist.removeDomain(domain);
  },
  setLocalAccess: async ({ domain, value }) => {
    await ensureReady();
    return whitelist.setLocalAccess(domain, value);
  },
  setCloudSync: async ({ domain, status }) => {
    await ensureReady();
    return whitelist.setCloudSync(domain, status);
  },

  // Cloud sync handlers
  cloudGetStatus: async () => {
    await ensureReady();
    const status = cloudSync.getStatus();
    console.log("[cloud-sync] getStatus: configured:", status.configured, "hasKey:", status.hasKey, "storage:", status.storageType);
    return status;
  },
  cloudPush: async () => {
    console.log("[cloud-sync] cloudPush handler");
    await ensureReady();
    try {
      return await cloudSync.push();
    } catch (err) {
      console.error("[cloud-sync] cloudPush failed:", err.message);
      await cloudSync.logError("push", err.message);
      throw err;
    }
  },
  cloudPull: async () => {
    console.log("[cloud-sync] cloudPull handler");
    await ensureReady();
    try {
      return await cloudSync.pull();
    } catch (err) {
      console.error("[cloud-sync] cloudPull failed:", err.message);
      await cloudSync.logError("pull", err.message);
      throw err;
    }
  },
  cloudSync: async () => {
    console.log("[cloud-sync] cloudSync handler");
    await ensureReady();
    try {
      return await cloudSync.sync();
    } catch (err) {
      console.error("[cloud-sync] cloudSync failed:", err.message);
      await cloudSync.logError("sync", err.message);
      throw err;
    }
  },
  cloudTestConnection: async () => {
    await ensureReady();
    const ok = await cloudSync.testConnection();
    return { ok };
  },
  cloudGenerateKey: async () => {
    await ensureReady();
    const exported = await cloudSync.generateAndStoreKey();
    return { ok: true, key: exported };
  },
  cloudImportKey: async ({ key }) => {
    await ensureReady();
    const exported = await cloudSync.importAndStoreKey(key);
    return { ok: true, key: exported };
  },
  cloudDeriveKey: async ({ password }) => {
    await ensureReady();
    const exported = await cloudSync.deriveAndStoreKey(password);
    return { ok: true, key: exported };
  },
  cloudExportKey: async () => {
    await ensureReady();
    const key = cloudSync.getExportedKey();
    return { ok: true, key };
  },
  cloudUpdateSettings: async ({ settings }) => {
    await ensureReady();
    await cloudSync.updateSettings(settings);
    return { ok: true };
  },
  cloudUpdateStorage: async (msg) => {
    await ensureReady();
    const storageType = msg?.config?.type;
    const storageConfig = msg?.config?.config;
    if (!storageType) return { ok: false, error: "Missing storage type" };
    await cloudSync.updateStorage(storageType, storageConfig);
    return { ok: true };
  },
  cloudGetSyncLog: async () => {
    console.log("[cloud-sync] cloudGetSyncLog handler");
    await ensureReady();
    const log = cloudSync.getSyncLog();
    console.log("[cloud-sync] cloudGetSyncLog returning", log.length, "entries");
    return { log };
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
      sendResponse(msg?.type === "getDomains" ? { domains: [], entries: [], error } : { ok: false, error });
    });
  return msg?.type !== "getStatus";
});

// --- Lifecycle ---
chrome.runtime.onInstalledListener(() => initialize());
chrome.runtime.onStartup.addListener(() => initialize());
```

关键变更：
- 移除 `pendingDomain` 和 `confirmDomain` handler
- 移除 `cloudAddDomains` handler（不再需要权限请求后批量添加）
- 新增 `setLocalAccess`、`setCloudSync` handler
- `addDomain` 简化为直接调用 `whitelist.addDomain`
- `getDomains` 返回额外的 `entries` 数组（包含完整状态信息）
- 移除 `chrome.permissions.onAdded` 监听器
- `chrome.runtime.onInstalled` → `chrome.runtime.onInstalledListener`（修正为正确的 API）

- [ ] **Step 2: Commit**

```bash
git add cookie-sync-extension/background/main.js
git commit -m "refactor: update main.js handlers for unified domain management"
```

---

### Task 5: 更新 data-collector.js

**Files:**
- Modify: `cookie-sync-extension/background/cloud/data-collector.js`

- [ ] **Step 1: 重写 data-collector.js**

`collectAll` 接受域名列表参数而非从 whitelist 全量读取。`writeCookies` 移除权限检查逻辑：

```javascript
// background/cloud/data-collector.js — Collect and write cookies by domain list

import * as whitelist from "../whitelist.js";

/**
 * Collect cookies for specified domains (or cloud-enabled domains if none specified).
 * @param {string[]} [domains] - Optional domain list. Defaults to cloud-enabled domains.
 * @param {object} lastKnown - Last known timestamps for conflict resolution.
 */
export async function collectAll(domains, lastKnown) {
  const targetDomains = domains || whitelist.getCloudEnabledDomains();
  if (targetDomains.length === 0) {
    console.log("[cloud-sync] collectAll: no domains to collect");
    return { cookies: {}, timestamp: Date.now(), domainCount: 0, cookieCount: 0 };
  }
  console.log("[cloud-sync] collectAll: collecting for", targetDomains.length, "domains:", targetDomains.join(", "));

  const now = Date.now();
  const cookiesByDomain = {};
  let totalCookies = 0;

  for (const domain of targetDomains) {
    try {
      const cookies = await chrome.cookies.getAll({ domain });
      const filtered = cookies.filter((c) => whitelist.isCloudEnabled(c.domain));
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
      console.log("[cloud-sync] collectAll:", domain, "->", filtered.length, "cookies");
    } catch (err) {
      console.warn("[cloud-sync] collectAll: failed for", domain, ":", err.message);
    }
  }

  return {
    version: 1,
    timestamp: now,
    cookies: cookiesByDomain,
    domainCount: targetDomains.length,
    cookieCount: totalCookies,
  };
}

/**
 * Write cookies to browser. Filters by cloud-enabled domains only.
 * @param {object} cookiesByDomain - Domain-to-cookies map from merged data.
 */
export async function writeCookies(cookiesByDomain) {
  let written = 0;
  let deleted = 0;

  for (const [domain, cookies] of Object.entries(cookiesByDomain)) {
    // Only write cookies for domains that are cloud-enabled locally
    if (!whitelist.isCloudEnabled(domain)) continue;

    for (const c of cookies) {
      try {
        const url = `http${c.secure ? "s" : ""}://${c.domain.replace(/^\./, "")}${c.path}`;
        if (c.expirationDate && c.expirationDate < Date.now() / 1000) {
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

关键变更：
- `collectAll(lastKnown)` → `collectAll(domains, lastKnown)`，接受域名列表参数
- 过滤条件从 `whitelist.isAllowed` → `whitelist.isCloudEnabled`
- `writeCookies` 移除 `chrome.permissions.getAll` 权限检查
- `writeCookies` 过滤条件改为 `whitelist.isCloudEnabled`
- 返回值移除 `skippedDomains` 字段

- [ ] **Step 2: Commit**

```bash
git add cookie-sync-extension/background/cloud/data-collector.js
git commit -m "refactor: update data-collector to use cloud-enabled domain filtering"
```

---

### Task 6: 更新存储适配器（gist + webdav）

**Files:**
- Modify: `cookie-sync-extension/background/cloud/gist-adapter.js`
- Modify: `cookie-sync-extension/background/cloud/webdav-adapter.js`

- [ ] **Step 1: 更新 gist-adapter.js**

上传时携带 `domain_list`，下载时解析 `domain_list`：

```javascript
// background/cloud/gist-adapter.js — GitHub Gist storage

export function createGistAdapter(config) {
  let gistId = config.gistId || null;
  let token = config.token;
  const filename = "cookie-sync.enc";

  function apiFetch(path, options = {}) {
    const headers = {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      ...options.headers,
    };
    return fetch(`https://api.github.com${path}`, { ...options, headers });
  }

  async function upload(payload, domainList) {
    const body = {
      description: "Cookie Sync encrypted data",
      public: false,
      files: {
        [filename]: { content: payload },
        "domain-list.json": {
          content: JSON.stringify(domainList || [], null, 2),
        },
      },
    };

    if (gistId) {
      const resp = await apiFetch(`/gists/${gistId}`, { method: "PATCH", body: JSON.stringify(body) });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        if (err.message?.includes("401")) throw new Error("authentication failed: token invalid or expired");
        throw new Error(`Gist update failed: ${resp.status} ${err.message || ""}`);
      }
      return true;
    }

    const resp = await apiFetch("/gists", { method: "POST", body: JSON.stringify(body) });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      if (err.message?.includes("401")) throw new Error("authentication failed: token invalid or expired");
      throw new Error(`Gist create failed: ${resp.status} ${err.message || ""}`);
    }
    const data = await resp.json();
    gistId = data.id;
    return gistId;
  }

  async function download() {
    if (!gistId) return null;
    const resp = await apiFetch(`/gists/${gistId}`);
    if (!resp.ok) {
      if (resp.status === 404) return null;
      const err = await resp.json().catch(() => ({}));
      if (err.message?.includes("401")) throw new Error("authentication failed: token invalid or expired");
      throw new Error(`Gist download failed: ${resp.status}`);
    }
    const data = await resp.json();
    const file = data.files?.[filename];
    return file?.content || null;
  }

  async function downloadDomainList() {
    if (!gistId) return [];
    try {
      const resp = await apiFetch(`/gists/${gistId}`);
      if (!resp.ok) return [];
      const data = await resp.json();
      const file = data.files?.["domain-list.json"];
      if (!file?.content) return [];
      return JSON.parse(file.content);
    } catch {
      return [];
    }
  }

  async function getLastModified() {
    if (!gistId) return null;
    const resp = await apiFetch(`/gists/${gistId}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.updated_at ? new Date(data.updated_at).getTime() : null;
  }

  async function testConnection() {
    const resp = await apiFetch("/gists", { method: "POST", body: JSON.stringify({ public: false, files: { "test": { content: "test" } } }) });
    if (resp.ok) {
      const data = await resp.json();
      await apiFetch(`/gists/${data.id}`, { method: "DELETE" });
      return true;
    }
    const err = await resp.json().catch(() => ({}));
    console.error("[gist] Connection test failed:", err.message);
    return false;
  }

  function init(cfg) {
    if (cfg.gistId) gistId = cfg.gistId;
    if (cfg.token) token = cfg.token;
  }

  return { init, upload, download, downloadDomainList, getLastModified, testConnection };
}
```

关键变更：
- `upload(payload)` → `upload(payload, domainList)`，额外写入 `domain-list.json` 文件
- 新增 `downloadDomainList()` 方法，读取明文域名列表
- `init` 支持 `token` 更新

- [ ] **Step 2: 更新 webdav-adapter.js**

上传时携带 `domain_list`，下载时解析：

```javascript
// background/cloud/webdav-adapter.js — WebDAV storage

export function createWebdavAdapter(config) {
  let url = config.url?.replace(/\/$/, "") || "";
  let username = config.username;
  let password = config.password;
  let filePath = config.filePath || "/cookie-sync/cookies.enc";
  const domainListPath = () => {
    const dir = filePath.substring(0, filePath.lastIndexOf("/") + 1);
    return dir + "domain-list.json";
  };

  function headers() {
    return {
      Authorization: "Basic " + btoa(`${username}:${password}`),
      "Content-Type": "application/octet-stream",
    };
  }

  async function ensureDir() {
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    if (!dir) return;
    try {
      await fetch(`${url}${dir}`, { method: "MKCOL", headers: headers() });
    } catch { /* dir may already exist */ }
  }

  async function upload(payload, domainList) {
    await ensureDir();
    const resp = await fetch(`${url}${filePath}`, {
      method: "PUT",
      headers: headers(),
      body: payload,
    });
    if (!resp.ok) {
      if (resp.status === 401) throw new Error("authentication failed");
      throw new Error(`WebDAV upload failed: ${resp.status}`);
    }
    // Upload domain list as separate file
    if (domainList) {
      await fetch(`${url}${domainListPath()}`, {
        method: "PUT",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify(domainList, null, 2),
      }).catch((err) => console.warn("[webdav] Failed to upload domain list:", err));
    }
    return true;
  }

  async function download() {
    const resp = await fetch(`${url}${filePath}`, { headers: headers() });
    if (resp.status === 404) return null;
    if (!resp.ok) {
      if (resp.status === 401) throw new Error("authentication failed");
      throw new Error(`WebDAV download failed: ${resp.status}`);
    }
    return resp.text();
  }

  async function downloadDomainList() {
    try {
      const resp = await fetch(`${url}${domainListPath()}`, { headers: headers() });
      if (!resp.ok) return [];
      const text = await resp.text();
      return JSON.parse(text);
    } catch {
      return [];
    }
  }

  async function getLastModified() {
    const resp = await fetch(`${url}${filePath}`, { method: "HEAD", headers: headers() });
    if (!resp.ok) return null;
    const lastModified = resp.headers.get("Last-Modified");
    return lastModified ? new Date(lastModified).getTime() : null;
  }

  async function testConnection() {
    try {
      const resp = await fetch(`${url}/`, {
        method: "PROPFIND",
        headers: { ...headers(), Depth: "0" },
      });
      return resp.ok || resp.status === 207;
    } catch {
      return false;
    }
  }

  function init(cfg) {
    if (cfg.url) url = cfg.url.replace(/\/$/, "");
    if (cfg.username) username = cfg.username;
    if (cfg.password) password = cfg.password;
    if (cfg.filePath) filePath = cfg.filePath;
  }

  return { init, upload, download, downloadDomainList, getLastModified, testConnection };
}
```

- [ ] **Step 3: Commit**

```bash
git add cookie-sync-extension/background/cloud/gist-adapter.js cookie-sync-extension/background/cloud/webdav-adapter.js
git commit -m "feat: add domain_list upload/download to storage adapters"
```

---

### Task 7: 更新 sync-engine.js

**Files:**
- Modify: `cookie-sync-extension/background/cloud/sync-engine.js`

- [ ] **Step 1: 更新 sync-engine.js**

在 push/pull 中集成域名列表管理和过滤逻辑：

关键变更点（相对于现有文件）：

1. **push()** — 收集时使用 `whitelist.getCloudEnabledDomains()`，上传时携带 `domain_list`
2. **pull()** — 下载后对比 `domain_list`，发现新域名添加为 pending，按 cloudSync=enabled 过滤写入
3. **sync()** — 先 pull 再 push（确保获取最新域名状态后推送）

完整替换 `push()`、`pull()`、`sync()` 方法，其余保持不变：

```javascript
// Replace push() function (around line 42-78):
export async function push() {
  if (!config.isConfigured()) throw new Error("Cloud sync not configured");
  if (!adapter) throw new Error("存储后端未配置");
  console.log("[cloud-sync] push start");
  const lastKnown = await loadLastKnown();
  const data = await dataCollector.collectAll(null, lastKnown);
  console.log("[cloud-sync] push collected:", data.domainCount, "domains,", data.cookieCount, "cookies");
  if (data.cookieCount === 0) {
    throw new Error("没有可同步的数据，请先在域名管理中添加并启用域名");
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
  console.log("[cloud-sync] push uploading, payload size:", payload.length, "bytes");
  const domainList = await whitelist.getDomainList();
  const result = await adapter.upload(payload, domainList);
  if (typeof result === "string" && config.get().storageType === "gist") {
    console.log("[cloud-sync] push created new gist:", result);
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
  console.log("[cloud-sync] push done:", data.domainCount, "domains,", data.cookieCount, "cookies");
  return { success: true, domains: data.domainCount, cookies: data.cookieCount };
}
```

```javascript
// Replace pull() function (around line 80-128):
export async function pull() {
  if (!config.isConfigured()) throw new Error("Cloud sync not configured");
  if (!adapter) throw new Error("存储后端未配置");
  console.log("[cloud-sync] pull start");

  // Step 1: Download and discover new domains
  const remoteDomainList = await adapter.downloadDomainList();
  const { added } = await whitelist.addPendingDomains(remoteDomainList);
  if (added.length > 0) {
    console.log("[cloud-sync] pull discovered new domains:", added.join(", "));
  }

  // Step 2: Download encrypted data
  const encryptedPayload = await adapter.download();
  if (!encryptedPayload) throw new Error("云端暂无数据，请先在另一设备上推送");
  console.log("[cloud-sync] pull downloaded, size:", encryptedPayload.length, "bytes");

  let payload;
  try {
    payload = JSON.parse(encryptedPayload);
  } catch {
    throw new Error("云端数据格式错误");
  }
  console.log("[cloud-sync] pull payload version:", payload.version, "crypto:", payload.crypto);

  let plaintext;
  try {
    plaintext = await crypto.decrypt({ iv: payload.iv, data: payload.data }, cryptoKey);
  } catch {
    throw new Error("解密失败，请确认加密密钥是否正确");
  }
  const remoteData = JSON.parse(plaintext);
  console.log("[cloud-sync] pull remote data:", Object.keys(remoteData.cookies || {}).length, "domains,", remoteData.cookieCount || 0, "cookies");

  // Step 3: Collect local data for conflict resolution
  const lastKnown = await loadLastKnown();
  const localData = await dataCollector.collectAll(null, lastKnown);
  console.log("[cloud-sync] pull local data:", localData.domainCount, "domains,", localData.cookieCount, "cookies");

  // Step 4: Resolve conflicts
  const { merged, stats } = conflict.resolve(localData, remoteData, lastKnown);
  console.log("[cloud-sync] pull merged:", Object.keys(merged.cookies).length, "domains, stats:", JSON.stringify(stats));

  // Step 5: Write only cloud-enabled domains
  const writeResult = await dataCollector.writeCookies(merged.cookies);
  console.log("[cloud-sync] pull write result: written:", writeResult.written, "deleted:", writeResult.deleted);
  await saveLastKnown(merged);

  await config.addSyncLogEntry({
    time: Date.now(),
    action: "pull",
    status: "success",
    domains: Object.keys(merged.cookies).length,
    cookies: writeResult.written,
  });

  const result = {
    success: true,
    domains: Object.keys(merged.cookies).length,
    ...stats,
    written: writeResult.written,
    deleted: writeResult.deleted,
    newDomains: added,
  };
  console.log("[cloud-sync] pull done");
  return result;
}
```

```javascript
// Replace sync() function (around line 130-140):
export async function sync() {
  if (!config.isConfigured()) throw new Error("Cloud sync not configured");
  // Pull first to discover new domains, then push local changes
  await pull();
  await push();
  await config.addSyncLogEntry({
    time: Date.now(),
    action: "sync",
    status: "success",
  });
  return { success: true };
}
```

还需要在文件顶部添加 whitelist import（当前文件没有导入 whitelist）：

```javascript
// Add to imports at top of file:
import * as whitelist from "../whitelist.js";
```

- [ ] **Step 2: Commit**

```bash
git add cookie-sync-extension/background/cloud/sync-engine.js
git commit -m "feat: integrate domain_list sync and pending domain discovery in sync engine"
```

---

### Task 8: 重写 popup.js — 统一域名管理 UI

**Files:**
- Rewrite: `cookie-sync-extension/popup/popup.js`

- [ ] **Step 1: 重写 popup.js**

展示统一域名列表，每个域名显示两个控制开关：

```javascript
// popup.js — Popup logic: tab switching, unified domain management

import { normalizeDomain, getRootDomain } from "../background/domain-utils.js";
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

let allEntries = [];
let groupedData = [];
let currentPage = 1;
let expandedGroups = new Set();
let isAddingDomain = false;
let statusPollTimer = null;
const STATUS_HTML = {
  connected: "<strong>已连接 daemon</strong>",
  connecting: "<strong>重连中...</strong>",
  disconnected: "<strong>未连接 daemon</strong>",
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

// --- Init ---
notifyPopupOpened();
refreshDomains();
document.addEventListener("domains-changed", () => refreshDomains());

function refreshStatus() {
  sendMessage({ type: "getStatus" })
    .then((resp) => { setConnectionStatus(resp); syncStatusPolling(resp); })
    .catch(() => { stopStatusPolling(); setStatus("disconnected"); });
}

function notifyPopupOpened() {
  sendMessage({ type: "popupOpened" })
    .then((resp) => { setConnectionStatus(resp); syncStatusPolling(resp); })
    .catch(() => refreshStatus());
}

function syncStatusPolling(resp) {
  if (resp?.connected || !resp?.reconnecting) { stopStatusPolling(); return; }
  if (statusPollTimer !== null) return;
  statusPollTimer = window.setInterval(() => refreshStatus(), 1000);
}

function stopStatusPolling() {
  if (statusPollTimer === null) return;
  window.clearInterval(statusPollTimer);
  statusPollTimer = null;
}

function refreshDomains() {
  sendMessage({ type: "getDomains" })
    .then((resp) => {
      allEntries = resp?.entries || [];
      buildGroups();
      render();
    })
    .catch(() => {});
}

function buildGroups() {
  const map = new Map();
  for (const entry of allEntries) {
    const root = getRootDomain(entry.domain);
    const group = map.get(root) || [];
    group.push(entry);
    map.set(root, group);
  }
  groupedData = [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([root, entries]) => ({ root, entries: entries.sort((a, b) => a.domain.localeCompare(b.domain)) }));
}

function render() { renderDomainList(); renderPagination(); }

function renderDomainList() {
  if (groupedData.length === 0) {
    domainList.innerHTML = '<div class="domain-empty">暂无域名，请添加。</div>';
    return;
  }
  const totalPages = Math.max(1, Math.ceil(groupedData.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = 1;
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageGroups = groupedData.slice(start, start + PAGE_SIZE);

  domainList.innerHTML = pageGroups.map((group, groupIdx) => {
    const isExpanded = expandedGroups.has(group.root);
    const childrenHtml = group.entries.map((entry, domainIdx) => {
      const localClass = entry.localAccess ? "toggle-on" : "toggle-off";
      const localText = entry.localAccess ? "ON" : "OFF";
      let cloudHtml = "";
      if (entry.cloudSync === "enabled") {
        cloudHtml = `<span class="badge badge-enabled">同步</span>`;
      } else if (entry.cloudSync === "pending") {
        cloudHtml = `<span class="badge badge-pending">待确认</span>`;
      } else {
        cloudHtml = `<span class="badge badge-disabled">已禁用</span>`;
      }
      return `
        <div class="subdomain-item" data-domain="${escapeHtml(entry.domain)}">
          <span class="domain-name">${escapeHtml(entry.domain)}</span>
          <div class="domain-controls">
            <button class="toggle-btn ${localClass}" data-action="local" data-group-idx="${groupIdx}" data-domain-idx="${domainIdx}" title="本地获取">${localText}</button>
            ${cloudHtml}
            <button class="remove-btn" data-action="remove" data-group-idx="${groupIdx}" data-domain-idx="${domainIdx}" title="删除">x</button>
          </div>
        </div>
      `;
    }).join("");
    return `
      <div class="domain-group">
        <div class="group-header" data-group-root="${groupIdx}">
          <span class="group-arrow ${isExpanded ? 'expanded' : ''}">&#9654;</span>
          <span class="group-name">${escapeHtml(group.root)}</span>
          <span class="group-count">${group.entries.length}</span>
        </div>
        <div class="group-children ${isExpanded ? 'expanded' : ''}">${childrenHtml}</div>
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
  domainList.querySelectorAll("button[data-action='local']").forEach((btn) => {
    btn.addEventListener("click", (e) => handleToggleLocal(e, btn, pageGroups));
  });
  domainList.querySelectorAll("button[data-action='remove']").forEach((btn) => {
    btn.addEventListener("click", (e) => handleRemoveDomain(e, btn, pageGroups));
  });
  domainList.querySelectorAll(".badge-pending").forEach((badge) => {
    badge.style.cursor = "pointer";
    badge.addEventListener("click", (e) => handleEnablePending(e, badge));
  });
  domainList.querySelectorAll(".badge-disabled").forEach((badge) => {
    badge.style.cursor = "pointer";
    badge.addEventListener("click", (e) => handleEnablePending(e, badge));
  });
}

function renderPagination() {
  const totalPages = Math.max(1, Math.ceil(groupedData.length / PAGE_SIZE));
  if (totalPages <= 1) { pagination.innerHTML = ""; return; }
  pagination.innerHTML = `
    <button id="prevPage" ${currentPage <= 1 ? "disabled" : ""}>上一页</button>
    <span class="page-info">${currentPage} / ${totalPages}</span>
    <button id="nextPage" ${currentPage >= totalPages ? "disabled" : ""}>下一页</button>
  `;
  document.getElementById("prevPage").addEventListener("click", () => { if (currentPage > 1) { currentPage--; render(); } });
  document.getElementById("nextPage").addEventListener("click", () => { if (currentPage < totalPages) { currentPage++; render(); } });
}

addBtn.addEventListener("click", async () => {
  if (isAddingDomain) return;
  const raw = domainInput.value.trim();
  const domain = normalizeDomain(raw);
  domainError.textContent = "";
  if (!domain) { domainError.textContent = "请输入有效域名"; return; }
  if (!domain.includes(".")) { domainError.textContent = "域名必须包含点号"; return; }
  if (allEntries.some((e) => e.domain === domain)) { domainError.textContent = "域名已存在"; return; }
  isAddingDomain = true;
  addBtn.disabled = true;
  try {
    const resp = await sendMessage({ type: "addDomain", domain });
    if (resp?.ok) {
      domainInput.value = "";
      domainError.textContent = "";
      expandedGroups.add(getRootDomain(domain));
      refreshDomains();
    } else {
      domainError.textContent = resp?.error || "添加失败";
    }
  } finally { isAddingDomain = false; addBtn.disabled = false; }
});

domainInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addBtn.click(); });

async function handleToggleLocal(event, button, pageGroups) {
  event.stopPropagation();
  const groupIdx = parseInt(button.dataset.groupIdx, 10);
  const domainIdx = parseInt(button.dataset.domainIdx, 10);
  const entry = pageGroups[groupIdx]?.entries[domainIdx];
  if (!entry) return;
  const newValue = !entry.localAccess;
  const resp = await sendMessage({ type: "setLocalAccess", domain: entry.domain, value: newValue });
  if (resp?.ok) refreshDomains();
}

async function handleRemoveDomain(event, button, pageGroups) {
  event.stopPropagation();
  const groupIdx = parseInt(button.dataset.groupIdx, 10);
  const domainIdx = parseInt(button.dataset.domainIdx, 10);
  const entry = pageGroups[groupIdx]?.entries[domainIdx];
  if (!entry) return;
  button.disabled = true;
  try {
    const resp = await sendMessage({ type: "removeDomain", domain: entry.domain });
    if (resp?.ok) { refreshDomains(); }
    else { alert("删除失败: " + (resp?.error || "未知错误")); }
  } finally { button.disabled = false; }
}

async function handleEnablePending(event, badge) {
  const item = badge.closest(".subdomain-item");
  const domain = item?.dataset?.domain;
  if (!domain) return;
  const resp = await sendMessage({ type: "setCloudSync", domain, status: "enabled" });
  if (resp?.ok) refreshDomains();
}
```

关键变更：
- 使用 `entries`（包含 localAccess/cloudSync 状态）替代 `domains`（纯字符串列表）
- 每个域名显示 `localAccess` toggle 开关和 `cloudSync` 状态 badge
- 移除所有 `chrome.permissions` 调用
- pending/disabled badge 可点击切换为 enabled
- 添加域名不再需要权限弹窗

- [ ] **Step 2: Commit**

```bash
git add cookie-sync-extension/popup/popup.js
git commit -m "refactor: rewrite popup.js with unified domain management UI"
```

---

### Task 9: 更新 popup.html 样式

**Files:**
- Modify: `cookie-sync-extension/popup/popup.html`

- [ ] **Step 1: 添加域名管理相关 CSS 样式**

在 `<style>` 标签中 `</style>` 之前追加以下样式：

```css
    .domain-controls {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    .toggle-btn {
      border: none;
      font-size: 9px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      cursor: pointer;
      min-width: 28px;
    }
    .toggle-on {
      background: #34c759;
      color: #fff;
    }
    .toggle-on:hover { background: #2db84d; }
    .toggle-off {
      background: #e0e0e0;
      color: #999;
    }
    .toggle-off:hover { background: #d0d0d0; }
    .badge {
      font-size: 9px;
      padding: 2px 5px;
      border-radius: 3px;
      font-weight: 500;
      white-space: nowrap;
    }
    .badge-enabled {
      background: #e8f5e9;
      color: #2e7d32;
    }
    .badge-pending {
      background: #fff3e0;
      color: #ef6c00;
      cursor: pointer;
    }
    .badge-pending:hover { background: #ffe0b2; }
    .badge-disabled {
      background: #f5f5f5;
      color: #bbb;
      cursor: pointer;
    }
    .badge-disabled:hover { background: #eeeeee; }
    .remove-btn {
      border: none;
      background: none;
      color: #ccc;
      font-size: 11px;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 3px;
    }
    .remove-btn:hover { color: #ff3b30; background: #fff; }
```

同时更新 footer 版本号和 Tab 标签名：

```html
    <button class="tab-btn active" data-tab="domains">域名管理</button>
```

footer：
```html
    <div class="footer">Cookie Sync v1.2.0</div>
```

- [ ] **Step 2: Commit**

```bash
git add cookie-sync-extension/popup/popup.html
git commit -m "style: add domain control styles and update UI labels"
```

---

### Task 10: 更新 cloud-tab.js

**Files:**
- Modify: `cookie-sync-extension/popup/cloud-tab.js`

- [ ] **Step 1: 移除权限请求逻辑，添加 pending 域名展示**

关键变更点：

1. **移除 `handleSkippedDomains` 函数**（行 562-594）— 不再需要权限请求
2. **移除 `getOriginPatterns` import**（行 3）
3. **在 `doSync` 成功回调中**（行 536-548）— 移除 `skippedDomains` 处理，改为展示 `newDomains`
4. **在 `renderCloudUI` 中添加 pending 域名区块**— 在同步日志之前显示待确认域名

将 `doSync` 函数中的 skippedDomains 处理替换为：

```javascript
// Replace the skippedDomains block in doSync (around line 543-546):
if (resp?.success) {
  btn.textContent = "✓ 成功";
  let successMsg = "同步成功";
  if (resp.domains) successMsg += `，同步 ${resp.domains} 个域名`;
  if (resp.newDomains?.length > 0) {
    successMsg += `，发现 ${resp.newDomains.length} 个新域名`;
  }
  if (msgArea) msgArea.innerHTML = `<div class="cloud-msg success">${successMsg}</div>`;
  setTimeout(() => { btn.textContent = originalText; btn.disabled = false; cloudInitialized = false; initCloudTab(); }, 2000);
}
```

移除 `handleSkippedDomains` 函数以及 `saveStorageBtn` 中的 WebDAV 权限请求（行 367-381），替换为：

```javascript
// In saveStorageBtn click handler, replace WebDAV permission request block with:
if (!config.url || !config.username) { msg.innerHTML = '<div class="cloud-msg error">请填写必填字段</div>'; return; }
```

- [ ] **Step 2: Commit**

```bash
git add cookie-sync-extension/popup/cloud-tab.js
git commit -m "refactor: remove permission requests from cloud-tab, show newDomains in sync result"
```

---

### Task 11: 集成测试

**Files:**
- 无新文件

- [ ] **Step 1: 在 Chrome 中加载扩展测试**

```bash
# 打开 Chrome -> chrome://extensions -> 开发者模式 -> 加载已解压的扩展程序
# 选择 cookie-sync-extension/ 目录
```

验证清单：
1. 扩展加载成功，无控制台错误
2. 如有旧 whitelist 数据，自动迁移到 cloudDomains
3. 添加域名不再弹出权限对话框
4. 域名列表显示 localAccess 开关和 cloudSync badge
5. 切换 localAccess 开关即时生效
6. 点击 pending/disabled badge 可切换为 enabled
7. 删除域名即时从列表移除
8. 云端推送只同步 enabled 域名的 cookie
9. 云端拉取时发现新域名标记为 pending
10. daemon WebSocket 连接只返回 localAccess=true 的域名 cookie

- [ ] **Step 2: 最终 Commit（如有修复）**

```bash
git add -A
git commit -m "fix: integration fixes from manual testing"
```
