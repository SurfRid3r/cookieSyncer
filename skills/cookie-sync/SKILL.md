---
name: cookie-sync
description: 使用 Cookie Sync 获取浏览器中指定域名或 HTTP(S) URL 的 Cookie，输出包含 Cookie Header 的 JSONL。用于读取浏览器 Cookie、复用登录态或为命令行/API 提供认证数据。
---

# Cookie Sync

使用本 Skill 的 `scripts/cookie_sync_daemon.py`，从当前加载的 `SKILL.md` 路径定位脚本；不要按业务项目 cwd 拼接路径或另行读取浏览器 Cookie 存储。

目标域名需在扩展中开启「本地ON」。有完整 HTTP(S) URL 时用 `--url`，保留协议、主机和路径；不要降级为域名查询。

```bash
set -o pipefail
COOKIE_SYNC_SCRIPT='/absolute/path/to/cookie-sync/scripts/cookie_sync_daemon.py'
URL='https://api.example.com/private/me'
COOKIE=$(python3 "$COOKIE_SYNC_SCRIPT" --url "$URL" | jq -er '.cookie_header') || exit $?
curl -H "Cookie: $COOKIE" "$URL"
```

只有域名时使用 `python3 "$COOKIE_SYNC_SCRIPT" example.com`；与 `--url` 互斥。

成功 stdout 为一条 JSONL：`{"cookie_header":"name=value; name2=value2"}`；Header 已拼好，可提取后传给其他工具的 Cookie 参数。失败时 stdout 为空，错误写入 stderr；按实际报错处理，获取失败时不调用下游或扩大查询范围。其他参数见 `--help`。

每次临时获取一次，按顺序调用。Cookie 获取成功不代表业务认证成功；不要将 Cookie 值输出到诊断、报告或持久化日志。
