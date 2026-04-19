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

// --- Alarm: keep SW alive + reconnect + scheduled sync ---
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    void ensureReady();
  } else if (alarm.name === "cloud-sync") {
    // Ensure initialization is complete before triggering sync.
    // Needed when SW is woken by the alarm itself (before async init() finishes).
    void ensureReady().then(() => cloudSync.triggerScheduledSync());
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
chrome.runtime.onInstalled.addListener(() => initialize());
chrome.runtime.onStartup.addListener(() => initialize());
