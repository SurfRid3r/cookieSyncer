# 定时同步修复设计

> 日期：2026-04-19
> 状态：待审核
> 分支：worktree（基于 feat/cloud-sync）

## 背景

定时同步功能（`scheduleEnabled` + `scheduleIntervalMinutes`）从未实际触发过。根因是两个独立的 bug，共同导致 Chrome Alarm 要么被反复重置、要么触发时无监听器响应。

## 根因分析

### Bug 1 — Alarm 被反复重置（主因）

`setupAlarm()` 每次执行都无条件 `chrome.alarms.clear` 再 `chrome.alarms.create`，重置 30 分钟倒计时。

触发路径：
1. Chrome 在 ~30 秒不活跃后杀死 Service Worker（SW）
2. keepalive 闹钟（每 24 秒）唤醒 SW，`initialized` 被重置为 `false`
3. `ensureReady()` → `initialize()` → `cloudSync.init()` → `setupAlarm()`
4. **云同步闹钟倒计时被重置**
5. 回到步骤 1，形成死循环

只要 keepalive（24s）比同步间隔（最短 5 分钟）先到，云同步闹钟就永远无法触发。

### Bug 2 — 竞态条件（次因）

`handleAlarm` 监听器在异步 `init()` 内部注册。如果 SW 恰好被 `cloud-sync` 闹钟唤醒（而非 keepalive），此时 `init()` 尚未完成，闹钟事件直接丢失。同时 `main.js` 顶层的 `onAlarm` 监听器只处理 `keepalive`，完全忽略 `cloud-sync`。

## 修复方案

### 变更 1：`sync-engine.js` — `setupAlarm()` 改为幂等

```js
// 修复前
function setupAlarm() {
  chrome.alarms.onAlarm.removeListener(handleAlarm);
  chrome.alarms.clear(ALARM_NAME);  // 无条件重置
  ...
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: interval });
}

// 修复后
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

  // 只有闹钟不存在或 interval 变化时才重建（避免重置计时器）
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing || existing.periodInMinutes !== interval) {
    chrome.alarms.clear(ALARM_NAME);
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: interval });
  }
}
```

由于 `setupAlarm()` 变为 async，`init()` 和 `updateSettings()` 中对应调用处需加 `await`。

### 变更 2：`sync-engine.js` — 提取 `triggerScheduledSync()`

将 `handleAlarm()` 的核心逻辑提取为导出函数，供 `main.js` 调用，消除重复：

```js
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

### 变更 3：`main.js` — 顶层监听器补充 cloud-sync 处理

```js
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    void ensureReady();
  } else if (alarm.name === "cloud-sync") {
    // SW 被闹钟唤醒时，先完成初始化再触发同步
    void ensureReady().then(() => cloudSync.triggerScheduledSync());
  }
});
```

`ensureReady()` 内部有 `initialized` 守卫，多次调用安全，不会重复初始化。

## 受影响文件

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `background/cloud/sync-engine.js` | 修改 | `setupAlarm()` async 化 + 幂等逻辑；提取 `triggerScheduledSync()` |
| `background/main.js` | 修改 | 顶层 `onAlarm` 补充 `cloud-sync` 处理 |

## 不在范围内

- UI 变更（不显示下次同步时间或倒计时）
- 区分手动 vs 自动触发的日志标记
- 其他同步逻辑（push/pull/bidirectional 行为不变）
