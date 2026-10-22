// cookie-ops.js — Cookie read operations with domain access validation

import * as whitelist from "./whitelist.js";

export async function handleGetCookies(params) {
  let query, host;
  try {
    if (Boolean(params.domain) === Boolean(params.url)) return failure("USAGE_ERROR");
    if (params.url) {
      const url = new URL(params.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        return failure("USAGE_ERROR");
      }
      host = url.hostname;
      query = { url: url.href };
    } else {
      host = whitelist.normalizeDomain(params.domain);
      if (!host) return failure("USAGE_ERROR");
      query = { domain: host };
    }
  } catch {
    return failure("USAGE_ERROR");
  }
  if (!whitelist.isAllowed(host)) return failure("DOMAIN_NOT_ALLOWED");
  try {
    const cookies = await chrome.cookies.getAll(query);
    // URL mode authorizes the target host, including its matching parent cookies.
    // Domain mode preserves filtering by each cookie's owning domain.
    const scoped = params.url ? cookies : cookies.filter((c) => whitelist.isAllowed(c.domain));
    return {
      ok: true,
      data: scoped.map(serializeCookie),
    };
  } catch {
    return failure("COOKIE_READ_FAILED");
  }
}

function failure(error_code) {
  return { ok: false, error_code };
}

function serializeCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate,
  };
}
