// popup.js — Popup logic: tab switching, unified domain management

import { normalizeDomain, getRootDomain } from "../background/domain-utils.js";
import { initCloudTab } from "./cloud-tab.js";

// --- Tab switching ---
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "cloud") {
      initCloudTab();
    }
  });
});

// --- Domain Management ---
const PAGE_SIZE = 5;

const dot = document.getElementById("dot");
const status = document.getElementById("status");
const domainInput = document.getElementById("domainInput");
const addBtn = document.getElementById("addBtn");
const domainError = document.getElementById("domainError");
const domainList = document.getElementById("domainList");
const pagination = document.getElementById("pagination");

let allEntries = [];
let groupedData = [];
let currentPage = 1;
let expandedGroups = new Set();
let isAddingDomain = false;
let statusPollTimer = null;
const STATUS_HTML = {
  connected: "<strong>已连接 daemon</strong>",
  connecting: "<strong>重连中...</strong>",
  disconnected: "<strong>未连接 daemon</strong>",
};

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function setStatus(state) {
  dot.className = `dot ${state}`;
  status.innerHTML = STATUS_HTML[state];
}

function setConnectionStatus(resp) {
  if (resp?.connected) setStatus("connected");
  else if (resp?.reconnecting) setStatus("connecting");
  else setStatus("disconnected");
}

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

// --- Init ---
notifyPopupOpened();
refreshDomains();
document.addEventListener("domains-changed", () => refreshDomains());

function refreshStatus() {
  sendMessage({ type: "getStatus" })
    .then((resp) => { setConnectionStatus(resp); syncStatusPolling(resp); })
    .catch(() => { stopStatusPolling(); setStatus("disconnected"); });
}

function notifyPopupOpened() {
  sendMessage({ type: "popupOpened" })
    .then((resp) => { setConnectionStatus(resp); syncStatusPolling(resp); })
    .catch(() => refreshStatus());
}

function syncStatusPolling(resp) {
  if (resp?.connected || !resp?.reconnecting) { stopStatusPolling(); return; }
  if (statusPollTimer !== null) return;
  statusPollTimer = window.setInterval(() => refreshStatus(), 1000);
}

function stopStatusPolling() {
  if (statusPollTimer === null) return;
  window.clearInterval(statusPollTimer);
  statusPollTimer = null;
}

function refreshDomains() {
  sendMessage({ type: "getDomains" })
    .then((resp) => {
      allEntries = resp?.entries || [];
      buildGroups();
      render();
    })
    .catch(() => {});
}

function buildGroups() {
  const map = new Map();
  for (const entry of allEntries) {
    const root = getRootDomain(entry.domain);
    const group = map.get(root) || [];
    group.push(entry);
    map.set(root, group);
  }
  groupedData = [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([root, entries]) => ({ root, entries: entries.sort((a, b) => a.domain.localeCompare(b.domain)) }));
}

function render() { renderDomainList(); renderPagination(); }

