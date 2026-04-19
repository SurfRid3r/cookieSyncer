# 域名与权限管理重设计

> 日期：2026-04-19
> 状态：待审核

## 背景

当前浏览器插件存在两个核心问题：

1. **权限获取繁琐**：使用 `optional_host_permissions`，每添加一个域名都需要用户通过 Chrome 权限弹窗授权，体验不流畅。
2. **云端同步无域名控制**：云端同步时无法按域名粒度控制推送/拉取范围，多端场景下用户需要只同步特定域名。

## 设计目标

- 浏览器权限一次授予，后续无需重复操作
- 云端维护完整域名池作为唯一真源
- 每端可独立配置本地获取和云端同步开关
- 本地新增域名自动同步到云端
- 从云端发现新域名时提示用户确认

## 方案选择

采用**云端域名池 + 本地独立配置**方案：

- 云端存储全量 cookie 数据和域名主列表
- 本地每个域名有两个并列控制维度（本地获取 + 云端同步）
- 本地配置不上传云端，纯各端自行保存
- 无需设备 ID 管理，实现简单

## 设计详情

### 1. 权限模型

**变更：`optional_host_permissions` → `<all_urls>`**

```json
// manifest.json
{
  "host_permissions": ["<all_urls>"],
  "permissions": ["cookies", "storage", "alarms", "scripting"]
}
```

移除 `optional_host_permissions`，安装时一次性授予所有网站 cookie 读取权限。

**两层管控模型：**

| 层级 | 机制 | 说明 |
|------|------|------|
| 浏览器层 | `<all_urls>` | 安装即授权，无需用户干预 |
| 业务层 | 域名管理 | popup 中管理，控制哪些域名参与哪项功能 |

**代码影响：**
- 移除 `whitelist.js` 中所有 `chrome.permissions.request/remove` 调用
- `cookie-ops.js` 中的权限检查改为纯白名单校验
- `cloud-tab.js` 中拉取时的权限请求逻辑移除

### 2. 域名数据模型

#### 云端数据结构

```
gist/webdav 存储:
{
  "encrypted_data": "...",           // AES-256-GCM 加密的 cookie 数据（全量域名）
  "domain_list": [                   // 明文域名主列表（不加密，用于快速发现新域名）
    "example.com",
    "github.com"
  ],
  "last_updated": 1745000000
}
```

#### 本地数据结构

```
chrome.storage.local:
{
  "cloudDomains": {                                // 统一域名管理（替代原 whitelist）
    "domains": {
      "example.com": {
        "localAccess": true,                       // 是否允许本地 daemon 获取
        "cloudSync": "enabled"                     // 云端同步状态
      },
      "test.com": {
        "localAccess": true,
        "cloudSync": "disabled"
      },
      "new-site.com": {
        "localAccess": false,
        "cloudSync": "pending"
      }
    }
  }
}
```

每个域名有两个并列控制维度：

| 维度 | 取值 | 同步到云端 | 说明 |
|------|------|-----------|------|
| `localAccess` | `true/false` | 否 | 是否允许 WebSocket daemon 获取该域名 cookie |
| `cloudSync` | `enabled/pending/disabled` | 否 | 云端同步状态 |

两个维度正交，可任意组合：
- 本地获取开 + 云端 enabled → 两个功能都参与
- 本地获取开 + 云端 disabled → 只给本地 daemon 用
- 本地获取关 + 云端 enabled → 只参与云端同步

#### 云端同步状态

| 状态 | 说明 | 推送 | 拉取 |
|------|------|------|------|
| `enabled` | 正常参与云端同步 | 参与 | 参与 |
| `pending` | 云端新发现，待用户确认 | 跳过 | 跳过 |
| `disabled` | 用户手动禁用 | 跳过 | 跳过 |

#### 状态流转

```
云端新发现 → pending → 用户确认启用 → enabled
enabled → 用户禁用 → disabled → 用户启用 → enabled
本地手动添加 → enabled（同时推送到云端 domain_list）
```

### 3. 同步引擎改造

#### 推送（Push）流程

