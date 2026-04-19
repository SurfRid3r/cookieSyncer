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
