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

// IPv4 正则
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * 判断是否为 IPv4 地址
 */
function isIPv4(domain) {
  if (!IPV4_RE.test(domain)) return false;
  return domain.split(".").every((seg) => {
    const n = Number(seg);
    return n >= 0 && n <= 255;
  });
}

/**
 * 已知的公共后缀（多级 TLD）。
 * 采用倒序匹配：将域名按 "." 分割，取最后 N 段与列表匹配。
 * 来源：Public Suffix List 中最常见条目 + 中国常用后缀。
 */
const PUBLIC_SUFFIXES = [
  // 中国
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "ac.cn", "mil.cn",
  "ah.cn", "bj.cn", "cq.cn", "fj.cn", "gd.cn", "gs.cn", "gz.cn",
  "gx.cn", "ha.cn", "hb.cn", "he.cn", "hi.cn", "hk.cn", "hl.cn",
  "hn.cn", "jl.cn", "js.cn", "jx.cn", "ln.cn", "mo.cn", "nm.cn",
  "nx.cn", "qh.cn", "sc.cn", "sd.cn", "sh.cn", "sn.cn", "sx.cn",
  "tj.cn", "tw.cn", "xj.cn", "xz.cn", "yn.cn", "zj.cn",
  // 国际常见
  "co.uk", "org.uk", "ac.uk", "gov.uk", "net.uk",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "co.kr", "or.kr", "go.kr",
  "co.in", "net.in", "org.in", "gen.in", "firm.in", "ind.in",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "com.br", "net.br", "org.br", "gov.br",
  "com.mx", "org.mx", "gob.mx", "net.mx",
  "com.sg", "net.sg", "org.sg", "gov.sg", "edu.sg",
  "com.hk", "org.hk", "edu.hk", "gov.hk", "net.hk",
  "com.tw", "org.tw", "edu.tw", "gov.tw", "net.tw",
  "co.nz", "net.nz", "org.nz", "govt.nz",
  "co.za", "org.za", "net.za", "web.za", "gov.za",
  "com.my", "net.my", "org.my", "gov.my", "edu.my",
  "com.ar", "org.ar", "gov.ar", "net.ar",
  "com.tr", "org.tr", "gov.tr", "net.tr", "edu.tr",
  "co.il", "org.il", "net.il", "ac.il", "gov.il",
  "com.ru", "org.ru", "net.ru",
  "com.ua", "org.ua", "net.ua",
  "co.th", "or.th", "go.th", "ac.th",
  "com.vn", "net.vn", "org.vn", "gov.vn", "edu.vn",
  "com.ph", "net.ph", "org.ph", "gov.ph",
  "com.id", "net.id", "org.id", "go.id", "ac.id",
  "com.sa", "net.sa", "org.sa", "gov.sa",
  "com.th", "net.th", "org.th", "go.th", "ac.th",
  "com.ng", "org.ng", "gov.ng", "edu.ng",
  "com.pk", "net.pk", "org.pk", "gov.pk",
  "com.bd", "net.bd", "org.bd", "gov.bd",
  "com.eg", "org.eg", "gov.eg", "net.eg",
  "club.tw", "idv.tw", "ebiz.tw", "game.tw",
  // 通用多级后缀
  "com.de", "org.de", "net.de",
];

/**
 * 获取匹配的公共后缀长度（段数）。
 * 例如 domain = "device.sangfor.com.cn" → 返回 2（匹配 "com.cn"）
 * 如果没有匹配，返回 1（默认单级 TLD 如 .com, .org）
 */
function getPublicSuffixDepth(domain) {
  const parts = domain.split(".");
  // 从最长的后缀开始尝试匹配，优先匹配更具体的
  for (let len = Math.min(parts.length - 1, 3); len >= 1; len--) {
    const suffix = parts.slice(-len).join(".");
    if (PUBLIC_SUFFIXES.includes(suffix)) {
      return len;
    }
  }
  return 1; // 默认单级 TLD
}

/**
 * 提取根域名（注册域名）用于分组。
 *
 * - IP 地址：直接返回完整 IP
 * - 多级 TLD（如 .com.cn）：返回 eTLD+1（如 sangfor.com.cn）
 * - 普通 TLD（如 .com）：返回最后两段（如 example.com）
 */
export function getRootDomain(domain) {
  // IP 地址直接返回完整地址
  if (isIPv4(domain)) return domain;

  const parts = domain.split(".");
  if (parts.length <= 1) return domain;

  const suffixDepth = getPublicSuffixDepth(domain);
  // 根域名 = 公共后缀 + 它前面的一段
  const rootDepth = suffixDepth + 1;

  if (parts.length <= rootDepth) return domain;
  return parts.slice(-rootDepth).join(".");
}
