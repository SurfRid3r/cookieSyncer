"""Fetch one Cookie Header as JSONL, then close the temporary local listener."""

import argparse
import asyncio
import ipaddress
import json
import math
import os
import re
import sys
import urllib.parse

HOST = "127.0.0.1"
PORT = 38247
SERVICE = "cookie-sync"
PROTOCOL = 1
SUBPROTOCOL = "cookie-sync-v1"
CAPABILITIES = ["domain", "url"]
DEFAULT_TIMEOUT = 85.0
MAX_TIMEOUT = 300.0
EXT_ORIGIN = re.compile(r"chrome-extension://[a-p]{32}")

ERRORS = {
    "USAGE_ERROR": ("Invalid arguments; run --help for usage.", False, 2),
    "DEPENDENCY_MISSING": ("Install websockets 17.2 for this python3 interpreter.", False, 1),
    "SERVICE_MISMATCH": ("The connected peer is not Cookie Sync.", False, 1),
    "PROTOCOL_MISMATCH": ("Update the script and extension together; protocol or capabilities differ.", False, 1),
    "PROTOCOL_ERROR": ("The local peer sent an invalid message.", False, 1),
    "LOCAL_UNAVAILABLE": ("Cannot open the local listener; another request or service may be using the port.", True, 1),
    "EXTENSION_UNAVAILABLE": ("Open Chrome and enable the matching Cookie Sync extension.", False, 1),
    "EXTENSION_DISCONNECTED": ("The browser extension disconnected during the request.", True, 1),
    "TIMEOUT": ("The request deadline expired.", True, 1),
    "DOMAIN_NOT_ALLOWED": ("Enable local access for the target in the extension.", False, 1),
    "COOKIE_EMPTY": ("No cookies matched the authorized scope.", False, 1),
    "COOKIE_READ_FAILED": ("Chrome could not read cookies for the authorized scope.", False, 1),
    "INTERNAL_ERROR": ("Cookie Sync could not complete the request.", False, 1),
}


class CookieSyncError(Exception):
    def __init__(self, code):
        self.code = code if isinstance(code, str) and code in ERRORS else "PROTOCOL_ERROR"
        self.message, self.retryable, self.exit_code = ERRORS[self.code]
        super().__init__(self.message)

    def record(self):
        return {"error_code": self.code, "message": self.message, "retryable": self.retryable}


class Parser(argparse.ArgumentParser):
    def error(self, message):
        # argparse's original message may include a URL containing secrets.
        raise CookieSyncError("USAGE_ERROR")


def positive_seconds(value):
    try:
        seconds = float(value)
        if not math.isfinite(seconds) or not 0 < seconds <= MAX_TIMEOUT:
            raise ValueError
        return seconds
    except (TypeError, ValueError):
        raise CookieSyncError("USAGE_ERROR") from None


def normalize_domain(value):
    try:
        value = value.lstrip(".")
        if not value or any(c.isspace() or ord(c) < 32 for c in value):
            raise ValueError
        try:
            address = ipaddress.ip_address(value.strip("[]"))
            return f"[{address}]" if address.version == 6 else str(address)
        except ValueError:
            pass
        parsed = urllib.parse.urlsplit("http://" + value)
        if (not parsed.hostname or parsed.username is not None or parsed.password is not None
                or parsed.port is not None or parsed.path or parsed.query or parsed.fragment
                or any(c in value for c in "%*\\")):
            raise ValueError
        # Chrome's native URL parser owns IDN canonicalization. Python's built-in
        # IDNA codec uses different rules and could change the requested host.
        return parsed.hostname.rstrip(".")
    except (ValueError, UnicodeError):
        raise CookieSyncError("USAGE_ERROR") from None


def normalize_url(value):
    try:
        if any(c.isspace() or ord(c) < 32 for c in value) or "\\" in value:
            raise ValueError
        parsed = urllib.parse.urlsplit(value)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username is not None or parsed.password is not None):
            raise ValueError
        host = normalize_domain(parsed.hostname)
        if ":" in host and not host.startswith("["):
            host = "[" + host + "]"
        if parsed.port is not None:
            host += ":" + str(parsed.port)
        return urllib.parse.urlunsplit((parsed.scheme, host, parsed.path or "/", parsed.query, ""))
    except (ValueError, UnicodeError):
        raise CookieSyncError("USAGE_ERROR") from None


def parse_args(argv=None):
    parser = Parser(description=__doc__, allow_abbrev=False)
    parser.add_argument("domain", nargs="?", help="domain-wide Cookie query")
    parser.add_argument("--url", help="HTTP(S) URL; Chrome matches protocol, host and path")
    parser.add_argument("--timeout", type=positive_seconds, default=DEFAULT_TIMEOUT,
                        help="total deadline in seconds (default: 85; maximum: 300)")
    parser.add_argument("-v", "--verbose", action="store_true", help="write JSONL connection progress to stderr")
    args = parser.parse_args(argv)
    if (args.domain is None) == (args.url is None):
        parser.error("choose one mode")
    try:
        args.port = int(os.environ.get("COOKIE_SYNC_PORT", PORT))
        if not 1 <= args.port <= 65535:
            raise ValueError
    except ValueError:
        parser.error("invalid local port")
    if args.domain is not None:
        args.domain = normalize_domain(args.domain)
    if args.url is not None:
        args.url = normalize_url(args.url)
    return args


