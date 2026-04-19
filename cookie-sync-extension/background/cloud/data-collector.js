// background/cloud/data-collector.js — Collect cookies by whitelist

import * as whitelist from "../whitelist.js";

export async function collectAll(lastKnown) {
  const domains = whitelist.getAllowedDomains();
  if (domains.length === 0) {
    console.log("[cloud-sync] collectAll: no domains in whitelist");
    return { cookies: {}, timestamp: Date.now(), domainCount: 0, cookieCount: 0 };
  }
  console.log("[cloud-sync] collectAll: collecting for", domains.length, "domains:", domains.join(", "));

  const now = Date.now();
  const cookiesByDomain = {};
  let totalCookies = 0;

  for (const domain of domains) {
    try {
      const cookies = await chrome.cookies.getAll({ domain });
      const filtered = cookies.filter((c) => whitelist.isAllowed(c.domain));
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
    domainCount: domains.length,
    cookieCount: totalCookies,
  };
}

export async function writeCookies(cookiesByDomain) {
  let written = 0;
  let deleted = 0;
  const skippedDomains = new Set();

  // Check permissions per domain, collect missing ones
  const allDomains = Object.keys(cookiesByDomain);
  const grantedOrigins = (await chrome.permissions.getAll()).origins || [];
  const domainsWithPermission = new Set();
  console.log("[cloud-sync] writeCookies:", allDomains.length, "domains to write, granted origins:", grantedOrigins.length);

  for (const domain of allDomains) {
    const host = domain.replace(/^\./, "");
    const hasPermission = grantedOrigins.some((origin) => {
      const o = origin.replace(/^[a-z]+:\/\//, "").split("/")[0].replace(/^\*\./, "");
      return o === host || host.endsWith(`.${o}`) || o.endsWith(`.${host}`);
    });
    if (hasPermission) {
      domainsWithPermission.add(domain);
    } else {
      skippedDomains.add(host);
      console.warn("[cloud-sync] writeCookies: no permission for", host, "(" + cookiesByDomain[domain].length, "cookies skipped)");
    }
  }

  if (skippedDomains.size > 0) {
    console.log("[cloud-sync] writeCookies: skipped domains:", [...skippedDomains].join(", "));
  }

  for (const [domain, cookies] of Object.entries(cookiesByDomain)) {
    if (!domainsWithPermission.has(domain)) continue;
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

  return { written, deleted, skippedDomains: [...skippedDomains] };
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
