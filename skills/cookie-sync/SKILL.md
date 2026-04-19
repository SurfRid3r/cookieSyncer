---
name: cookie-sync
description: 通过本地 Cookie Sync 工具获取浏览器中指定域名的 cookie。当用户需要读取、获取、抓取浏览器 cookie，或在命令行中访问浏览器 cookie（例如用于 web scraping、API 认证、调试 HTTP 请求、模拟登录态等场景）时，使用此 skill。即使用户没有明确说 "cookie sync"，只要意图涉及从浏览器获取 cookie 或在终端中读取浏览器 session，也应触发此 skill。
---

# Cookie Sync

使用此 skill 时，优先复用 `scripts/cookie_sync_daemon.py`，不要重新实现浏览器通信逻辑。

## 执行流程

1. 确认用户要读取的目标域名或 URL；如果拿到的是 URL，先提取域名。
2. 默认直接运行 `python skills/cookie-sync/scripts/cookie_sync_daemon.py <domain>`；脚本会把标准 Cookie Header 输出到 stdout，可以直接作为管道或命令替换传给 `curl` 等 HTTP 客户端。
3. 只有命令失败时，才进入“故障排查”里的首次配置或环境检查步骤；不要在正常路径里预先展开这些一次性操作。

## 常用命令

```bash
# 正常调用：直接输出 Cookie Header
python skills/cookie-sync/scripts/cookie_sync_daemon.py example.com

# 查看白名单
python skills/cookie-sync/scripts/cookie_sync_daemon.py --list
```

## 故障排查

- `No browser extension connected`：要求用户打开 Chrome 并确认扩展已启用；如未安装，使用仓库中的 `cookie-sync-extension/`，在 `chrome://extensions/` 打开开发者模式后加载。
- `Domain not allowed: xxx`：要求用户将对应域名加入扩展白名单；必要时先用 `--list` 检查当前允许列表。
- `ModuleNotFoundError` 或缺少 `websockets`：执行 `pip install websockets` 后重试。
- 超时或无响应：提示用户确认 Chrome 正在运行，并等待几秒后重试；脚本在本地 daemon 未运行时会临时起一个服务等待扩展回连，首次连接会有延迟。
- 需要确认是否是首次环境问题时，再逐项检查扩展安装、白名单配置、依赖安装，而不是在正常执行前默认要求这些步骤。

## 何时阅读脚本

只有在以下情况再读取 `scripts/cookie_sync_daemon.py`：

- 需要修改输出格式。
- 需要排查 WebSocket 通信问题。
- 需要扩展新的请求动作，例如查询白名单或支持新的入参。
