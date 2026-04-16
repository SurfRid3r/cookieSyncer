# Cookie Cloud Sync 功能设计文档

> 日期: 2026-04-16
> 状态: 已批准

## 概述

为 cookie-sync-extension 增加多主机之间 cookie 云端同步功能。支持加密上传到云端存储、从云端下载恢复，实现跨设备 cookie 同步。

### 核心需求

- Cookie + localStorage 上云，按域名白名单过滤（复用现有白名单）
- AES-256-GCM 加密，密钥本地生成/管理
- 多种同步模式：仅推送、仅拉取、双向（时间戳冲突解决）
- 定时同步（可配置间隔）+ 手动触发
- 存储后端：Gist + WebDAV，统一抽象层
- 纯扩展端实现，不依赖本地 Python daemon

---

## 1. 整体架构

### 目录结构

```
cookie-sync-extension/
├── manifest.json              # 新增权限
├── background/
│   ├── main.js                # 现有（新增 cloud 模块初始化调用）
│   ├── connection.js          # 现有（不变）
│   ├── cookie-ops.js          # 现有（不变）
│   ├── domain-utils.js        # 现有（不变）
│   ├── whitelist.js           # 现有（不变）
│   └── cloud/                 # 新增
│       ├── sync-engine.js     # 同步引擎
│       ├── crypto.js          # 加解密 + 密钥管理
│       ├── storage-adapter.js # 统一存储接口
│       ├── gist-adapter.js    # Gist 后端
│       ├── webdav-adapter.js  # WebDAV 后端
│       ├── data-collector.js  # 数据收集器
│       └── conflict.js        # 冲突解决
├── popup/
│   ├── popup.html             # 新增 Tab 切换结构
│   ├── popup.js               # 新增 Tab 路由
│   └── cloud-tab.js           # 云同步 Tab 逻辑
└── icons/                     # 现有（不变）
```

### 数据流

**Push:**
```
触发 → data-collector 按白名单收集 cookie + localStorage
     → crypto AES-256-GCM 加密
     → storage-adapter 上传到 Gist/WebDAV
```

**Pull:**
```
触发 → storage-adapter 从 Gist/WebDAV 下载
     → crypto 解密
     → conflict 时间戳对比解决冲突
     → chrome.cookies.set / content script 写入
```

**Bidirectional:**
```
先 Pull 合并 → 重新收集本地数据（已含合并结果）→ Push
Pull 成功后才执行 Push（原子性保证）
```

---

## 2. 加密与密钥管理

### 加密方案

- **算法**: AES-256-GCM（Web Crypto API 原生支持，无需第三方库）
- **IV**: 每次加密随机生成 12 字节 IV
- **GCM 自带认证**: 无需额外完整性校验

### 密钥管理

**两种密钥来源:**

| 方式 | 说明 |
|------|------|
| 本地随机生成 | `crypto.subtle.generateKey()` 生成 256 位密钥（默认） |
| 密码导入 | PBKDF2 从用户密码派生密钥 |

**密钥操作:**

| 功能 | 说明 |
|------|------|
| `generateKey()` | Web Crypto API 生成 AES-256-GCM 随机密钥 |
| `importFromPassword(password, salt)` | PBKDF2 从用户密码派生密钥 |
| `exportKey(key)` | 导出为 Base64 字符串供跨设备传输 |
| `importKey(base64Str)` | 从 Base64 字符串导入密钥 |
| `encrypt(data, key)` | AES-256-GCM 加密 |
| `decrypt(encrypted, key)` | 解密并验证完整性 |

**密钥存储:** 仅存 `chrome.storage.local`，不使用 `chrome.storage.sync`（避免密钥通过 Chrome Sync 泄漏）。

### 云端加密数据格式

```json
{
  "version": 1,
  "crypto": "aes-256-gcm",
  "keyType": "random | pbkdf2",
  "iv": "<Base64 编码的 12 字节随机 IV>",
  "data": "<Base64 编码的密文（含 GCM auth tag）>"
}
```

