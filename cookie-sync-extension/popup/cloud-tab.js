// cloud-tab.js — Cloud sync tab UI logic

import { getOriginPatterns } from "../background/domain-utils.js";

let cloudInitialized = false;
let activeSection = null;

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(resp);
    });
  });
}

export async function initCloudTab() {
  if (cloudInitialized) return;
  cloudInitialized = true;

  const container = document.getElementById("cloud-content");
  const status = await sendMessage({ type: "cloudGetStatus" });

  if (!status.configured) {
    renderSetupGuide(container, !!status.hasKey);
  } else {
    renderCloudUI(container, status);
  }
}

function renderSetupGuide(container, hasKey) {
  const keySection = hasKey
    ? `<div class="section-toggle" data-section="key-setup">
        <span class="section-toggle-title">🔑 加密密钥</span>
        <span class="section-toggle-info" style="color:#34c759;">✓ 已配置 ›</span>
      </div>
      <div class="section-body" id="section-key-setup">
        <div class="btn-row">
          <button class="btn-sm outline" id="exportKeyBtn">导出密钥</button>
          <button class="btn-sm outline" id="reconfigKeyBtn">重新配置</button>
        </div>
        <div id="keyMsg"></div>
      </div>`
    : `<div class="section-toggle" data-section="key-setup">
        <span class="section-toggle-title">🔑 配置加密密钥</span>
        <span class="section-toggle-info">必填 ›</span>
      </div>
      <div class="section-body" id="section-key-setup">
        <div class="form-group">
          <label>选择密钥方式</label>
          <select id="keyType">
            <option value="random">自动生成（推荐）</option>
            <option value="password">从密码派生</option>
            <option value="import">导入已有密钥</option>
          </select>
        </div>
        <div id="key-password-input" style="display:none">
          <div class="form-group">
            <label>输入密码</label>
            <input type="password" id="keyPassword" placeholder="输入密码">
          </div>
        </div>
        <div id="key-import-input" style="display:none">
          <div class="form-group">
            <label>粘贴 Base64 密钥</label>
            <input type="text" id="keyImport" placeholder="粘贴导出的密钥字符串">
          </div>
        </div>
        <div class="btn-row">
          <button class="btn-sm primary" id="generateKeyBtn">生成密钥</button>
        </div>
        <div id="keyMsg"></div>
      </div>`;

  container.innerHTML = `
    <div class="setup-guide">
      <p>请先配置加密密钥和存储后端以启用云同步。</p>
      ${keySection}
      <div class="section-toggle" data-section="storage-setup" style="margin-top:6px">
        <span class="section-toggle-title">⚙️ 配置存储后端</span>
        <span class="section-toggle-info">必填 ›</span>
      </div>
      <div class="section-body" id="section-storage-setup">
        <div class="form-group">
          <label>后端类型</label>
          <select id="storageType">
            <option value="gist">GitHub Gist</option>
            <option value="webdav">WebDAV</option>
          </select>
        </div>
        <div id="gist-config">
          <div class="form-group">
            <label>GitHub Token</label>
            <input type="password" id="gistToken" placeholder="ghp_xxxxx（需要 gist 权限）">
          </div>
          <div class="form-group">
            <label>Gist ID（可选，留空则自动创建）</label>
            <input type="text" id="gistId" placeholder="首次使用留空，其他设备填入已有 Gist ID">
          </div>
        </div>
        <div id="webdav-config" style="display:none">
          <div class="form-group">
            <label>WebDAV URL</label>
            <input type="text" id="webdavUrl" placeholder="https://dav.jianguoyun.com/dav/">
          </div>
          <div class="form-group">
            <label>用户名</label>
            <input type="text" id="webdavUser" placeholder="user@example.com">
          </div>
          <div class="form-group">
            <label>密码 / 应用专用密码</label>
            <input type="password" id="webdavPass" placeholder="应用专用密码">
          </div>
          <div class="form-group">
            <label>文件路径</label>
            <input type="text" id="webdavPath" placeholder="/cookie-sync/cookies.enc" value="/cookie-sync/cookies.enc">
          </div>
        </div>
        <div class="btn-row">
          <button class="btn-sm primary" id="testConnBtn">测试连接</button>
          <button class="btn-sm outline" id="saveStorageBtn">保存配置</button>
        </div>
        <div id="storageMsg"></div>
      </div>
    </div>
  `;

  bindSetupEvents(container);
}

