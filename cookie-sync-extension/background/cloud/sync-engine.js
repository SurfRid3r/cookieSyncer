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
  console.log("[cloud-sync] init start");
  await config.init();
  await initAdapter();
  await initCryptoKey();
  await setupAlarm();
  console.log("[cloud-sync] init done, configured:", config.isConfigured(), "storage:", config.get().storageType);
}

export function getStatus() {
  const cfg = config.get();
  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    configured: config.isConfigured(),
    hasKey: !!cfg.keyConfig?.exportedKey,
    storageType: cfg.storageType,
    gistId: cfg.storageConfig?.gist?.gistId || "",
    scheduleEnabled: cfg.scheduleEnabled,
    scheduleInterval: cfg.scheduleIntervalMinutes,
    lastSyncTime: cfg.lastSyncTime,
    lastSyncStatus: cfg.lastSyncStatus,
    lastSyncError: cfg.lastSyncError,
  };
}

export async function push() {
  if (!config.isConfigured()) throw new Error("Cloud sync not configured");
  if (!adapter) throw new Error("存储后端未配置");
  console.log("[cloud-sync] push start");
  const lastKnown = await loadLastKnown();
  const data = await dataCollector.collectAll(lastKnown);
  console.log("[cloud-sync] push collected:", data.domainCount, "domains,", data.cookieCount, "cookies");
  if (data.cookieCount === 0) {
    throw new Error("没有可同步的数据，请先在域名管理中添加域名");
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
  const result = await adapter.upload(payload);
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

export async function pull() {
  if (!config.isConfigured()) throw new Error("Cloud sync not configured");
  if (!adapter) throw new Error("存储后端未配置");
  console.log("[cloud-sync] pull start");
  const encryptedPayload = await adapter.download();
  if (!encryptedPayload) throw new Error("云端暂无数据，请先在另一设备上推送");
  console.log("[cloud-sync] pull downloaded, size:", encryptedPayload.length, "bytes");
  let payload;
  try {
    payload = JSON.parse(encryptedPayload);
  } catch {
    throw new Error("云端数据格式错误");
  }
  console.log("[cloud-sync] pull payload version:", payload.version, "crypto:", payload.crypto, "keyType:", payload.keyType);
  let plaintext;
  try {
    plaintext = await crypto.decrypt({ iv: payload.iv, data: payload.data }, cryptoKey);
  } catch {
    throw new Error("解密失败，请确认加密密钥是否正确");
  }
  const remoteData = JSON.parse(plaintext);
  console.log("[cloud-sync] pull remote data:", Object.keys(remoteData.cookies || {}).length, "domains,", remoteData.cookieCount || 0, "cookies");
  const lastKnown = await loadLastKnown();
  const localData = await dataCollector.collectAll(lastKnown);
  console.log("[cloud-sync] pull local data:", localData.domainCount, "domains,", localData.cookieCount, "cookies");
  const { merged, stats } = conflict.resolve(localData, remoteData, lastKnown);
  console.log("[cloud-sync] pull merged:", Object.keys(merged.cookies).length, "domains, stats:", JSON.stringify(stats));

  // Request permissions for remote domains not yet allowed locally
  // (moved to popup side — chrome.permissions.request needs user gesture)

  const writeResult = await dataCollector.writeCookies(merged.cookies);
  console.log("[cloud-sync] pull write result: written:", writeResult.written, "deleted:", writeResult.deleted, "skipped:", writeResult.skippedDomains);
  await saveLastKnown(merged);
  await config.addSyncLogEntry({
    time: Date.now(),
    action: "pull",
    status: "success",
    domains: Object.keys(merged.cookies).length,
    cookies: writeResult.written,
    skippedDomains: writeResult.skippedDomains,
  });
  const result = { success: true, domains: Object.keys(merged.cookies).length, ...stats, written: writeResult.written, deleted: writeResult.deleted };
  if (writeResult.skippedDomains?.length > 0) {
    result.skippedDomains = writeResult.skippedDomains;
  }
  console.log("[cloud-sync] pull done");
  return result;
}

export async function sync() {
  if (!config.isConfigured()) throw new Error("Cloud sync not configured");
  await push();
  await pull();
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

export function getExportedKey() {
  return config.get().keyConfig?.exportedKey || null;
}

export function getSyncLog() {
  const log = config.get().syncLog || [];
  console.log("[cloud-sync] getSyncLog: returning", log.length, "entries");
  return log;
}

export async function logError(action, error) {
  await config.addSyncLogEntry({
    time: Date.now(),
    action,
    status: "error",
    error: error || "Unknown error",
  });
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
  await setupAlarm();
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
    console.log("[cloud-sync] adapter initialized:", cfg.storageType);
  } else {
    console.log("[cloud-sync] no storage type configured, adapter not created");
  }
}

async function initCryptoKey() {
  const keyCfg = config.getKeyConfig();
  if (keyCfg.exportedKey) {
    cryptoKey = await crypto.importKey(keyCfg.exportedKey);
    console.log("[cloud-sync] crypto key loaded, type:", keyCfg.type);
  } else {
    console.log("[cloud-sync] no exported key found, crypto key not loaded");
  }
}

async function setupAlarm() {
  const cfg = config.get();

  if (!cfg.scheduleEnabled) {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }

  const interval = Math.max(MIN_INTERVAL, cfg.scheduleIntervalMinutes);

  // Only recreate the alarm if it doesn't exist or the period changed.
  // Unconditional clear+create would reset the countdown on every SW restart.
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing || existing.periodInMinutes !== interval) {
    await chrome.alarms.clear(ALARM_NAME);
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: interval });
    console.log("[cloud-sync] alarm created/updated, interval:", interval, "min");
  } else {
    console.log("[cloud-sync] alarm already exists, interval:", interval, "min — not reset");
  }
}

export function triggerScheduledSync() {
  const mode = config.get().mode;
  if (mode === "push-only") push().catch(handleSyncError);
  else if (mode === "pull-only") pull().catch(handleSyncError);
  else sync().catch(handleSyncError);
}

async function handleSyncError(err) {
  console.error("[cloud-sync] Scheduled sync failed:", err);
  const msg = err.message || "";
  // Stop scheduled sync on auth failures (expired/revoked token or password)
  if (msg.includes("authentication failed") || msg.includes("401")) {
    console.warn("[cloud-sync] Auth failure detected, stopping scheduled sync");
    try {
      await config.update({ scheduleEnabled: false });
      await setupAlarm();
    } catch (e) {
      console.error("[cloud-sync] Failed to disable alarm after auth failure:", e);
    }
  }
  await config.addSyncLogEntry({
    time: Date.now(),
    action: config.get().mode,
    status: "error",
    error: msg,
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
