// background/cloud/gist-adapter.js — GitHub Gist storage backend

const GITHUB_API = "https://api.github.com";
const FILENAME = "cookie-sync.enc";

export function createGistAdapter(config) {
  let token = config.token || "";
  let gistId = config.gistId || "";

  async function apiFetch(path, options = {}) {
    const url = `${GITHUB_API}${path}`;
    const headers = {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
      ...options.headers,
    };
    const resp = await fetch(url, { ...options, headers });
    if (resp.status === 401) throw new Error("GitHub authentication failed");
    if (resp.status === 403 || resp.status === 429) {
      const remaining = resp.headers.get("X-RateLimit-Remaining");
      throw new Error(`GitHub API rate limited. Remaining: ${remaining}`);
    }
    return resp;
  }

  async function init(configUpdate) {
    if (configUpdate?.token) token = configUpdate.token;
    if (configUpdate?.gistId) gistId = configUpdate.gistId;
  }

  async function testConnection() {
    try {
      if (!token) return false;
      const resp = await apiFetch("/user");
      return resp.ok;
    } catch {
      return false;
    }
  }

  async function upload(encryptedPayload) {
    try {
      if (!gistId) {
        const resp = await apiFetch("/gists", {
          method: "POST",
          body: JSON.stringify({
            description: "Cookie Sync encrypted data",
            public: false,
            files: { [FILENAME]: { content: encryptedPayload } },
          }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.message || `Failed to create gist: ${resp.status}`);
        }
        const data = await resp.json();
        gistId = data.id;
        return gistId;
      }

      const resp = await apiFetch(`/gists/${gistId}`, {
        method: "PATCH",
        body: JSON.stringify({
          files: { [FILENAME]: { content: encryptedPayload } },
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.message || `Failed to update gist: ${resp.status}`);
      }
      return true;
    } catch (err) {
      console.error("[cloud-sync] Gist upload error:", err);
      throw err;
    }
  }

  async function download() {
    try {
      if (!gistId) return null;
      const resp = await apiFetch(`/gists/${gistId}`);
      if (resp.status === 404) return null;
      if (!resp.ok) throw new Error(`Failed to fetch gist: ${resp.status}`);
      const data = await resp.json();
      const file = data.files?.[FILENAME];
      return file?.content || null;
    } catch (err) {
      console.error("[cloud-sync] Gist download error:", err);
      throw err;
    }
  }

  async function getLastModified() {
    try {
      if (!gistId) return null;
      const resp = await apiFetch(`/gists/${gistId}`);
      if (!resp.ok) return null;
      const data = await resp.json();
      const dateStr = data.updated_at || data.created_at;
      return dateStr ? new Date(dateStr).getTime() : null;
    } catch {
      return null;
    }
  }

  function getGistId() {
    return gistId;
  }

  return { init, testConnection, upload, download, getLastModified, getGistId };
}