function renderCloudUI(container, status) {
  const lastSyncText = status.lastSyncTime
    ? new Date(status.lastSyncTime).toLocaleString()
    : "从未同步";

  container.innerHTML = `
    <div class="cloud-card">
      <div class="cloud-card-header">
        <span class="cloud-card-title">同步状态</span>
        <span class="cloud-status-badge ${status.configured ? 'connected' : 'disconnected'}">${status.configured ? '● 已配置' : '● 未配置'}</span>
      </div>
      <div class="cloud-card-subtitle">后端: ${status.storageType === 'gist' ? 'GitHub Gist' : 'WebDAV'}</div>
      <div class="cloud-card-subtitle">上次同步: ${lastSyncText}</div>
      ${status.storageType === 'gist' && status.gistId ? `<div class="cloud-card-subtitle" style="margin-top:4px;">Gist ID: <span style="font-family:monospace;font-size:10px;user-select:all;cursor:pointer;" title="点击选中并复制到其他设备">${status.gistId}</span></div>` : ''}
      ${status.storageType === 'gist' && status.gistId ? '<div class="cloud-card-subtitle" style="color:#007aff;">在其他设备填入相同 Token 和此 Gist ID 即可同步</div>' : ''}
    </div>
    <div class="cloud-card">
      <div class="cloud-card-title" style="margin-bottom:6px">同步模式</div>
      <div class="mode-selector">
        <div class="mode-btn ${status.mode === 'push-only' ? 'active' : ''}" data-mode="push-only">⬆ 仅推送</div>
        <div class="mode-btn ${status.mode === 'pull-only' ? 'active' : ''}" data-mode="pull-only">⬇ 仅拉取</div>
        <div class="mode-btn ${status.mode === 'bidirectional' ? 'active' : ''}" data-mode="bidirectional">↕ 双向</div>
      </div>
      <div class="schedule-row">
        <label>定时同步</label>
        <div class="toggle-switch ${status.scheduleEnabled ? 'on' : ''}" id="scheduleToggle"></div>
        <input type="number" id="scheduleInterval" value="${status.scheduleInterval || 30}" min="5" ${!status.scheduleEnabled ? 'disabled' : ''}>
        <span>分钟</span>
      </div>
    </div>
    <div class="action-buttons" id="actionButtons"></div>
    <div id="syncMsg"></div>
    <div class="section-toggle" data-section="key">
      <span class="section-toggle-title">🔑 加密密钥</span>
      <span class="section-toggle-info">已配置 ›</span>
    </div>
    <div class="section-body" id="section-key">
      <div class="btn-row">
        <button class="btn-sm outline" id="exportKeyBtn">导出密钥</button>
        <button class="btn-sm outline" id="reconfigKeyBtn">重新配置</button>
      </div>
      <div id="keyManageMsg"></div>
    </div>
    <div class="section-toggle" data-section="storage">
      <span class="section-toggle-title">⚙️ 后端配置</span>
      <span class="section-toggle-info">${status.storageType === 'gist' ? 'Gist' : 'WebDAV'} ›</span>
    </div>
    <div class="section-body" id="section-storage"></div>
    <div class="section-toggle" data-section="log">
      <span class="section-toggle-title">📋 同步日志</span>
      <span class="section-toggle-info">查看详情 ›</span>
    </div>
    <div class="section-body" id="section-log"></div>
  `;

  renderActionButtons(status.mode);
  bindCloudEvents(container, status);
}

