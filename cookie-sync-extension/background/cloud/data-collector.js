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
