# Cookie Sync

通过 Chrome 扩展在命令行读取浏览器 Cookie。每次命令临时监听，获取一次后退出，不保存 Cookie，也不留下后台服务。

## 快速开始

需要 Chrome 和 Python 3.11 或更高版本。安装 Python 依赖：

```bash
python3 -m pip install websockets==17.2
```

1. 打开 `chrome://extensions/`，开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择 `cookie-sync-extension/`。
3. 打开扩展弹窗，添加目标域名并开启「本地ON」。

以下命令从仓库根目录运行：

```bash
# 按完整 URL 匹配 Cookie，包括协议和路径
python3 skills/cookie-sync/scripts/cookie_sync_daemon.py --url 'https://api.example.com/private/me'

# 按域名查询
python3 skills/cookie-sync/scripts/cookie_sync_daemon.py example.com
```

输出为一条 JSONL：`{"cookie_header":"sid=value; token=value"}`。Header 已拼好，用 jq 提取后即可交给 curl：

```bash
set -o pipefail
COOKIE=$(python3 skills/cookie-sync/scripts/cookie_sync_daemon.py --url 'https://api.example.com/me' | jq -er '.cookie_header') || exit $?
curl -H "Cookie: $COOKIE" 'https://api.example.com/me'
unset COOKIE
```

先检查退出状态再调用下游；获取到 Cookie 不代表目标服务已接受认证。

用于 AI Agent 时，将 `skills/cookie-sync/` 复制到其 Skill 目录。脚本与扩展应一起更新。

## 域名开关

每个域名有两个开关：

- **本地ON/OFF**：是否允许本地获取 Cookie。
- **云端ON/OFF**：是否参与云端同步。

最具体的域名配置优先；未配置的子域继承父域设置。有完整 URL 时使用 `--url`，会返回匹配该 URL 的 Cookie，包括匹配的父域 Cookie。域名查询则按 Cookie 所属域的本地设置过滤。

## 常见问题

错误以 JSONL 输出到 stderr，stdout 留空。用 `--help` 查看纯文本选项，或加 `-v` 在 stderr 查看 JSONL 连接进度。

| 错误 | 处理方式 |
| --- | --- |
| `DOMAIN_NOT_ALLOWED` | 在扩展中开启目标域名「本地ON」。 |
| `COOKIE_EMPTY` | 核对请求 URL 或域名，没有匹配的 Cookie。 |
| `EXTENSION_UNAVAILABLE` | 打开 Chrome 并启用扩展；冷启动连接可能需要等待。 |
| `LOCAL_UNAVAILABLE` | 按顺序运行获取命令；本地 38247 端口可能已被占用。 |
| `PROTOCOL_MISMATCH` | 同时更新脚本与扩展。 |

默认总超时 85 秒，可用 `--timeout <秒数>` 调整（大于 0，最多 300 秒）。诊断不会输出 Cookie 值，使用时也应避免将其写入日志。

## 可选：云同步

通过 GitHub Gist 或 WebDAV 跨设备同步加密 Cookie：

1. 打开扩展的「☁️ 云同步」页签，配置加密密钥。
2. 选择存储后端：
   - **GitHub Gist**：填写具有 `gist` 权限的 [个人访问令牌](https://github.com/settings/tokens)。首次使用可留空 Gist ID，推送时自动创建。
   - **WebDAV**：填写服务器地址、凭据和文件路径。
3. 保存配置，开启需要同步的域名，选择推送、拉取或双向同步，也可开启定时同步。

在另一台设备上，**导入同一加密密钥**。Gist 使用相同 Token 和首次推送后显示的 Gist ID；WebDAV 使用相同服务器和文件路径。新发现的域名会显示为待确认，供用户检查。

云端数据使用 AES-256-GCM 加密。密钥保存在扩展本地存储中，可从密钥管理中导出，供其他设备导入；请妥善保存。
