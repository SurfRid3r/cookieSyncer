# Cookie Sync

通过 Chrome 扩展 + 本地守护进程，在命令行中获取浏览器指定域名的 Cookie。

## 架构

```
Chrome 扩展  ←──WebSocket (localhost:19825)──→  cookie_sync_daemon.py
   │                                                  │
   ├─ 域名管理（本地获取 + 云端同步）                    ├─ CLI 输出
   ├─ Cookie 捕获与过滤                                └─ Cookie Header
   ├─ 云同步（Gist/WebDAV + AES-256-GCM）
   └─ Popup UI
```

## 快速开始

### 1. 安装 Chrome 扩展

1. 打开 `chrome://extensions/`，开启开发者模式
2. 点击「加载已解压的扩展程序」，选择 `cookie-sync-extension/` 目录
3. 点击扩展图标，添加目标域名（每个域名可独立控制本地获取和云端同步）

### 2. 使用 Claude Skill

在 Claude Code 中，通过 cookie-sync skill 直接获取 Cookie：

```bash
# Cookie Header 格式（适合 curl）
python skills/cookie-sync/scripts/cookie_sync_daemon.py example.com

# 查看白名单
python skills/cookie-sync/scripts/cookie_sync_daemon.py --list
```

### 3. 配合 curl 使用

```bash
curl -H "Cookie: $(python skills/cookie-sync/scripts/cookie_sync_daemon.py example.com)" \
  https://api.example.com/me
```

## 目录结构

```
├── cookie-sync-extension/   # Chrome 扩展（Manifest V3）
│   ├── background/           # Service Worker
│   │   ├── main.js           # 入口
│   │   ├── connection.js     # WebSocket 连接管理
│   │   ├── cookie-ops.js     # Cookie 操作
│   │   ├── domain-utils.js   # 域名工具
│   │   ├── whitelist.js      # 统一域名管理（localAccess + cloudSync）
│   │   └── cloud/            # 云同步模块
│   │       ├── sync-engine.js  # 同步编排引擎
│   │       ├── crypto.js       # AES-256-GCM 加密
│   │       ├── config.js       # 配置管理
│   │       ├── storage-adapter.js  # 存储接口
│   │       ├── gist-adapter.js     # GitHub Gist 后端
│   │       ├── webdav-adapter.js   # WebDAV 后端
│   │       ├── data-collector.js   # Cookie + localStorage 收集器
│   │       └── conflict.js        # 冲突解决
│   ├── popup/                # 弹出窗口 UI
│   │   ├── popup.html        # Tab 切换布局
│   │   ├── popup.js          # Tab 路由 + 域名管理
│   │   ├── cloud-tab.js      # 云同步 Tab
│   │   └── cloud-tab.css     # 云同步样式
│   ├── icons/                # 扩展图标
│   └── manifest.json
│
└── skills/cookie-sync/       # Claude Code Skill
    ├── SKILL.md              # Skill 定义
    ├── agents/
    │   └── openai.yaml       # Agent 配置
    └── scripts/
        └── cookie_sync_daemon.py  # 守护进程
```

## 云同步

通过 GitHub Gist 或 WebDAV 实现加密的跨设备 Cookie 同步。

### 配置步骤

1. 打开扩展弹窗，切换到 **☁️ 云同步** Tab
2. 配置加密密钥（推荐自动生成）
3. 选择存储后端并配置：
   - **GitHub Gist**：填入 GitHub Token（见下方说明）
   - **WebDAV**：填入服务器地址、用户名和密码
4. 点击 **保存配置** 激活

### 多设备同步

在设备 A 首次推送后，状态卡片会显示 **Gist ID**。在设备 B 上填入相同的 Token 和该 Gist ID，即可同步同一份数据。

### 域名管理

每个域名有两个独立的控制维度：
- **本地获取**（本地ON/OFF）：是否允许本地 daemon 获取该域名的 Cookie
- **云端同步**（云端ON/OFF）：该域名的 Cookie 是否参与云端同步

从云端拉取时，新发现的域名会以"待确认"状态出现，需用户确认后才参与同步。

### GitHub Token 权限

在 https://github.com/settings/tokens 创建 Personal Access Token (classic) 时，只需勾选一个权限：

| 权限 | 是否必须 | 用途 |
|------|----------|------|
| `gist` | **是** | 创建、读取和更新 Gist |

不需要其他任何权限。Token 只需要 Gist 访问权限——不需要你的仓库、Issues 或其他 GitHub 资源的访问权限。

## 依赖

- Chrome 浏览器
- Python 3 + `websockets`（`pip install websockets`）

## 安全

- 仅读取/写入已启用对应权限的域名 Cookie
- WebSocket 仅监听 localhost
- 浏览器权限安装时一次性授予（`<all_urls>`），实际访问由每个域名的独立设置控制
- 云同步使用 AES-256-GCM 加密，每次上传随机 IV
- 加密密钥仅存储在本地（chrome.storage.local，不会通过 Chrome Sync 同步）
- GitHub Token 仅需 `gist` 权限，无法访问你的仓库
