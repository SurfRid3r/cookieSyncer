# Scheduled Sync Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two bugs in the Chrome extension that prevent the scheduled cloud sync alarm from ever firing.

**Architecture:** Bug 1 — `setupAlarm()` unconditionally clears+recreates the Chrome alarm on every `init()` call, resetting the countdown. Fix: check existing alarm before recreating. Bug 2 — `handleAlarm` listener is registered inside async `init()`, so it's not ready when the SW is woken by the alarm itself. Fix: handle `cloud-sync` in the top-level synchronous `onAlarm` listener in `main.js`.

**Tech Stack:** Chrome Extension Manifest V3, vanilla ES modules, Chrome Alarms API (`chrome.alarms`), Chrome Service Worker lifecycle.

---

## File Map

| File | Change |
|------|--------|
| `cookie-sync-extension/background/cloud/sync-engine.js` | `setupAlarm()` → async + idempotent; extract `triggerScheduledSync()`; update callers (`init`, `updateSettings`, `handleSyncError`) |
| `cookie-sync-extension/background/main.js` | Top-level `onAlarm` listener handles `cloud-sync` alarm |

---

## Task 1: Create worktree for parallel development

**Files:**
- No file changes — git worktree setup only

- [ ] **Step 1: Create a new worktree branching from `feat/cloud-sync`**

Run from the repo root:

```bash
git worktree add .claude/worktrees/fix-scheduled-sync -b fix/scheduled-sync
```

Expected output:
```
Preparing worktree (new branch 'fix/scheduled-sync')
HEAD is now at 6c6a8c5 docs: add scheduled sync fix design spec
```

- [ ] **Step 2: Verify worktree exists**

```bash
git worktree list
```

Expected: two entries — the main tree on `feat/cloud-sync` and the new worktree on `fix/scheduled-sync`.

---

## Task 2: Make `setupAlarm()` async and idempotent

**Files:**
- Modify: `cookie-sync-extension/background/cloud/sync-engine.js:16-22` (init)
- Modify: `cookie-sync-extension/background/cloud/sync-engine.js:190-198` (updateSettings)
- Modify: `cookie-sync-extension/background/cloud/sync-engine.js:227-237` (setupAlarm)
- Modify: `cookie-sync-extension/background/cloud/sync-engine.js:247-262` (handleSyncError)

- [ ] **Step 1: Replace `setupAlarm()` with the async idempotent version**

In `cookie-sync-extension/background/cloud/sync-engine.js`, replace lines 227–237:

```js
// BEFORE
function setupAlarm() {
  chrome.alarms.onAlarm.removeListener(handleAlarm);
  chrome.alarms.clear(ALARM_NAME);

  const cfg = config.get();
  if (!cfg.scheduleEnabled) return;

  const interval = Math.max(MIN_INTERVAL, cfg.scheduleIntervalMinutes);
  chrome.alarms.onAlarm.addListener(handleAlarm);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: interval });
}
```

```js
// AFTER
async function setupAlarm() {
  const cfg = config.get();

  if (!cfg.scheduleEnabled) {
    chrome.alarms.onAlarm.removeListener(handleAlarm);
    chrome.alarms.clear(ALARM_NAME);
    return;
  }

  const interval = Math.max(MIN_INTERVAL, cfg.scheduleIntervalMinutes);
  chrome.alarms.onAlarm.removeListener(handleAlarm);
  chrome.alarms.onAlarm.addListener(handleAlarm);

  // Only recreate the alarm if it doesn't exist or the period changed.
  // Unconditional clear+create would reset the countdown on every SW restart.
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing || existing.periodInMinutes !== interval) {
    chrome.alarms.clear(ALARM_NAME);
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: interval });
    console.log("[cloud-sync] alarm created/updated, interval:", interval, "min");
  } else {
    console.log("[cloud-sync] alarm already exists, interval:", interval, "min — not reset");
  }
}
```

- [ ] **Step 2: Add `await` to the `setupAlarm()` call in `init()`**

Replace lines 16–22:

```js
// BEFORE
export async function init() {
  console.log("[cloud-sync] init start");
  await config.init();
  await initAdapter();
  await initCryptoKey();
  setupAlarm();
  console.log("[cloud-sync] init done, configured:", config.isConfigured(), "storage:", config.get().storageType);
}
```

