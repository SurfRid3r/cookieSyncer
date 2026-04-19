// background/cloud/webdav-adapter.js — WebDAV storage

export function createWebdavAdapter(config) {
  let url = config.url?.replace(/\/$/, "") || "";
  let username = config.username;
  let password = config.password;
  let filePath = config.filePath || "/cookie-sync/cookies.enc";
  const domainListPath = () => {
    const dir = filePath.substring(0, filePath.lastIndexOf("/") + 1);
    return dir + "domain-list.json";
  };

  function headers() {
    return {
      Authorization: "Basic " + btoa(`${username}:${password}`),
      "Content-Type": "application/octet-stream",
    };
  }

  async function ensureDir() {
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    if (!dir) return;
    try {
      await fetch(`${url}${dir}`, { method: "MKCOL", headers: headers() });
    } catch { /* dir may already exist */ }
  }

  async function upload(payload, domainList) {
    await ensureDir();
    const resp = await fetch(`${url}${filePath}`, {
      method: "PUT",
      headers: headers(),
      body: payload,
    });
    if (!resp.ok) {
      if (resp.status === 401) throw new Error("authentication failed");
      throw new Error(`WebDAV upload failed: ${resp.status}`);
    }
    // Upload domain list as separate file
    if (domainList) {
      await fetch(`${url}${domainListPath()}`, {
        method: "PUT",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify(domainList, null, 2),
      }).catch((err) => console.warn("[webdav] Failed to upload domain list:", err));
    }
    return true;
  }

  async function download() {
    const resp = await fetch(`${url}${filePath}`, { headers: headers() });
    if (resp.status === 404) return null;
    if (!resp.ok) {
      if (resp.status === 401) throw new Error("authentication failed");
      throw new Error(`WebDAV download failed: ${resp.status}`);
    }
    return resp.text();
  }

  async function downloadDomainList() {
    try {
      const resp = await fetch(`${url}${domainListPath()}`, { headers: headers() });
      if (!resp.ok) return [];
      const text = await resp.text();
      return JSON.parse(text);
    } catch {
      return [];
    }
  }

  async function getLastModified() {
    const resp = await fetch(`${url}${filePath}`, { method: "HEAD", headers: headers() });
    if (!resp.ok) return null;
    const lastModified = resp.headers.get("Last-Modified");
    return lastModified ? new Date(lastModified).getTime() : null;
  }

  async function testConnection() {
    try {
      const resp = await fetch(`${url}/`, {
        method: "PROPFIND",
        headers: { ...headers(), Depth: "0" },
      });
      return resp.ok || resp.status === 207;
    } catch {
      return false;
    }
  }

  function init(cfg) {
    if (cfg.url) url = cfg.url.replace(/\/$/, "");
    if (cfg.username) username = cfg.username;
    if (cfg.password) password = cfg.password;
    if (cfg.filePath) filePath = cfg.filePath;
  }

  return { init, upload, download, downloadDomainList, getLastModified, testConnection };
}
