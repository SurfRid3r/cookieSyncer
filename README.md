# Cookie Sync

通过 Chrome 扩展 + 本地守护进程，在命令行中获取浏览器指定域名的 Cookie。

## 架构

```
Chrome 扩展  ←──WebSocket (localhost:19825)──→  cookie_sync_daemon.py
   │                                                  │
   ├─ 管理域名白名单                                   ├─ CLI 输出
   ├─ 监听/捕获 Cookie                                ├─ Cookie Header
   └─ Popup UI                                        └─ JSON 格式
```

## 快速开始

### 1. 安装 Chrome 扩展

1. 打开 `chrome://extensions/`，开启开发者模式
2. 点击「加载已解压的扩展程序」，选择 `cookie-sync-extension/` 目录
3. 点击扩展图标，将目标域名加入白名单

### 2. 使用 Claude Skill

在 Claude Code 中，通过 cookie-sync skill 直接获取 Cookie：

```bash
# Cookie Header 格式（适合 curl）
python skills/cookie-sync/scripts/cookie_sync_daemon.py example.com

# JSON 格式
python skills/cookie-sync/scripts/cookie_sync_daemon.py example.com --json

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
│   │   └── whitelist.js      # 白名单管理
│   ├── popup/                # 弹出窗口 UI
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

## 依赖

- Chrome 浏览器
- Python 3 + `websockets`（`pip install websockets`）

## 安全

- 仅读取白名单内域名的 Cookie
- WebSocket 仅监听 localhost
- 扩展需要用户手动授予主机权限