function renderActionButtons(mode) {
  const container = document.getElementById("actionButtons");
  if (mode === "push-only") {
    container.innerHTML = `<button class="action-btn primary" id="pushBtn">⬆ 立即推送</button>`;
  } else if (mode === "pull-only") {
    container.innerHTML = `<button class="action-btn primary" id="pullBtn">⬇ 立即拉取</button>`;
  } else {
    container.innerHTML = `<button class="action-btn primary" id="syncBtn">↕ 立即同步</button>`;
  }
}

function bindSetupEvents(container) {
  // Export key button (when key already configured)
  document.getElementById("exportKeyBtn")?.addEventListener("click", async () => {
    const msg = document.getElementById("keyMsg");
    try {
      const resp = await sendMessage({ type: "cloudExportKey" });
      if (resp?.ok && resp.key) {
        msg.innerHTML = `<div class="cloud-msg info" style="word-break:break-all;"><strong>密钥（请安全保存）：</strong><br><input style="width:100%;font-family:monospace;font-size:10px;padding:4px;margin-top:4px;" value="${resp.key}" readonly onclick="this.select()"></div>`;
      }
    } catch (err) { msg.innerHTML = `<div class="cloud-msg error">${err.message}</div>`; }
  });

  // Reconfig key button: replace with full key setup form
  document.getElementById("reconfigKeyBtn")?.addEventListener("click", () => {
    const toggle = container.querySelector('[data-section="key-setup"]');
    const body = document.getElementById("section-key-setup");
    if (!toggle || !body) return;
    toggle.querySelector(".section-toggle-title").textContent = "🔑 配置加密密钥";
    toggle.querySelector(".section-toggle-info").textContent = "收起 ▾";
    toggle.querySelector(".section-toggle-info").style.color = "";
    body.innerHTML = `
      <div class="form-group">
        <label>选择密钥方式</label>
        <select id="keyType">
          <option value="random">自动生成（推荐）</option>
          <option value="password">从密码派生</option>
          <option value="import">导入已有密钥</option>
        </select>
      </div>
      <div id="key-password-input" style="display:none">
        <div class="form-group">
          <label>输入密码</label>
          <input type="password" id="keyPassword" placeholder="输入密码">
        </div>
      </div>
      <div id="key-import-input" style="display:none">
        <div class="form-group">
          <label>粘贴 Base64 密钥</label>
          <input type="text" id="keyImport" placeholder="粘贴导出的密钥字符串">
        </div>
      </div>
      <div class="btn-row">
        <button class="btn-sm primary" id="generateKeyBtn">生成密钥</button>
      </div>
      <div id="keyMsg"></div>`;
    if (!body.classList.contains("open")) body.classList.add("open");
    bindKeyFormEvents();
  });

  function bindKeyFormEvents() {
    const keyTypeSelect = document.getElementById("keyType");
    keyTypeSelect.addEventListener("change", () => {
      document.getElementById("key-password-input").style.display =
        keyTypeSelect.value === "password" ? "block" : "none";
      document.getElementById("key-import-input").style.display =
        keyTypeSelect.value === "import" ? "block" : "none";
      document.getElementById("generateKeyBtn").textContent =
        keyTypeSelect.value === "random" ? "生成密钥" :
        keyTypeSelect.value === "password" ? "派生密钥" : "导入密钥";
    });

    document.getElementById("generateKeyBtn").addEventListener("click", async () => {
      const msg = document.getElementById("keyMsg");
      const type = keyTypeSelect.value;
      try {
        let resp;
        if (type === "random") {
          resp = await sendMessage({ type: "cloudGenerateKey" });
        } else if (type === "password") {
          const password = document.getElementById("keyPassword").value;
          if (!password) { msg.innerHTML = '<div class="cloud-msg error">请输入密码</div>'; return; }
          resp = await sendMessage({ type: "cloudDeriveKey", password });
        } else {
          const key = document.getElementById("keyImport").value.trim();
          if (!key) { msg.innerHTML = '<div class="cloud-msg error">请粘贴密钥</div>'; return; }
          resp = await sendMessage({ type: "cloudImportKey", key });
        }
        if (resp?.ok) {
          msg.innerHTML = '<div class="cloud-msg success">密钥已更新！请安全保存导出的密钥以便在其他设备导入。</div>';
          const toggle = container.querySelector('[data-section="key-setup"]');
          if (toggle) {
            toggle.querySelector(".section-toggle-title").textContent = "🔑 加密密钥";
            const info = toggle.querySelector(".section-toggle-info");
            info.textContent = "✓ 已配置 ›";
            info.style.color = "#34c759";
          }
        } else {
          msg.innerHTML = `<div class="cloud-msg error">${resp?.error || "密钥配置失败"}</div>`;
        }
      } catch (err) {
        msg.innerHTML = `<div class="cloud-msg error">${err.message}</div>`;
      }
    });
  }

  container.querySelectorAll(".section-toggle").forEach((el) => {
    el.addEventListener("click", () => {
      const sectionId = `section-${el.dataset.section}`;
      const body = document.getElementById(sectionId);
      if (body) {
        body.classList.toggle("open");
        const info = el.querySelector(".section-toggle-info");
        if (el.dataset.section === "key-setup" && info.textContent.includes("已配置")) {
          info.textContent = body.classList.contains("open") ? "收起 ▾" : "✓ 已配置 ›";
        } else {
          info.textContent = body.classList.contains("open") ? "收起 ▾" : "必填 ›";
        }
      }
    });
  });

  if (document.getElementById("keyType")) bindKeyFormEvents();

  const storageTypeSelect = document.getElementById("storageType");
  storageTypeSelect.addEventListener("change", () => {
    document.getElementById("gist-config").style.display =
      storageTypeSelect.value === "gist" ? "block" : "none";
    document.getElementById("webdav-config").style.display =
      storageTypeSelect.value === "webdav" ? "block" : "none";
  });

  document.getElementById("testConnBtn").addEventListener("click", async () => {
    const msg = document.getElementById("storageMsg");
    msg.innerHTML = '<div class="cloud-msg info">测试连接中...</div>';
    try {
      const type = storageTypeSelect.value;
      let config = {};
      if (type === "gist") {
        config = { token: document.getElementById("gistToken").value, gistId: document.getElementById("gistId")?.value?.trim() || "" };
      } else {
        config = {
          url: document.getElementById("webdavUrl").value,
          username: document.getElementById("webdavUser").value,
          password: document.getElementById("webdavPass").value,
          filePath: document.getElementById("webdavPath").value,
        };
      }
      await sendMessage({ type: "cloudUpdateStorage", config: { type, config } });
      const resp = await sendMessage({ type: "cloudTestConnection" });
      msg.innerHTML = resp?.ok
        ? '<div class="cloud-msg success">连接成功！</div>'
        : '<div class="cloud-msg error">连接失败，请检查配置。</div>';
    } catch (err) {
      msg.innerHTML = `<div class="cloud-msg error">${err.message}</div>`;
    }
  });

  document.getElementById("saveStorageBtn").addEventListener("click", async () => {
    const msg = document.getElementById("storageMsg");
    const type = storageTypeSelect.value;
    let config = {};
    if (type === "gist") {
      config = { token: document.getElementById("gistToken").value, gistId: document.getElementById("gistId")?.value?.trim() || "" };
      if (!config.token) { msg.innerHTML = '<div class="cloud-msg error">请输入 GitHub Token</div>'; return; }
    } else {
      config = {
        url: document.getElementById("webdavUrl").value,
        username: document.getElementById("webdavUser").value,
        password: document.getElementById("webdavPass").value,
        filePath: document.getElementById("webdavPath").value || "/cookie-sync/cookies.enc",
      };
      if (!config.url || !config.username) { msg.innerHTML = '<div class="cloud-msg error">请填写必填字段</div>'; return; }
      // Request host permission for WebDAV URL
      try {
        const webdavOrigin = new URL(config.url).origin;
        const granted = await new Promise((resolve) => {
          chrome.permissions.request({ origins: [webdavOrigin + "/*"] }, (result) => {
            resolve(result !== false);
          });
        });
        if (!granted) {
          msg.innerHTML = '<div class="cloud-msg error">需要授予 WebDAV 服务器访问权限</div>';
          return;
        }
      } catch (err) {
        msg.innerHTML = `<div class="cloud-msg error">权限请求失败: ${err.message}</div>`;
        return;
      }
    }
    try {
      await sendMessage({ type: "cloudUpdateStorage", config: { type, config } });
      msg.innerHTML = '<div class="cloud-msg success">配置已保存。</div>';
      setTimeout(() => { cloudInitialized = false; initCloudTab(); }, 1000);
    } catch (err) {
      msg.innerHTML = `<div class="cloud-msg error">${err.message}</div>`;
    }
  });
}