### 同步数据格式（加密前）

```json
{
  "version": 1,
  "timestamp": 1713244800000,
  "cookies": {
    ".example.com": [
      {
        "name": "session_id",
        "value": "abc123",
        "domain": ".example.com",
        "path": "/",
        "secure": true,
        "httpOnly": true,
        "sameSite": "Lax",
        "expirationDate": 1713331200000,
        "lastModified": 1713244800000
      }
    ]
  },
  "localStorages": {
    "https://example.com": {
      "theme": "dark"
    }
  }
}
```

---

## 3. 存储后端

### 统一接口 (storage-adapter.js)

```typescript
interface StorageAdapter {
  init(config): Promise<void>
  upload(encryptedData: string): Promise<boolean>
  download(): Promise<string | null>
  getLastModified(): Promise<number | null>
  testConnection(): Promise<boolean>
}
```

### Gist 后端 (gist-adapter.js)

| 项目 | 说明 |
|------|------|
| 认证 | GitHub Personal Access Token |
| 存储 | 单个 Secret Gist，文件名 `cookie-sync.enc` |
| 上传 | `PATCH /gists/{gist_id}` |
| 下载 | `GET /gists/{gist_id}` |
| 首次 | 自动创建 Secret Gist，记录 Gist ID |

配置:
```json
{
  "type": "gist",
  "token": "ghp_xxxxx",
  "gistId": "<自动创建或手动指定>"
}
```

### WebDAV 后端 (webdav-adapter.js)

| 项目 | 说明 |
|------|------|
| 认证 | Basic Auth（用户名 + 应用密码） |
| 存储 | 指定路径单文件，如 `/dav/cookie-sync/cookies.enc` |
| 上传 | `PUT /path/cookies.enc` |
| 下载 | `GET /path/cookies.enc` |
| 修改时间 | `HEAD` 获取 `Last-Modified` |
| 兼容 | 坚果云、NextCloud、群晖、rclone 等 |

配置:
```json
{
  "type": "webdav",
  "url": "https://dav.jianguoyun.com/dav/",
  "username": "user@example.com",
  "password": "应用专用密码",
  "filePath": "/cookie-sync/cookies.enc"
}
```

---

## 4. 同步引擎

### 同步模式

| 模式 | 说明 |
|------|------|
| push-only | 仅推送本地数据到云端（定时/手动） |
| pull-only | 仅从云端拉取数据到本地（定时/手动） |
| bidirectional | 双向同步，先 Pull 合并再 Push |

### 定时同步

- 自定义输入间隔分钟数（最小 5 分钟，默认 30 分钟）
- 开关控制：关闭后仅保留手动触发
- 使用 `chrome.alarms` API 实现定时

### 冲突解决 (conflict.js)

基于时间戳自动决胜，对比每个 cookie 的 `lastModified`:

| 场景 | 处理 |
|------|------|
| 仅远程有 | 写入本地 |
| 仅本地有 | 通过 bidirectional Push 同步到远程 |
| 两端都有，时间戳相同 | 跳过 |
| 两端都有，远程更新 | 远程覆盖本地 |
| 两端都有，本地更新 | 保留本地 |
| 远程已过期 | 删除本地对应 cookie |

**注意:** Chrome `chrome.cookies` API 不提供 cookie 最后修改时间。扩展维护 `lastKnown` 映射（存于 `chrome.storage.local`），记录每个 cookie 的最后已知时间戳。Pull 时用远程 `lastModified` 与本地 `lastKnown` 对比。

---

## 5. UI 设计

### Tab 切换结构

Popup 顶部增加 Tab 切换栏：**域名管理** | **☁️ 云同步**

### 云同步 Tab 布局（自上而下）

