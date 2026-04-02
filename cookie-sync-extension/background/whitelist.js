// whitelist.js — Domain whitelist management with chrome.storage.sync

import { normalizeDomain, getOriginPatterns } from "./domain-utils.js";

const STORAGE_KEY = "allowedDomains";

let cached = new Set();

export { normalizeDomain, getOriginPatterns };

export function isAllowed(domain) {
  if (!domain) return false;
  const d = normalizeDomain(domain);
  if (!d) return false;
  return getDomainCandidates(d).some((candidate) => cached.has(candidate));
}

export function getAllowedDomains() {
  return [...cached].sort();
}

export async function init() {
  const result = await chrome.storage.sync.get(STORAGE_KEY);
  cached = new Set(result[STORAGE_KEY] || []);
}

export async function addDomain(domain) {
  const d = normalizeDomain(domain);
  if (!d) return { ok: false, error: "Invalid domain" };
  if (cached.has(d)) return { ok: false, error: "Domain already allowed" };
  cached.add(d);
  await save();
  return { ok: true };
}

export async function removeDomain(domain, options = {}) {
  const d = normalizeDomain(domain);
  console.log("[cookie-sync] removeDomain called, domain:", domain, "normalized:", d);
  if (!d) return { ok: false, error: "Invalid domain" };

  cached.delete(d);
  await save();
  if (options.skipPermissionRevoke) {
    console.log("[cookie-sync] Domain removed from whitelist, permission revoke skipped by caller");
    return { ok: true };
  }

  console.log("[cookie-sync] Domain removed from whitelist, revoking permissions...");

  try {
    const granted = (await chrome.permissions.getAll()).origins || [];
    console.log("[cookie-sync] Granted origins:", JSON.stringify(granted));

    const toRemove = findMatchingOrigins(granted, d);
    console.log("[cookie-sync] Matched for removal:", JSON.stringify(toRemove));

    if (toRemove.length > 0) {
      const removed = await chrome.permissions.remove({ origins: toRemove });
      console.log("[cookie-sync] chrome.permissions.remove returned:", removed);

      let remaining = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        remaining = findMatchingOrigins((await chrome.permissions.getAll()).origins || [], d);
        console.log(`[cookie-sync] Verification attempt ${attempt + 1}:`, JSON.stringify(remaining));

        if (remaining.length === 0) {
          console.log("[cookie-sync] Permissions successfully revoked");
          break;
        }
        if (attempt < 2) await delay(100);
      }

      if (remaining.length > 0) {
        console.error("[cookie-sync] Failed to fully revoke permissions after retries");
        return { ok: false, error: "Failed to revoke permissions. Please manually revoke in extension settings." };
      }
    } else {
      console.log("[cookie-sync] No matching origins found to remove");
    }

    return { ok: true };
  } catch (e) {
    console.error("[cookie-sync] Failed to remove permissions:", e);
    return { ok: false, error: e.message };
  }
}

async function save() {
  await chrome.storage.sync.set({ [STORAGE_KEY]: [...cached] });
}

function getDomainCandidates(domain) {
  const parts = domain.split(".");
  return parts.map((_, index) => parts.slice(index).join("."));
}

function extractHostFromOrigin(origin) {
  const noScheme = origin.replace(/^[a-z]+:\/\//, "");
  return noScheme.split("/")[0].replace(/^\*\./, "");
}

function findMatchingOrigins(origins, domain) {
  return origins.filter((origin) => {
    const host = extractHostFromOrigin(origin);
    return host === domain || host.endsWith(`.${domain}`);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