function renderDomainList() {
  if (groupedData.length === 0) {
    domainList.innerHTML = '<div class="domain-empty">暂无域名，请添加。</div>';
    return;
  }
  const totalPages = Math.max(1, Math.ceil(groupedData.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = 1;
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageGroups = groupedData.slice(start, start + PAGE_SIZE);

  domainList.innerHTML = pageGroups.map((group, groupIdx) => {
    const isExpanded = expandedGroups.has(group.root);
    const childrenHtml = group.entries.map((entry, domainIdx) => {
      const localClass = entry.localAccess ? "toggle-on" : "toggle-off";
      const localText = entry.localAccess ? "本地ON" : "本地OFF";
      let cloudClass = "";
      let cloudText = "";
      let cloudAction = "";
      if (entry.cloudSync === "enabled") {
        cloudClass = "badge-enabled";
        cloudText = "云端ON";
        cloudAction = "disable-cloud";
      } else if (entry.cloudSync === "pending") {
        cloudClass = "badge-pending";
        cloudText = "待确认";
        cloudAction = "enable-cloud";
      } else {
        cloudClass = "badge-disabled";
        cloudText = "云端OFF";
        cloudAction = "enable-cloud";
      }
      return `
        <div class="subdomain-item" data-domain="${escapeHtml(entry.domain)}">
          <span class="domain-name">${escapeHtml(entry.domain)}</span>
          <div class="domain-controls">
            <button class="toggle-btn ${localClass}" data-action="local" data-group-idx="${groupIdx}" data-domain-idx="${domainIdx}" title="允许本地 daemon 获取此域名 cookie">${localText}</button>
            <span class="badge ${cloudClass}" data-action="${cloudAction}" data-domain="${escapeHtml(entry.domain)}" title="点击切换云端同步">${cloudText}</span>
            <button class="remove-btn" data-action="remove" data-group-idx="${groupIdx}" data-domain-idx="${domainIdx}" title="删除">x</button>
          </div>
        </div>
      `;
    }).join("");
    return `
      <div class="domain-group">
        <div class="group-header" data-group-root="${groupIdx}">
          <span class="group-arrow ${isExpanded ? 'expanded' : ''}">&#9654;</span>
          <span class="group-name">${escapeHtml(group.root)}</span>
          <span class="group-count">${group.entries.length}</span>
        </div>
        <div class="group-children ${isExpanded ? 'expanded' : ''}">${childrenHtml}</div>
      </div>`;
  }).join("");

  domainList.querySelectorAll(".group-header").forEach((header) => {
    header.addEventListener("click", () => {
      const groupIdx = parseInt(header.dataset.groupRoot, 10);
      const root = pageGroups[groupIdx]?.root;
      if (!root) return;
      if (expandedGroups.has(root)) expandedGroups.delete(root);
      else expandedGroups.add(root);
      render();
    });
  });
  domainList.querySelectorAll("button[data-action='local']").forEach((btn) => {
    btn.addEventListener("click", (e) => handleToggleLocal(e, btn, pageGroups));
  });
  domainList.querySelectorAll("button[data-action='remove']").forEach((btn) => {
    btn.addEventListener("click", (e) => handleRemoveDomain(e, btn, pageGroups));
  });
  domainList.querySelectorAll(".badge[data-action='enable-cloud']").forEach((badge) => {
    badge.style.cursor = "pointer";
    badge.addEventListener("click", () => handleSetCloudSync(badge.dataset.domain, "enabled"));
  });
  domainList.querySelectorAll(".badge[data-action='disable-cloud']").forEach((badge) => {
    badge.style.cursor = "pointer";
    badge.addEventListener("click", () => handleSetCloudSync(badge.dataset.domain, "disabled"));
  });
}

function renderPagination() {
  const totalPages = Math.max(1, Math.ceil(groupedData.length / PAGE_SIZE));
  if (totalPages <= 1) { pagination.innerHTML = ""; return; }
  pagination.innerHTML = `
    <button id="prevPage" ${currentPage <= 1 ? "disabled" : ""}>上一页</button>
    <span class="page-info">${currentPage} / ${totalPages}</span>
    <button id="nextPage" ${currentPage >= totalPages ? "disabled" : ""}>下一页</button>
  `;
  document.getElementById("prevPage").addEventListener("click", () => { if (currentPage > 1) { currentPage--; render(); } });
  document.getElementById("nextPage").addEventListener("click", () => { if (currentPage < totalPages) { currentPage++; render(); } });
}

addBtn.addEventListener("click", async () => {
  if (isAddingDomain) return;
  const raw = domainInput.value.trim();
  const domain = normalizeDomain(raw);
  domainError.textContent = "";
  if (!domain) { domainError.textContent = "请输入有效域名"; return; }
  if (!domain.includes(".")) { domainError.textContent = "域名必须包含点号"; return; }
  if (allEntries.some((e) => e.domain === domain)) { domainError.textContent = "域名已存在"; return; }
  isAddingDomain = true;
  addBtn.disabled = true;
  try {
    const resp = await sendMessage({ type: "addDomain", domain });
    if (resp?.ok) {
      domainInput.value = "";
      domainError.textContent = "";
      expandedGroups.add(getRootDomain(domain));
      refreshDomains();
    } else {
      domainError.textContent = resp?.error || "添加失败";
    }
  } finally { isAddingDomain = false; addBtn.disabled = false; }
});

domainInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addBtn.click(); });

async function handleToggleLocal(event, button, pageGroups) {
  event.stopPropagation();
  const groupIdx = parseInt(button.dataset.groupIdx, 10);
  const domainIdx = parseInt(button.dataset.domainIdx, 10);
  const entry = pageGroups[groupIdx]?.entries[domainIdx];
  if (!entry) return;
  const newValue = !entry.localAccess;
  const resp = await sendMessage({ type: "setLocalAccess", domain: entry.domain, value: newValue });
  if (resp?.ok) refreshDomains();
}

async function handleRemoveDomain(event, button, pageGroups) {
  event.stopPropagation();
  const groupIdx = parseInt(button.dataset.groupIdx, 10);
  const domainIdx = parseInt(button.dataset.domainIdx, 10);
  const entry = pageGroups[groupIdx]?.entries[domainIdx];
  if (!entry) return;
  button.disabled = true;
  try {
    const resp = await sendMessage({ type: "removeDomain", domain: entry.domain });
    if (resp?.ok) { refreshDomains(); }
    else { alert("删除失败: " + (resp?.error || "未知错误")); }
  } finally { button.disabled = false; }
}

async function handleSetCloudSync(domain, status) {
  if (!domain) return;
  const resp = await sendMessage({ type: "setCloudSync", domain, status });
  if (resp?.ok) refreshDomains();
}
