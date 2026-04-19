// background/cloud/webdav-adapter.js — WebDAV storage backend

export function createWebdavAdapter(config) {
  let url = (config.url || "").replace(/\/+$/, "");
  let username = config.username || "";
  let password = config.password || "";
  let filePath = config.filePath || "/cookie-sync/cookies.enc";

  function getAuthHeader() {
    const credentials = btoa(`${username}:${password}`);
    return `Basic ${credentials}`;
  }

  function getFileUrl() {
    const path = filePath.startsWith("/") ? filePath : `/${filePath}`;
    return `${url}${path}`;
  }

  async function init(configUpdate) {
    if (configUpdate?.url) url = configUpdate.url.replace(/\/+$/, "");
    if (configUpdate?.username) username = configUpdate.username;
    if (configUpdate?.password) password = configUpdate.password;
    if (configUpdate?.filePath) filePath = configUpdate.filePath;
  }

  async function testConnection() {
    try {
      if (!url || !username) return false;
      const resp = await fetch(url, {
        method: "PROPFIND",
        headers: {
          Authorization: getAuthHeader(),
          Depth: "0",
        },
        signal: AbortSignal.timeout(10000),
      });
      return resp.status === 207 || resp.status === 200;
    } catch {
      return false;
    }
  }

  async function upload(encryptedPayload) {
    try {
      const fileUrl = getFileUrl();
      const resp = await fetch(fileUrl, {
        method: "PUT",
        headers: {
          Authorization: getAuthHeader(),
          "Content-Type": "application/octet-stream",
        },
        body: encryptedPayload,
        signal: AbortSignal.timeout(15000),
      });
      if (resp.status === 201 || resp.status === 204 || resp.status === 200) {
        return true;
      }
      if (resp.status === 401) throw new Error("WebDAV 认证失败，用户名或密码无效或已过期");
      if (resp.status === 404) throw new Error("WebDAV path not found. Check file path and ensure parent directory exists.");
      if (resp.status === 409) throw new Error("WebDAV conflict: parent directory does not exist");
      throw new Error(`WebDAV upload failed: ${resp.status}`);
    } catch (err) {
      console.error("[cloud-sync] WebDAV upload error:", err);
      throw err;
    }
  }

  async function download() {
    try {
      const fileUrl = getFileUrl();
      const resp = await fetch(fileUrl, {
        method: "GET",
        headers: {
          Authorization: getAuthHeader(),
        },
        signal: AbortSignal.timeout(15000),
      });
      if (resp.status === 404) return null;
      if (!resp.ok) throw new Error(`WebDAV download failed: ${resp.status}`);
      return await resp.text();
    } catch (err) {
      console.error("[cloud-sync] WebDAV download error:", err);
      throw err;
    }
  }

  async function getLastModified() {
    try {
      const fileUrl = getFileUrl();
      const resp = await fetch(fileUrl, {
        method: "HEAD",
        headers: {
          Authorization: getAuthHeader(),
        },
      });
      if (!resp.ok) return null;
      const lastModified = resp.headers.get("Last-Modified");
      return lastModified ? new Date(lastModified).getTime() : null;
    } catch {
      return null;
    }
  }

  return { init, testConnection, upload, download, getLastModified };
}