function bindCloudEvents(container, status) {
  container.querySelectorAll(".section-toggle").forEach((el) => {
    el.addEventListener("click", async () => {
      const sectionId = `section-${el.dataset.section}`;
      const body = document.getElementById(sectionId);
      if (!body) return;
      const isOpen = body.classList.contains("open");
      body.classList.toggle("open");
      el.querySelector(".section-toggle-info").textContent =
        isOpen ? `${el.dataset.section === 'key' ? '已配置' : el.dataset.section === 'storage' ? (status.storageType === 'gist' ? 'Gist' : 'WebDAV') : '查看详情'} ›` : "收起 ▾";
      if (!isOpen && el.dataset.section === "log") { await loadSyncLog(body); }
      if (!isOpen && el.dataset.section === "storage") { await loadStorageConfig(body, status); }
    });
  });

  container.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      container.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      await sendMessage({ type: "cloudUpdateSettings", settings: { mode: btn.dataset.mode } });
      renderActionButtons(btn.dataset.mode);
      bindSyncActions();
    });
  });
  bindSyncActions();

  const scheduleToggle = document.getElementById("scheduleToggle");
  const intervalInput = document.getElementById("scheduleInterval");
  scheduleToggle.addEventListener("click", async () => {
    const isOn = scheduleToggle.classList.toggle("on");
    intervalInput.disabled = !isOn;
    await sendMessage({ type: "cloudUpdateSettings", settings: { scheduleEnabled: isOn } });
  });
  intervalInput.addEventListener("change", async () => {
    const val = parseInt(intervalInput.value, 10);
    if (val >= 5) { await sendMessage({ type: "cloudUpdateSettings", settings: { scheduleIntervalMinutes: val } }); }
  });

  document.getElementById("exportKeyBtn")?.addEventListener("click", async () => {
    const msg = document.getElementById("keyManageMsg");
    try {
      const resp = await sendMessage({ type: "cloudExportKey" });
      if (resp?.ok && resp.key) {
        msg.innerHTML = `<div class="cloud-msg info" style="word-break:break-all;"><strong>密钥（请安全保存）：</strong><br><input style="width:100%;font-family:monospace;font-size:10px;padding:4px;margin-top:4px;" value="${resp.key}" readonly onclick="this.select()"></div>`;
      } else {
        msg.innerHTML = `<div class="cloud-msg error">${resp?.error || "密钥未找到"}</div>`;
      }
    } catch (err) { msg.innerHTML = `<div class="cloud-msg error">${err.message}</div>`; }
  });

  document.getElementById("reconfigKeyBtn")?.addEventListener("click", () => {
    const body = document.getElementById("section-key");
    if (!body) return;
    body.innerHTML = `
      <div class="form-group">
        <label>选择密钥方式</label>
        <select id="keyType">
          <option value="random">自动生成（推荐）</option>
          <option value="password">从密码派生</option>
          <option value="import">导入已有密钥</option>
        </select>
      </div>
      <div id="key-password-input" style="display:none">
        <div class="form-group">
          <label>输入密码</label>
          <input type="password" id="keyPassword" placeholder="输入密码">
        </div>
      </div>
      <div id="key-import-input" style="display:none">
        <div class="form-group">
          <label>粘贴 Base64 密钥</label>
          <input type="text" id="keyImport" placeholder="粘贴导出的密钥字符串">
        </div>
      </div>
      <div class="btn-row">
        <button class="btn-sm primary" id="generateKeyBtn">生成密钥</button>
      </div>
      <div id="keyManageMsg"></div>`;
    if (!body.classList.contains("open")) body.classList.add("open");
    bindCloudKeyFormEvents(container);
  });
}