```js
// AFTER
export async function init() {
  console.log("[cloud-sync] init start");
  await config.init();
  await initAdapter();
  await initCryptoKey();
  await setupAlarm();
  console.log("[cloud-sync] init done, configured:", config.isConfigured(), "storage:", config.get().storageType);
}
```

- [ ] **Step 3: Add `await` to the `setupAlarm()` call in `updateSettings()`**

Replace lines 190–198:

```js
// BEFORE
export async function updateSettings(settings) {
  if (settings.mode) await config.update({ mode: settings.mode });
  if (settings.scheduleEnabled !== undefined) await config.update({ scheduleEnabled: settings.scheduleEnabled });
  if (settings.scheduleIntervalMinutes) {
    const interval = Math.max(MIN_INTERVAL, settings.scheduleIntervalMinutes);
    await config.update({ scheduleIntervalMinutes: interval });
  }
  setupAlarm();
}
```

```js
// AFTER
export async function updateSettings(settings) {
  if (settings.mode) await config.update({ mode: settings.mode });
  if (settings.scheduleEnabled !== undefined) await config.update({ scheduleEnabled: settings.scheduleEnabled });
  if (settings.scheduleIntervalMinutes) {
    const interval = Math.max(MIN_INTERVAL, settings.scheduleIntervalMinutes);
    await config.update({ scheduleIntervalMinutes: interval });
  }
  await setupAlarm();
}
```

- [ ] **Step 4: Add `await` to the `setupAlarm()` call in `handleSyncError()`**

Replace lines 247–262:

```js
// BEFORE
function handleSyncError(err) {
  console.error("[cloud-sync] Scheduled sync failed:", err);
  const msg = err.message || "";
  // Stop scheduled sync on auth failures (expired/revoked token or password)
  if (msg.includes("authentication failed") || msg.includes("401")) {
    console.warn("[cloud-sync] Auth failure detected, stopping scheduled sync");
    config.update({ scheduleEnabled: false });
    setupAlarm();
  }
  config.addSyncLogEntry({
    time: Date.now(),
    action: config.get().mode,
    status: "error",
    error: msg,
  });
}
```

```js
// AFTER
function handleSyncError(err) {
  console.error("[cloud-sync] Scheduled sync failed:", err);
  const msg = err.message || "";
  // Stop scheduled sync on auth failures (expired/revoked token or password)
  if (msg.includes("authentication failed") || msg.includes("401")) {
    console.warn("[cloud-sync] Auth failure detected, stopping scheduled sync");
    config.update({ scheduleEnabled: false }).then(() => setupAlarm());
  }
  config.addSyncLogEntry({
    time: Date.now(),
    action: config.get().mode,
    status: "error",
    error: msg,
  });
}
```

- [ ] **Step 5: Commit**

```bash
git add cookie-sync-extension/background/cloud/sync-engine.js
git commit -m "fix: make setupAlarm idempotent to prevent countdown reset on SW restart"
```

---

## Task 3: Extract `triggerScheduledSync()` and simplify `handleAlarm()`

**Files:**
- Modify: `cookie-sync-extension/background/cloud/sync-engine.js:239-245` (handleAlarm)

- [ ] **Step 1: Replace `handleAlarm()` with two functions**

Replace lines 239–245 in `sync-engine.js`:

```js
// BEFORE
function handleAlarm(alarm) {
  if (alarm.name !== ALARM_NAME) return;
  const mode = config.get().mode;
  if (mode === "push-only") push().catch(handleSyncError);
  else if (mode === "pull-only") pull().catch(handleSyncError);
  else sync().catch(handleSyncError);
}
```

```js
// AFTER
export function triggerScheduledSync() {
  const mode = config.get().mode;
  if (mode === "push-only") push().catch(handleSyncError);
  else if (mode === "pull-only") pull().catch(handleSyncError);
  else sync().catch(handleSyncError);
}

function handleAlarm(alarm) {
  if (alarm.name !== ALARM_NAME) return;
  triggerScheduledSync();
}
```

- [ ] **Step 2: Commit**

```bash
git add cookie-sync-extension/background/cloud/sync-engine.js
git commit -m "fix: export triggerScheduledSync for top-level alarm handler"
```

