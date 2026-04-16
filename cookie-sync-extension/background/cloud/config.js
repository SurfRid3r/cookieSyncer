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