function bindCloudKeyFormEvents(container) {
  const keyTypeSelect = document.getElementById("keyType");
  keyTypeSelect.addEventListener("change", () => {
    document.getElementById("key-password-input").style.display =
      keyTypeSelect.value === "password" ? "block" : "none";
    document.getElementById("key-import-input").style.display =
      keyTypeSelect.value === "import" ? "block" : "none";
    document.getElementById("generateKeyBtn").textContent =
      keyTypeSelect.value === "random" ? "生成密钥" :
      keyTypeSelect.value === "password" ? "派生密钥" : "导入密钥";
  });

  document.getElementById("generateKeyBtn").addEventListener("click", async () => {
    const msg = document.getElementById("keyManageMsg");
    const type = keyTypeSelect.value;
    try {
      let resp;
      if (type === "random") {
        resp = await sendMessage({ type: "cloudGenerateKey" });
      } else if (type === "password") {
        const password = document.getElementById("keyPassword").value;
        if (!password) { msg.innerHTML = '<div class="cloud-msg error">请输入密码</div>'; return; }
        resp = await sendMessage({ type: "cloudDeriveKey", password });
      } else {
        const key = document.getElementById("keyImport").value.trim();
        if (!key) { msg.innerHTML = '<div class="cloud-msg error">请粘贴密钥</div>'; return; }
        resp = await sendMessage({ type: "cloudImportKey", key });
      }
      if (resp?.ok) {
        msg.innerHTML = '<div class="cloud-msg success">密钥已更新！请安全保存导出的密钥以便在其他设备导入。</div>';
      } else {
        msg.innerHTML = `<div class="cloud-msg error">${resp?.error || "密钥配置失败"}</div>`;
      }
    } catch (err) {
      msg.innerHTML = `<div class="cloud-msg error">${err.message}</div>`;
    }
  });
}

