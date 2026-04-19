// background/cloud/gist-adapter.js — GitHub Gist storage

export function createGistAdapter(config) {
  let gistId = config.gistId || null;
  let token = config.token;
  const filename = "cookie-sync.enc";

  function apiFetch(path, options = {}) {
    const headers = {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      ...options.headers,
    };
    return fetch(`https://api.github.com${path}`, { ...options, headers });
  }

  async function upload(payload, domainList) {
    const body = {
      description: "Cookie Sync encrypted data",
      public: false,
      files: {
        [filename]: { content: payload },
        "domain-list.json": {
          content: JSON.stringify(domainList || [], null, 2),
        },
      },
    };

    if (gistId) {
      const resp = await apiFetch(`/gists/${gistId}`, { method: "PATCH", body: JSON.stringify(body) });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        if (err.message?.includes("401")) throw new Error("authentication failed: token invalid or expired");
        throw new Error(`Gist update failed: ${resp.status} ${err.message || ""}`);
      }
      return true;
    }

    const resp = await apiFetch("/gists", { method: "POST", body: JSON.stringify(body) });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      if (err.message?.includes("401")) throw new Error("authentication failed: token invalid or expired");
      throw new Error(`Gist create failed: ${resp.status} ${err.message || ""}`);
    }
    const data = await resp.json();
    gistId = data.id;
    return gistId;
  }

  async function download() {
    if (!gistId) return null;
    const resp = await apiFetch(`/gists/${gistId}`);
    if (!resp.ok) {
      if (resp.status === 404) return null;
      const err = await resp.json().catch(() => ({}));
      if (err.message?.includes("401")) throw new Error("authentication failed: token invalid or expired");
      throw new Error(`Gist download failed: ${resp.status}`);
    }
    const data = await resp.json();
    const file = data.files?.[filename];
    return file?.content || null;
  }

  async function downloadDomainList() {
    if (!gistId) return [];
    try {
      const resp = await apiFetch(`/gists/${gistId}`);
      if (!resp.ok) return [];
      const data = await resp.json();
      const file = data.files?.["domain-list.json"];
      if (!file?.content) return [];
      return JSON.parse(file.content);
    } catch {
      return [];
    }
  }

  async function getLastModified() {
    if (!gistId) return null;
    const resp = await apiFetch(`/gists/${gistId}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.updated_at ? new Date(data.updated_at).getTime() : null;
  }

  async function testConnection() {
    const resp = await apiFetch("/gists", { method: "POST", body: JSON.stringify({ public: false, files: { "test": { content: "test" } } }) });
    if (resp.ok) {
      const data = await resp.json();
      await apiFetch(`/gists/${data.id}`, { method: "DELETE" });
      return true;
    }
    const err = await resp.json().catch(() => ({}));
    console.error("[gist] Connection test failed:", err.message);
    return false;
  }

  function init(cfg) {
    if (cfg.gistId) gistId = cfg.gistId;
    if (cfg.token) token = cfg.token;
  }

  return { init, upload, download, downloadDomainList, getLastModified, testConnection };
}
