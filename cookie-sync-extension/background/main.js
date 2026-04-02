// main.js — Entry point: initialization, alarm, command routing, popup messages

import * as connection from "./connection.js";
import * as cookieOps from "./cookie-ops.js";
import * as whitelist from "./whitelist.js";

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
    // Domain may already exist if onAdded handler added it first
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
};

async function initialize() {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await whitelist.init();
    connection.init(onDaemonMessage);
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

// --- Permission granted fallback (handles popup-closing during dialog) ---
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