---

## Task 4: Handle `cloud-sync` alarm in `main.js` top-level listener

**Files:**
- Modify: `cookie-sync-extension/background/main.js:201-205`

- [ ] **Step 1: Update the top-level `onAlarm` listener**

In `cookie-sync-extension/background/main.js`, replace lines 201–205:

```js
// BEFORE
// --- Alarm: keep SW alive + reconnect ---
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    void ensureReady();
  }
});
```

```js
// AFTER
// --- Alarm: keep SW alive + reconnect + scheduled sync ---
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    void ensureReady();
  } else if (alarm.name === "cloud-sync") {
    // Ensure initialization is complete before triggering sync.
    // Needed when SW is woken by the alarm itself (before async init() finishes).
    void ensureReady().then(() => cloudSync.triggerScheduledSync());
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add cookie-sync-extension/background/main.js
git commit -m "fix: handle cloud-sync alarm in top-level listener to prevent race condition"
```

---

## Task 5: Manual end-to-end verification

**Files:**
- No code changes — verification only

- [ ] **Step 1: Load the extension in Chrome**

1. Open `chrome://extensions`
2. Enable "Developer mode" (top-right toggle)
3. Click "Load unpacked" → select `cookie-sync-extension/`
4. Confirm the extension loads without errors

- [ ] **Step 2: Open the extension's Service Worker DevTools**

On the extensions page, click the "Service Worker" link next to the cookie-sync extension. This opens a DevTools console attached to the background SW.

- [ ] **Step 3: Enable scheduled sync and verify alarm is created**

1. Open the extension popup → Cloud tab
2. Configure a storage backend + encryption key (required for `isConfigured()` to return true)
3. Enable the schedule toggle, set interval to 5 (minimum)
4. In the SW DevTools console, run:

```js
chrome.alarms.getAll(alarms => console.log(alarms))
```

Expected output includes an alarm named `"cloud-sync"` with `periodInMinutes: 5`.

- [ ] **Step 4: Simulate SW restart and verify alarm is NOT reset**

1. In the SW DevTools console, run to record the current alarm's scheduled fire time:

```js
chrome.alarms.get("cloud-sync", a => console.log("scheduledTime:", a?.scheduledTime, "now:", Date.now()))
```

2. Force SW termination: in `chrome://extensions`, click the extension's Service Worker link, then in DevTools → Application → Service Workers → click "Stop".

3. Wait 2 seconds, then interact with the extension (open popup) to wake the SW.

4. In the SW DevTools console (may need to reattach), run again:

```js
chrome.alarms.get("cloud-sync", a => console.log("scheduledTime:", a?.scheduledTime, "now:", Date.now()))
```

Expected: `scheduledTime` is the SAME value as before (alarm not reset). If it was reset, `scheduledTime` would be `now + 5 minutes`.

The console should also show the log line:
```
[cloud-sync] alarm already exists, interval: 5 min — not reset
```

- [ ] **Step 5: Verify sync triggers when alarm fires**

Wait for the alarm to fire (up to 5 minutes with minimum interval). In the SW DevTools console, confirm you see:

```
[cloud-sync] Scheduled sync failed: ...
```

or (if configured correctly):

```
[cloud-sync] push start
[cloud-sync] push done: ...
```

This confirms `triggerScheduledSync()` is being called by the top-level alarm handler.

- [ ] **Step 6: Final commit — bump version or add changelog entry (optional)**

If the project tracks changes, note this fix. Otherwise skip.

---

## Self-Review Checklist

- [x] **Spec coverage**: Bug 1 (alarm reset) → Task 2. Bug 2 (race condition) → Tasks 3–4. Worktree → Task 1.
- [x] **No placeholders**: All steps contain exact code diffs.
- [x] **Type consistency**: `triggerScheduledSync()` defined in Task 3, used in Task 4 — matches.
- [x] **`handleSyncError` caller**: `setupAlarm()` is also called from `handleSyncError` at line 254 — covered in Task 2, Step 4.
- [x] **`await` in `handleSyncError`**: `handleSyncError` is a synchronous error handler called via `.catch()`. It can't be made async without losing the fire-and-forget pattern. Using `.then()` chain is the correct approach.
