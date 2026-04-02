---
name: cookie-sync
description: 通过本地 Cookie Sync 工具获取浏览器中指定域名的 cookie。当用户需要读取、获取、抓取浏览器 cookie，或在命令行中访问浏览器 cookie（例如用于 web scraping、API 认证、调试 HTTP 请求、模拟登录态等场景）时，使用此 skill。即使用户没有明确说 "cookie sync"，只要意图涉及从浏览器获取 cookie 或在终端中读取浏览器 session，也应触发此 skill。
---

# Cookie Sync

使用此 skill 时，优先复用 `scripts/cookie_sync_daemon.py`，不要重新实现浏览器通信逻辑。

## 执行流程

1. 确认用户要读取的目标域名或 URL。
2. 检查 Chrome 扩展是否已安装并启用；扩展目录位于仓库中的 `cookie-sync-extension/`。
3. 必要时提醒用户在 `chrome://extensions/` 打开开发者模式并加载该扩展。
4. 提醒用户将目标域名加入扩展白名单；未加入白名单的域名无法读取。
5. 如果环境缺少依赖，安装 `websockets`。
6. 运行 `python skills/cookie-sync/scripts/cookie_sync_daemon.py <domain>` 获取 Cookie Header，或使用 `--json` 输出 JSON。
7. 将结果直接用于后续命令、脚本或调试流程，不要手动改写 cookie 内容，除非用户明确要求。

## 常用命令

```bash
# 以 Cookie Header 形式输出，适合直接传给 curl 或其他 HTTP 客户端
python skills/cookie-sync/scripts/cookie_sync_daemon.py example.com

# 以 JSON 形式输出
python skills/cookie-sync/scripts/cookie_sync_daemon.py example.com --json

# 查看当前白名单域名
python skills/cookie-sync/scripts/cookie_sync_daemon.py --list
```

## 输出使用方式

- 需要构造请求头时，直接使用标准 Cookie Header 输出。
- 需要机器可读结果时，使用 `--json`。
- 需要只提取 cookie 字符串时，可配合 `jq -r '.cookies'`。

示例：

```bash
curl -H "Cookie: $(python skills/cookie-sync/scripts/cookie_sync_daemon.py example.com)" https://api.example.com/me
```

## 故障排查

- `No browser extension connected`：要求用户打开 Chrome 并确认扩展已启用。
- `Domain not allowed: xxx`：要求用户将对应域名加入扩展白名单。
- 超时或无响应：提示用户确认 Chrome 正在运行，并等待几秒后重试；扩展通过 WebSocket 回连，本身存在短暂延迟。

## 何时阅读脚本

只有在以下情况再读取 `scripts/cookie_sync_daemon.py`：

- 需要修改输出格式。
- 需要排查 WebSocket 通信问题。
- 需要扩展新的请求动作，例如查询白名单或支持新的入参。
