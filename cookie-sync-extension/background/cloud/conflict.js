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
      if (remote.expirationDate && remote.expirationDate < now / 1000) {
        stats.deleted++;
      } else {
        if (!mergedCookies[remote._domain]) mergedCookies[remote._domain] = [];
        mergedCookies[remote._domain].push(remote);
        stats.added++;
      }
    } else if (local && !remote) {
      if (!mergedCookies[local._domain]) mergedCookies[local._domain] = [];
      mergedCookies[local._domain].push(local);
      stats.localKept++;
    } else if (local && remote) {
      const localTs = lastKnown?.[key] || local.lastModified || 0;
      const remoteTs = remote.lastModified || 0;

      if (remote.expirationDate && remote.expirationDate < now / 1000) {
        stats.deleted++;
      } else if (remoteTs > localTs) {
        if (!mergedCookies[remote._domain]) mergedCookies[remote._domain] = [];
        mergedCookies[remote._domain].push(remote);
        stats.remoteKept++;
      } else {
        if (!mergedCookies[local._domain]) mergedCookies[local._domain] = [];
        mergedCookies[local._domain].push(local);
        stats.localKept++;
      }
    }
  }

  return {
    merged: {
      version: 1,
      timestamp: now,
      cookies: mergedCookies,
    },
    stats,
  };
}