def identity(role=None):
    result = {"service": SERVICE, "protocol": PROTOCOL, "capabilities": CAPABILITIES}
    if role:
        result.update(type="hello", role=role)
    return result


def check_identity(data, role=None):
    if not isinstance(data, dict) or data.get("service") != SERVICE:
        raise CookieSyncError("SERVICE_MISMATCH")
    if (type(data.get("protocol")) is not int or data["protocol"] != PROTOCOL
            or not isinstance(data.get("capabilities"), list)
            or not set(CAPABILITIES).issubset(str(c) for c in data["capabilities"])
            or (role is not None and (data.get("type") != "hello" or data.get("role") != role))):
        raise CookieSyncError("PROTOCOL_MISMATCH")


def decode_message(raw):
    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError
        return data
    except (ValueError, TypeError, UnicodeError):
        raise CookieSyncError("PROTOCOL_ERROR") from None


async def fetch(args):
    # Import only for retrieval so --help works without the runtime dependency.
    from websockets.asyncio.server import serve
    from websockets.exceptions import ConnectionClosed

    result = asyncio.get_running_loop().create_future()
    claimed = False
    request = {"id": "1", "protocol": PROTOCOL, "action": "getCookies"}
    if args.domain is not None:
        request["domain"] = args.domain
    if args.url is not None:
        request["url"] = args.url

    def process_request(connection, incoming):
        try:
            origin = incoming.headers.get("Origin")
            if incoming.headers.get("Host") not in (f"localhost:{args.port}", f"{HOST}:{args.port}"):
                return connection.respond(403, "Local Host required\n")
            extension_origin = origin is not None and EXT_ORIGIN.fullmatch(origin) is not None
            if origin is not None and not extension_origin:
                return connection.respond(403, "Origin rejected\n")
            if incoming.path == "/ping":
                response = connection.respond(200, json.dumps(identity()) + "\n")
                response.headers["Content-Type"] = "application/json"
                return response
            if incoming.path != "/ext":
                return connection.respond(404, "Unknown entry\n")
            if not extension_origin:
                return connection.respond(403, "Extension Origin required\n")
        except (ValueError, KeyError):
            return connection.respond(400, "Invalid headers\n")

    async def handle_extension(ws):
        nonlocal claimed
        if claimed:
            await ws.close(1013, "Request already active")
            return
        claimed = True
        try:
            check_identity(decode_message(await ws.recv()), "extension")
            await ws.send(json.dumps(identity("service")))
            if args.verbose:
                print(json.dumps({"event": "extension_connected"}), file=sys.stderr)
            await ws.send(json.dumps(request))
            reply = decode_message(await ws.recv())
            if type(reply.get("protocol")) is not int or reply["protocol"] != PROTOCOL:
                raise CookieSyncError("PROTOCOL_MISMATCH")
            if reply.get("id") != request["id"] or type(reply.get("ok")) is not bool:
                raise CookieSyncError("PROTOCOL_ERROR")
            if not reply["ok"]:
                raise CookieSyncError(reply.get("error_code"))
            if not result.done():
                result.set_result(reply)
        except (CookieSyncError, ConnectionClosed) as exc:
            error = exc if isinstance(exc, CookieSyncError) else CookieSyncError("EXTENSION_DISCONNECTED")
            if not result.done():
                result.set_exception(error)

    try:
        async with asyncio.timeout(args.timeout):
            async with serve(handle_extension, HOST, args.port, process_request=process_request,
                             origins=[EXT_ORIGIN], subprotocols=[SUBPROTOCOL],
                             open_timeout=2, close_timeout=0.2, max_size=1024 * 1024):
                if args.verbose:
                    print(json.dumps({"event": "waiting_extension"}), file=sys.stderr)
                return await result
    except TimeoutError:
        raise CookieSyncError("TIMEOUT" if claimed else "EXTENSION_UNAVAILABLE") from None


def format_jsonl(result):
    data = result.get("data")
    if not isinstance(data, list):
        raise CookieSyncError("PROTOCOL_ERROR")
    if not data:
        raise CookieSyncError("COOKIE_EMPTY")
    pairs = []
    for cookie in data:
        if not isinstance(cookie, dict):
            raise CookieSyncError("PROTOCOL_ERROR")
        name, value = cookie.get("name"), cookie.get("value")
        if (not isinstance(name, str) or not isinstance(value, str)
                or any(ord(c) < 32 or ord(c) == 127 for c in name + value)):
            raise CookieSyncError("PROTOCOL_ERROR")
        pairs.append(f"{name}={value}")
    return json.dumps({"cookie_header": "; ".join(pairs)}, ensure_ascii=False)


def main(argv=None):
    try:
        args = parse_args(argv)
        print(format_jsonl(asyncio.run(fetch(args))))
        return 0
    except CookieSyncError as exc:
        print(json.dumps(exc.record()), file=sys.stderr)
        return exc.exit_code
    except ImportError:
        print(json.dumps(CookieSyncError("DEPENDENCY_MISSING").record()), file=sys.stderr)
        return 1
    except OSError:
        print(json.dumps(CookieSyncError("LOCAL_UNAVAILABLE").record()), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print(json.dumps(CookieSyncError("LOCAL_UNAVAILABLE").record()), file=sys.stderr)
        return 130
    except Exception:
        print(json.dumps(CookieSyncError("INTERNAL_ERROR").record()), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
