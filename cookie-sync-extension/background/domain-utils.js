export function normalizeDomain(input) {
  if (!input || typeof input !== "string") return "";
  let d = input.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "");
  d = d.split("/")[0];
  d = d.split(":")[0];
  d = d.replace(/^[\.*]+/, "");
  return d;
}

export function getOriginPatterns(domain) {
  const d = normalizeDomain(domain);
  return [
    `http://${d}/*`, `http://*.${d}/*`,
    `https://${d}/*`, `https://*.${d}/*`,
  ];
}

export function getRootDomain(domain) {
  const parts = domain.split(".");
  return parts.slice(-2).join(".");
}
