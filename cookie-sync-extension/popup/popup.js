// popup.js — Popup logic: tab switching, domain management, cloud sync

import { normalizeDomain, getOriginPatterns, getRootDomain } from "../background/domain-utils.js";
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

let allDomains = [];
let groupedData = [];
let currentPage = 1;
let expandedGroups = new Set();
let isAddingDomain = false;
let statusPollTimer = null;
const STATUS_HTML = {
  connected: "<strong>Connected to daemon</strong>",
  connecting: "<strong>Reconnecting...</strong>",
  disconnected: "<strong>No daemon connected</strong>",
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

function updateOriginsPermission(method, origins) {
  return new Promise((resolve, reject) => {
    chrome.permissions[method]({ origins }, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result !== false);
    });
  });
}

// --- Init ---
notifyPopupOpened();
refreshDomains();

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
    .then((resp) => { allDomains = resp?.domains || []; buildGroups(); render(); })
    .catch(() => {});
}

function buildGroups() {
  const map = new Map();
  for (const d of allDomains) {
    const root = getRootDomain(d);
    const group = map.get(root) || [];
    group.push(d);
    map.set(root, group);
  }
  groupedData = [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([root, domains]) => ({ root, domains: domains.sort() }));
}

function render() { renderDomainList(); renderPagination(); }

function renderDomainList() {
  if (groupedData.length === 0) {
    domainList.innerHTML = '<div class="domain-empty">No domains allowed yet. Add one above.</div>';
    return;
  }
  const totalPages = Math.max(1, Math.ceil(groupedData.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = 1;
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageGroups = groupedData.slice(start, start + PAGE_SIZE);

  domainList.innerHTML = pageGroups.map((group, groupIdx) => {
    const isExpanded = expandedGroups.has(group.root);
    const childrenHtml = group.domains.map((d, domainIdx) => `
      <div class="subdomain-item">
        <span>${escapeHtml(d)}</span>
        <button data-group-idx="${groupIdx}" data-domain-idx="${domainIdx}">Remove</button>
      </div>
    `).join("");
    return `
      <div class="domain-group">
        <div class="group-header" data-group-root="${groupIdx}">
          <span class="group-arrow ${isExpanded ? 'expanded' : ''}">&#9654;</span>
          <span class="group-name">${escapeHtml(group.root)}</span>
          <span class="group-count">${group.domains.length}</span>
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
  domainList.querySelectorAll("button[data-domain-idx]").forEach((btn) => {
    btn.addEventListener("click", (e) => handleRemoveDomain(e, btn, pageGroups));
  });
}

function renderPagination() {
  const totalPages = Math.max(1, Math.ceil(groupedData.length / PAGE_SIZE));
  if (totalPages <= 1) { pagination.innerHTML = ""; return; }
  pagination.innerHTML = `
    <button id="prevPage" ${currentPage <= 1 ? "disabled" : ""}>Prev</button>
    <span class="page-info">${currentPage} / ${totalPages}</span>
    <button id="nextPage" ${currentPage >= totalPages ? "disabled" : ""}>Next</button>
  `;
  document.getElementById("prevPage").addEventListener("click", () => { if (currentPage > 1) { currentPage--; render(); } });
  document.getElementById("nextPage").addEventListener("click", () => { if (currentPage < totalPages) { currentPage++; render(); } });
}

addBtn.addEventListener("click", async () => {
  if (isAddingDomain) return;
  const raw = domainInput.value.trim();
  const domain = normalizeDomain(raw);
  domainError.textContent = "";
  if (!domain) { domainError.textContent = "Please enter a valid domain"; return; }
  if (!domain.includes(".")) { domainError.textContent = "Domain must contain a dot"; return; }
  if (allDomains.includes(domain)) { domainError.textContent = "Domain already allowed"; return; }
  isAddingDomain = true;
  addBtn.disabled = true;
  try {
    await sendMessage({ type: "pendingDomain", domain });
    let granted = false;
    try { granted = await updateOriginsPermission("request", getOriginPatterns(domain)); }
    catch (err) { domainError.textContent = err.message; }
    if (!granted) { if (!domainError.textContent) domainError.textContent = "Permission denied"; return; }
    const resp = await sendMessage({ type: "confirmDomain", domain });
    if (resp?.ok) { domainInput.value = ""; domainError.textContent = ""; expandedGroups.add(getRootDomain(domain)); refreshDomains(); }
    else { domainError.textContent = resp?.error || "Failed to add domain"; }
  } finally { isAddingDomain = false; addBtn.disabled = false; }
});

domainInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addBtn.click(); });

async function handleRemoveDomain(event, button, pageGroups) {
  event.stopPropagation();
  const groupIdx = parseInt(button.dataset.groupIdx, 10);
  const domainIdx = parseInt(button.dataset.domainIdx, 10);
  const domain = pageGroups[groupIdx]?.domains[domainIdx];
  if (!domain) return;
  button.disabled = true;
  domainError.textContent = "";
  try {
    let removed = false;
    try { removed = await updateOriginsPermission("remove", getOriginPatterns(domain)); }
    catch (err) { domainError.textContent = err.message; return; }
    if (!removed) { domainError.textContent = "Chrome did not revoke the permission"; return; }
    const resp = await sendMessage({ type: "removeDomain", domain, skipPermissionRevoke: true });
    if (resp?.ok) { refreshDomains(); domainError.textContent = "Domain removed."; return; }
    domainError.textContent = "";
    alert("Failed to remove: " + (resp?.error || "Unknown error"));
  } finally { button.disabled = false; }
}