function bindSyncActions() {
  document.getElementById("pushBtn")?.addEventListener("click", () => doSync("cloudPush", "pushBtn"));
  document.getElementById("pullBtn")?.addEventListener("click", () => doSync("cloudPull", "pullBtn"));
  document.getElementById("syncBtn")?.addEventListener("click", () => doSync("cloudSync", "syncBtn"));
}

async function doSync(type, btnId) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  const originalText = btn.textContent;
  const msgArea = document.getElementById("syncMsg");
  btn.disabled = true;
  btn.textContent = "同步中...";
  if (msgArea) msgArea.innerHTML = "";
  console.log("[cloud-sync-popup] doSync start:", type);
  try {
    const resp = await Promise.race([
      sendMessage({ type }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("同步超时（30秒）")), 30000)),
    ]);
    console.log("[cloud-sync-popup] doSync response:", JSON.stringify(resp).slice(0, 200));
    if (resp?.success) {
      btn.textContent = "✓ 成功";
      let successMsg = "同步成功";
      if (resp.domains) successMsg += `，同步 ${resp.domains} 个域名`;
      if (msgArea) msgArea.innerHTML = `<div class="cloud-msg success">${successMsg}</div>`;

      // Handle skipped domains — request permissions here (user gesture available)
      if (resp.skippedDomains?.length > 0 && type !== "cloudPush") {
        await handleSkippedDomains(resp.skippedDomains, msgArea, btn, originalText, type);
        return;
      }

      setTimeout(() => { btn.textContent = originalText; btn.disabled = false; cloudInitialized = false; initCloudTab(); }, 2000);
    } else {
      btn.textContent = originalText;
      btn.disabled = false;
      const errMsg = resp?.error || "未知错误";
      if (msgArea) msgArea.innerHTML = `<div class="cloud-msg error">${errMsg}</div>`;
    }
  } catch (err) {
    btn.textContent = originalText;
    btn.disabled = false;
    if (msgArea) msgArea.innerHTML = `<div class="cloud-msg error">${err.message}</div>`;
  }
}

