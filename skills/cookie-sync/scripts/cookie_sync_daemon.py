"""
Cookie Sync — One-shot tool to fetch browser cookies via WebSocket daemon.

Usage:
  pip install websockets
  python cookie_sync_daemon.py example.com           # cookie header format
  python cookie_sync_daemon.py example.com --json     # JSON format
  python cookie_sync_daemon.py --list                 # list whitelisted domains
"""

import asyncio
import json
import sys
import urllib.request
from websockets.asyncio.server import serve
from websockets.sync.client import connect as ws_connect

HOST = "localhost"
PORT = 19825
EXT_WAIT_TIMEOUT = 65  # slightly longer than extension's max reconnect interval (60s)


def build_request(action, domain=None):
    req = {"id": "1", "action": action}
    if domain:
        req["domain"] = domain
    return req


def ping_daemon():
    try:
        with urllib.request.urlopen(f"http://{HOST}:{PORT}/ping", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def fetch_via_running_daemon(domain=None, action="getCookies"):
    with ws_connect(f"ws://{HOST}:{PORT}/client") as ws:
        ws.send(json.dumps(build_request(action, domain)))
        return json.loads(ws.recv())


# --- Temporary server mode (when no daemon is running) ---

ext_connection = None
got_response = None


async def handle_connection(websocket):
    path = getattr(getattr(websocket, "request", None), "path", None) or getattr(websocket, "path", None)

    if path == "/ext":
        await handle_ext(websocket)
    elif path == "/client":
        await handle_client(websocket)
    else:
        await websocket.close()


async def handle_ext(websocket):
    global ext_connection, got_response
    ext_connection = websocket
    print("[cookie-sync] Extension connected", file=sys.stderr)

    try:
        async for message in websocket:
            data = json.loads(message)
            if data.get("type") == "hello":
                continue
            if data.get("id") == "1" and got_response is None:
                got_response = data
    except Exception:
        pass
    finally:
        ext_connection = None


async def handle_client(websocket):
    global got_response
    try:
        async for message in websocket:
            data = json.loads(message)
            req_id = data.get("id")
            if ext_connection is None:
                got_response = {"id": req_id, "ok": False, "error": "No browser extension connected"}
                await websocket.send(json.dumps(got_response))
                continue
            try:
                await ext_connection.send(message)
            except Exception as e:
                got_response = {"id": req_id, "ok": False, "error": str(e)}
                await websocket.send(json.dumps(got_response))
    except Exception:
        pass


async def process_request(connection, request):
    if request.path == "/ping":
        return connection.respond(200, "ok")


async def oneshot_server(domain=None, action="getCookies"):
    global ext_connection, got_response

    print("[cookie-sync] Starting temporary server, waiting for extension...", file=sys.stderr)

    async with serve(handle_connection, HOST, PORT, process_request=process_request):
        for _ in range(EXT_WAIT_TIMEOUT):
            if ext_connection is not None:
                break
            await asyncio.sleep(1)

        if ext_connection is None:
            print(f"[cookie-sync] Timeout: extension did not connect within {EXT_WAIT_TIMEOUT}s", file=sys.stderr)
            return None

        await ext_connection.send(json.dumps(build_request(action, domain)))

        for _ in range(15):
            if got_response is not None:
                return got_response
            await asyncio.sleep(1)

        print("[cookie-sync] Timeout: no response from extension", file=sys.stderr)
        return None


def format_cookies(data):
    if not data.get("ok"):
        return None, data.get("error", "Unknown error")
    return "; ".join(f'{c["name"]}={c["value"]}' for c in data["data"]), None


def main():
    args = sys.argv[1:]
    use_json = "--json" in args
    list_mode = "--list" in args
    domain = [a for a in args if not a.startswith("--")]

    if list_mode:
        result = (fetch_via_running_daemon(action="listAllowed") if ping_daemon()
                  else asyncio.run(oneshot_server(action="listAllowed")))
        if result and result.get("ok"):
            for d in result["data"]:
                print(d)
        else:
            print(f"Error: {result.get('error') if result else 'no response'}", file=sys.stderr)
            sys.exit(1)
        return

    if not domain:
        print("Usage: python cookie_sync_daemon.py <domain> [--json]", file=sys.stderr)
        print("       python cookie_sync_daemon.py --list", file=sys.stderr)
        sys.exit(1)

    domain = domain[0]
    result = (fetch_via_running_daemon(domain) if ping_daemon()
              else asyncio.run(oneshot_server(domain)))

    if result is None:
        sys.exit(1)

    if not result.get("ok"):
        print(f"Error: {result.get('error')}", file=sys.stderr)
        sys.exit(1)

    header, err = format_cookies(result)
    if err:
        print(f"Error: {err}", file=sys.stderr)
        sys.exit(1)

    if use_json:
        print(json.dumps({"domain": domain, "cookies": header}, ensure_ascii=False))
    else:
        print(header)


if __name__ == "__main__":
    main()
