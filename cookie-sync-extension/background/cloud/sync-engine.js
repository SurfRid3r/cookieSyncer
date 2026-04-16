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
  if (!cfg.scheduleEnabled) return;

  const interval = Math.max(MIN_INTERVAL, cfg.scheduleIntervalMinutes);
  chrome.alarms.onAlarm.addListener(handleAlarm);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: interval });
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