async function handleSkippedDomains(domains, msgArea, btn, originalText, syncType) {
  const allPatterns = domains.flatMap((d) => getOriginPatterns(d));
  const granted = await new Promise((resolve) => {
    chrome.permissions.request({ origins: allPatterns }, (result) => {
      resolve(result !== false);
    });
  });

  if (granted) {
    // Add domains to whitelist
    await sendMessage({ type: "cloudAddDomains", domains });
    document.dispatchEvent(new CustomEvent("domains-changed"));
    // Re-sync to write the previously skipped cookies
    if (msgArea) msgArea.innerHTML = '<div class="cloud-msg info">已授权新域名，正在重新同步...</div>';
    btn.textContent = "同步中...";
    try {
      const resp2 = await sendMessage({ type: syncType });
      if (resp2?.success) {
        let msg = `同步完成，同步 ${resp2.domains || 0} 个域名`;
        if (msgArea) msgArea.innerHTML = `<div class="cloud-msg success">${msg}</div>`;
      } else if (msgArea) {
        msgArea.innerHTML = `<div class="cloud-msg error">${resp2?.error || "重试失败"}</div>`;
      }
    } catch (err) {
      if (msgArea) msgArea.innerHTML = `<div class="cloud-msg error">${err.message}</div>`;
    }
  } else {
    if (msgArea) {
      msgArea.innerHTML = `<div class="cloud-msg success">同步完成，跳过 ${domains.length} 个未授权域名: ${domains.join(", ")}</div>`;
    }
  }
  setTimeout(() => { btn.textContent = originalText; btn.disabled = false; cloudInitialized = false; initCloudTab(); }, 2000);
}

async function loadSyncLog(container) {
  try {
    const resp = await sendMessage({ type: "cloudGetSyncLog" });
    const log = resp?.log || [];
    console.log("[cloud-sync] loadSyncLog: received", log.length, "entries, resp:", JSON.stringify(resp).slice(0, 200));
    if (log.length === 0) {
      container.innerHTML = '<div style="font-size:11px;color:#999;text-align:center;padding:8px;">暂无同步记录</div>';
      return;
    }
    container.innerHTML = log.map((entry) => {
      const time = new Date(entry.time).toLocaleString();
      const actionMap = { push: "推送", pull: "拉取", sync: "双向" };
      return `<div class="log-entry"><span class="log-time">${time}</span><span class="log-action">${actionMap[entry.action] || entry.action}</span><span class="log-status ${entry.status}">${entry.status === "success" ? "成功" : "失败"}</span></div>`;
    }).join("");
  } catch { container.innerHTML = '<div style="font-size:11px;color:#ff3b30;">加载日志失败</div>'; }
}

async function loadStorageConfig(container, status) {
  if (status.storageType === "gist") {
    container.innerHTML = `
      <div class="form-group"><label>GitHub Token</label><input type="password" id="editGistToken" placeholder="ghp_xxxxx"></div>
      <div class="btn-row"><button class="btn-sm primary" id="updateGistBtn">更新</button></div>
      <div id="storageUpdateMsg"></div>`;
    document.getElementById("updateGistBtn")?.addEventListener("click", async () => {
      const token = document.getElementById("editGistToken").value;
      if (token) {
        await sendMessage({ type: "cloudUpdateStorage", config: { type: "gist", config: { token } } });
        document.getElementById("storageUpdateMsg").innerHTML = '<div class="cloud-msg success">已更新</div>';
      }
    });
  } else {
    container.innerHTML = '<div style="font-size:11px;color:#999;text-align:center;padding:8px;">WebDAV 配置在初始设置时已保存。</div>';
  }
}