1. **同步状态卡片** — 连接状态、后端类型、上次同步信息
2. **同步模式选择** — 仅推送 / 仅拉取 / 双向，点击切换，与操作按钮联动
3. **定时同步配置** — 开关 + 自定义间隔输入（默认 30 分钟，最小 5 分钟）
4. **操作按钮** — 根据模式显示：仅推送→"立即推送"；仅拉取→"立即拉取"；双向→"立即同步"
5. **密钥管理（折叠）** — 显示密钥类型，点击展开配置/导出/导入
6. **后端配置（折叠）** — 显示当前后端，点击展开 Gist/WebDAV 配置
7. **同步日志（折叠）** — 显示最近同步摘要，点击展开详细日志

---

## 6. 错误处理

| 场景 | 处理 |
|------|------|
| 加密/解密失败 | 中止操作，UI 提示"解密失败，请检查密钥" |
| 网络错误 | 重试 1 次（间隔 5 秒），仍失败提示"网络连接失败" |
| Gist API 限流（403/429） | 停止定时同步，提示剩余额度，下个周期自动恢复 |
| WebDAV 认证失败（401） | 停止定时同步，提示"认证失败，请检查用户名密码" |
| 远程数据损坏 | 中止操作，提示"远程数据格式异常"，不写入本地 |
| 密钥未配置 | 隐藏操作按钮，显示"请先配置加密密钥"引导 |
| 后端未配置 | 隐藏操作按钮，显示"请先配置存储后端"引导 |
| 白名单为空 | Push 时提示"没有可同步的域名" |

---

## 7. 安全边界

| 项目 | 策略 |
|------|------|
| 密钥存储 | 仅 `chrome.storage.local`，不用 `chrome.storage.sync` |
| 敏感信息 | UI 中 Token/密码显示为 `****xxxx`，编辑时可见 |
| 数据最小化 | 仅收集白名单域名数据 |
| 加密强度 | AES-256-GCM，随机 IV，256 位密钥 |
| 传输安全 | Gist/WebDAV 均要求 HTTPS |
| 密钥导出 | 明文 Base64，提示安全保存，不在日志中记录 |

---

## 8. 配置存储结构 (chrome.storage.local)

```json
{
  "cloudSync": {
    "enabled": true,
    "mode": "push-only | pull-only | bidirectional",
    "scheduleEnabled": true,
    "scheduleIntervalMinutes": 30,
    "storageType": "gist | webdav",
    "storageConfig": {
      "gist": { "token": "...", "gistId": "..." },
      "webdav": { "url": "...", "username": "...", "password": "..." }
    },
    "keyConfig": {
      "type": "random | pbkdf2",
      "exportedKey": "<Base64>"
    },
    "lastSyncTime": 1713244800000,
    "lastSyncStatus": "success | error",
    "lastSyncError": null,
    "syncLog": [
      {
        "time": 1713244800000,
        "action": "push",
        "status": "success",
        "domains": 3,
        "cookies": 12
      }
    ]
  }
}
```

---

## 决策记录

| 决策 | 选择 | 原因 |
|------|------|------|
| 架构方案 | 模块化 Service Worker | 与现有风格一致，模块边界清晰 |
| 密钥管理 | 混合模式 | 默认随机生成 + 支持密码导入 |
| 同步模式 | 多种可选 | push-only / pull-only / bidirectional |
| 冲突解决 | 时间戳自动决胜 | 用户无需关心冲突，系统自动处理 |
| 域名过滤 | 复用现有白名单 | 逻辑简单，用户无需维护两套列表 |
| 数据范围 | Cookie + localStorage | 用户需求 |
| 存储后端 | Gist + WebDAV 同时实现 | 统一抽象层，同时开发 |
| 同步执行 | 纯扩展端 | 不依赖 daemon，跨设备通用 |
| 加密算法 | AES-256-GCM | 现代标准，Web Crypto 原生支持 |
| UI 集成 | Tab 切换式 | 域名管理和云同步分开展示 |
| 定时间隔 | 自定义输入，默认 30 分钟 | 用户需求，最小 5 分钟 |