```
1. 收集本地 cookie
2. 过滤：只保留 cloudSync=enabled 的域名
3. 加密并上传到云端
4. 将本地 enabled 域名合并到云端 domain_list
5. 更新 last_updated
```

#### 拉取（Pull）流程

```
1. 从云端获取数据
2. 读取 domain_list（无需解密）
3. 对比云端 domain_list 与本地 cloudDomains：
   a. 云端有、本地没有 → 添加为 pending
   b. 本地已有、云端没有 → 保留本地状态
4. 解密 cookie 数据
5. 只写入本地 cloudSync=enabled 的域名 cookie
6. 如有新 pending 域名 → 通知 popup
```

#### 双向同步（Bidirectional）

```
1. 先拉取（获取最新状态 + 发现新域名）
2. 冲突检测与解决（保持现有 timestamp 策略）
3. 再推送（上传本地变更）
```

#### 本地 daemon 同步

```
1. WebSocket 连接收到 cookie 请求
2. 从 cookie-ops.js 获取 cookie
3. 过滤：只返回 localAccess=true 的域名 cookie
```

#### 代码变更点

| 文件 | 变更 |
|------|------|
| `manifest.json` | `optional_host_permissions` → `<all_urls>` |
| `whitelist.js` | 移除 Chrome Permissions API 调用，改为纯数据校验 |
| `cookie-ops.js` | 根据 localAccess/cloudSync 分别过滤 |
| `data-collector.js` | 收集 cookie 时传入 cloudSync=enabled 过滤条件 |
| `sync-engine.js` | push/pull 前后增加域名状态管理 + domain_list 同步 |
| `storage-adapter.js` | 存储时携带 domain_list |
| `cloud-tab.js` | 移除权限请求逻辑，增加 pending 域名展示 |
| `popup.js` | 统一域名管理 UI，合并原 whitelist 管理 |
| `connection.js` | daemon 请求过滤改为 localAccess 校验 |

### 4. Popup UI

#### 整体布局

```
[本地同步]  [云端同步]
```

#### 本地同步 Tab

```
连接状态: 已连接 / 未连接

域名管理:
┌──────────────────────────────────┐
│ example.com    [本地获取 ✓]      │
│ test.com       [本地获取 ✓]      │
│ api.service.com [本地获取 ✗]     │
└──────────────────────────────────┘
[添加域名]
```

- 本地获取开关一键切换
- 添加域名时默认 localAccess=true, cloudSync=enabled

#### 云端同步 Tab

```
同步模式：仅推送 / 仅拉取 / 双向
存储后端：Gist / WebDAV
[手动同步]

域名管理:
┌─ 已启用 ──────────────────────────┐
│ example.com       [云端同步 ✓]    │
│ github.com        [云端同步 ✓]    │
├─ 待确认 (2) ──────────────────────┤
│ new-site.com      [启用][×]       │
│ api.other.com     [启用][×]       │
├─ 已禁用 ──────────────────────────┤
│ old-site.com      [云端同步 ✗]    │
└───────────────────────────────────┘
[添加域名]
```

#### 交互说明

- **待确认域名（pending）**：拉取同步后出现，显示数量角标
  - `[启用]`：变为 enabled，后续参与同步
  - `[×]`：忽略，保持 pending，下次拉取不再重复提示
- **添加域名**：输入后添加为 enabled，下次推送时同步到云端
- **禁用/启用**：一键切换，无需确认（操作可逆）
- **分组折叠**：三组默认折叠「已禁用」

### 5. 数据迁移

从旧版 `whitelist` 迁移到 `cloudDomains`：

```
旧数据: whitelist: ["example.com", "test.com"]
迁移后:
cloudDomains: {
  domains: {
    "example.com": { localAccess: true, cloudSync: "enabled" },
    "test.com": { localAccess: true, cloudSync: "enabled" }
  }
}
```

迁移在插件启动时自动执行，迁移完成后删除旧 `whitelist` 键。

## 不在范围内

- 设备 ID 管理
- 禁用/本地获取状态跨端同步
- 域名分组功能
- 按域名单独配置同步方向
