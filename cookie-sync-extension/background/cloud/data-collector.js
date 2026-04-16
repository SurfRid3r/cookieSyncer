// background/cloud/data-collector.js — Collect cookies and localStorage by whitelist

import * as whitelist from "../whitelist.js";

export async function collectAll(lastKnown) {
  const domains = whitelist.getAllowedDomains();
  if (domains.length === 0) {
    return { cookies: {}, localStorages: {}, timestamp: Date.now(), domainCount: 0, cookieCount: 0 };
  }

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
    } catch (err) {
      console.warn(`[cloud-sync] Failed to collect cookies for ${domain}:`, err);
    }
  }

  const localStorages = await collectLocalStorages(domains);

  return {
    version: 1,
    timestamp: now,
    cookies: cookiesByDomain,
    localStorages,
    domainCount: domains.length,
    cookieCount: totalCookies,
  };
}

async function collectLocalStorages(domains) {
  const storages = {};
  const tabs = await chrome.tabs.query({});

  for (const domain of domains) {
    const matchingTabs = tabs.filter((tab) => {
      try {
        const hostname = new URL(tab.url).hostname;
        return hostname === domain || hostname.endsWith(`.${domain}`);
      } catch {
        return false;
      }
    });

    for (const tab of matchingTabs) {
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const data = {};
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              data[key] = localStorage.getItem(key);
            }
            return data;
          },
        });
        if (results?.[0]?.result && Object.keys(results[0].result).length > 0) {
          const origin = new URL(tab.url).origin;
          if (!storages[origin]) storages[origin] = {};
          Object.assign(storages[origin], results[0].result);
        }
      } catch (err) {
        // Tab may not be accessible (chrome://, about:, etc.)
      }
    }
  }

  return storages;
}

export async function writeCookies(cookiesByDomain) {
  let written = 0;
  let deleted = 0;

  for (const [domain, cookies] of Object.entries(cookiesByDomain)) {
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

export async function writeLocalStorages(localStorages) {
  let written = 0;
  const tabs = await chrome.tabs.query({});

  for (const [origin, data] of Object.entries(localStorages)) {
    const url = new URL(origin);
    const matchingTabs = tabs.filter((tab) => {
      try {
        return new URL(tab.url).origin === origin;
      } catch {
        return false;
      }
    });

    for (const tab of matchingTabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (items) => {
            for (const [key, value] of Object.entries(items)) {
              localStorage.setItem(key, value);
            }
          },
          args: [data],
        });
        written += Object.keys(data).length;
      } catch {
        // Tab not accessible
      }
    }
  }

  return { written };
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
