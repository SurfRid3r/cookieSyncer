// cookie-ops.js — Cookie read operations with domain access validation

import * as whitelist from "./whitelist.js";

export async function handleGetCookies(params) {
  if (!params.domain && !params.url) {
    return { ok: false, error: "Cookie scope required: provide domain or url" };
  }

  const domain = params.domain || new URL(params.url).hostname;

  if (!whitelist.isAllowed(domain)) {
    return { ok: false, error: `Domain not allowed: ${domain}` };
  }

  try {
    const cookies = await chrome.cookies.getAll({ domain });
    return {
      ok: true,
      data: cookies.filter((c) => whitelist.isAllowed(c.domain)).map(serializeCookie),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function handleListAllowed() {
  return { ok: true, data: whitelist.getLocalAccessDomains() };
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
