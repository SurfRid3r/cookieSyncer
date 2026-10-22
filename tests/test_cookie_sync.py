"""Offline contracts and real loopback tests. Never use the browser's default port."""
import asyncio
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import sys
import unittest
from unittest.mock import patch
import signal
import tempfile
import urllib.request

from websockets.asyncio.client import connect
from websockets.exceptions import InvalidHandshake

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'skills/cookie-sync/scripts/cookie_sync_daemon.py'
spec = importlib.util.spec_from_file_location('cookie_sync_daemon', SCRIPT)
cookie = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cookie)
ORIGIN = 'chrome-extension://' + 'a' * 32


class ContractTests(unittest.TestCase):
    def invoke(self, args, result=None, error=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        async def fetch(_args):
            if error:
                raise cookie.CookieSyncError(error)
            return result
        with patch.object(cookie, 'fetch', fetch), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            status = cookie.main(args)
        return status, stdout.getvalue(), stderr.getvalue()

    def test_argument_errors_are_one_safe_json(self):
        for args in [[], ['--typo', 'example.invalid'], ['--list'], ['--lis'], ['a.invalid', 'b.invalid'],
                     ['--list', 'example.invalid'], ['--url', 'https://a.invalid/', 'a.invalid'],
                     ['--list', '--url', 'https://a.invalid/'], ['--timeout', 'nan', 'example.invalid'],
                     ['--timeout', '0', 'example.invalid'], ['--timeout', '301', 'example.invalid'],
                     ['--url', 'https://user:synthetic-secret@example.invalid/']]:
            with self.subTest(args=args):
                status, out, err = self.invoke(args)
                self.assertEqual(status, 2)
                self.assertEqual(out, '')
                self.assertEqual(len(err.splitlines()), 1)
                self.assertEqual(json.loads(err)['error_code'], 'USAGE_ERROR')
                self.assertNotIn('synthetic-secret', err)

    def test_url_and_domain_normalization(self):
        args = cookie.parse_args(['--url', 'https://API.Example.invalid:8443/private?q=1#fragment'])
        self.assertEqual(args.url, 'https://api.example.invalid:8443/private?q=1')
        self.assertEqual(cookie.parse_args(['.EXAMPLE.invalid']).domain, 'example.invalid')
        self.assertEqual(cookie.normalize_url('https://faß.example.invalid/private'),
                         'https://faß.example.invalid/private')
        self.assertEqual(cookie.normalize_url('http://[::1]:8080/private'), 'http://[::1]:8080/private')
        for value in ['file:///tmp/a', 'https://example.invalid:bad/', 'https://example.invalid/\n']:
            with self.assertRaises(cookie.CookieSyncError):
                cookie.normalize_url(value)

    def test_success_and_empty_contracts(self):
        records = [{'name': 'session', 'value': 'synthetic', 'domain': '.example.invalid',
                    'path': '/private', 'secure': True, 'httpOnly': False, 'sameSite': 'lax',
                    'expirationDate': 2000000000.5},
                   {'name': 'x', 'value': 'quoted"\\值'}]
        status, out, err = self.invoke(['example.invalid'], {'data': records})
        self.assertEqual((status, err), (0, ''))
        self.assertEqual(len(out.splitlines()), 1)
        self.assertEqual(json.loads(out), {'cookie_header': 'session=synthetic; x=quoted"\\值'})
        status, out, err = self.invoke(['example.invalid'], {'data': []})
        self.assertEqual((status, out), (1, ''))
        self.assertEqual(json.loads(err)['error_code'], 'COOKIE_EMPTY')
        self.assertNotIn('logged', err)

    def test_header_preserves_duplicate_names_order_and_equals_in_values(self):
        records = [{'name': 'session', 'value': 'private=value', 'path': '/private'},
                   {'name': 'session', 'value': 'root', 'path': '/'},
                   {'name': 'empty', 'value': ''}]
        status, out, err = self.invoke(['--url', 'https://example.invalid/private'], {'data': records})
        self.assertEqual((status, err), (0, ''))
        self.assertEqual(json.loads(out), {'cookie_header': 'session=private=value; session=root; empty='})

    def test_invalid_later_record_never_leaves_partial_stdout(self):
        valid = {'name': 'session', 'value': 'synthetic'}
        for invalid in [{'name': 'x', 'value': 'synthetic\nsecret'},
                        {'name': 'x\r', 'value': 'synthetic'},
                        {'name': 'x', 'value': None}, {'value': 'synthetic'}, None]:
            status, out, err = self.invoke(['example.invalid'], {'data': [valid, invalid]})
            self.assertEqual((status, out), (1, ''))
            self.assertEqual(json.loads(err)['error_code'], 'PROTOCOL_ERROR')
            self.assertNotIn('synthetic', err)

    def test_errors_do_not_echo_peer_payload(self):
        status, out, err = self.invoke(['example.invalid'], error='DOMAIN_NOT_ALLOWED')
        self.assertEqual((status, out), (1, ''))
        self.assertEqual(json.loads(err)['retryable'], False)
        for data in [None, ['invalid'], [{'name': 'x', 'value': 'synthetic\nsecret'}]]:
            status, out, err = self.invoke(['example.invalid'], {'data': data})
            self.assertEqual((status, out), (1, ''))
            self.assertEqual(json.loads(err)['error_code'], 'PROTOCOL_ERROR')
            self.assertNotIn('secret', err)

    def test_identity_and_capabilities(self):
        for field, value, code in [('service', 'foreign', 'SERVICE_MISMATCH'),
                                   ('protocol', 999, 'PROTOCOL_MISMATCH'),
                                   ('capabilities', ['domain'], 'PROTOCOL_MISMATCH')]:
            hello = cookie.identity()
            hello[field] = value
            with self.assertRaises(cookie.CookieSyncError) as caught:
                cookie.check_identity(hello)
            self.assertEqual(caught.exception.code, code)


def unused_port():
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        return reservation.getsockname()[1]


def ping(port):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(f'http://127.0.0.1:{port}/ping', timeout=.2) as response:
        return json.load(response)


async def wait_started(port, task=None, process=None):
    for _ in range(200):
        if task is not None and task.done():
            await task
        if process is not None and process.returncode is not None:
            raise AssertionError('CLI exited before listening')
        try:
            return await asyncio.to_thread(ping, port)
        except OSError:
            await asyncio.sleep(.01)
    raise AssertionError('temporary listener did not start')


def assert_port_free(test, port):
    with socket.socket() as client:
        client.settimeout(.2)
        test.assertNotEqual(client.connect_ex(('127.0.0.1', port)), 0)
    with socket.socket() as listener:
        # Match asyncio's listener settings so TCP TIME_WAIT doesn't look like
        # a leaked listener after an otherwise completed request.
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(('127.0.0.1', port))
        test.assertEqual(listener.getsockname()[1], port)


class OneShotTests(unittest.IsolatedAsyncioTestCase):
    async def start_fetch(self, *args, timeout=2):
        parsed = cookie.parse_args(list(args) or ['example.invalid'])
        parsed.port = unused_port()
        parsed.timeout = timeout
        task = asyncio.create_task(cookie.fetch(parsed))
        async def cleanup():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self.addAsyncCleanup(cleanup)
        hello = await wait_started(parsed.port, task=task)
        cookie.check_identity(hello)
        return parsed.port, task

    async def extension(self, port, hello=None):
        ws = await connect(f'ws://127.0.0.1:{port}/ext', proxy=None,
                           origin=ORIGIN, subprotocols=[cookie.SUBPROTOCOL], close_timeout=.1)
        self.addAsyncCleanup(ws.close)
        await ws.send(json.dumps(hello or cookie.identity('extension')))
        cookie.check_identity(json.loads(await ws.recv()), 'service')
        return ws, json.loads(await ws.recv())

    async def test_single_request_closes_listener_and_extension(self):
        port, task = await self.start_fetch()
        ws, request = await self.extension(port)
        self.assertEqual(request['domain'], 'example.invalid')
        reply = {**request, 'ok': True, 'data': [{'name': 'session', 'value': 'synthetic'}]}
        await ws.send(json.dumps(reply))
        self.assertEqual(await task, reply)
        await asyncio.wait_for(ws.wait_closed(), 1)
        assert_port_free(self, port)

    async def test_url_is_forwarded_without_domain_fallback(self):
        url = 'https://api.example.invalid/private?q=1'
        port, task = await self.start_fetch('--url', url)
        ws, request = await self.extension(port)
        self.assertNotIn('domain', request)
        self.assertEqual(request['url'], url)
        self.assertEqual(request['action'], 'getCookies')
        await ws.send(json.dumps({**request, 'ok': True, 'data': []}))
        self.assertTrue((await task)['ok'])
        assert_port_free(self, port)

    async def test_web_origins_client_entry_and_missing_subprotocol_are_rejected(self):
        port, task = await self.start_fetch()
        for path, origin, protocols in [('/ext', 'https://web.invalid', [cookie.SUBPROTOCOL]),
                                        ('/ext', None, [cookie.SUBPROTOCOL]),
                                        ('/ext', 'null', [cookie.SUBPROTOCOL]),
                                        ('/client', None, [cookie.SUBPROTOCOL]),
                                        ('/ext', ORIGIN, None)]:
            with self.subTest(path=path, origin=origin, protocols=protocols):
                with self.assertRaises(InvalidHandshake):
                    async with connect(f'ws://127.0.0.1:{port}{path}', proxy=None,
                                       origin=origin, subprotocols=protocols):
                        pass
        self.assertFalse(task.done())
        ws, request = await self.extension(port)
        await ws.send(json.dumps({**request, 'ok': True, 'data': []}))
        await task

    async def test_extra_extension_cannot_take_over_request(self):
        port, task = await self.start_fetch()
        owner, request = await self.extension(port)
        async with connect(f'ws://127.0.0.1:{port}/ext', proxy=None, origin=ORIGIN,
                           subprotocols=[cookie.SUBPROTOCOL]) as other:
            await asyncio.wait_for(other.wait_closed(), 1)
            self.assertEqual(other.close_code, 1013)
        await owner.send(json.dumps({**request, 'ok': True, 'data': []}))
        self.assertTrue((await task)['ok'])

    async def test_invalid_response_and_extension_errors_are_safe(self):
        cases = [('not-json', 'PROTOCOL_ERROR'),
                 ({'id': 'wrong', 'protocol': 1, 'ok': True}, 'PROTOCOL_ERROR'),
                 ({'id': '1', 'protocol': 999, 'ok': True}, 'PROTOCOL_MISMATCH'),
                 ({'id': '1', 'protocol': 1, 'ok': 'yes'}, 'PROTOCOL_ERROR'),
                 ({'id': '1', 'protocol': 1, 'ok': False, 'error_code': 'DOMAIN_NOT_ALLOWED'},
                  'DOMAIN_NOT_ALLOWED')]
        for reply, code in cases:
            with self.subTest(code=code, reply=reply):
                port, task = await self.start_fetch()
                ws, _ = await self.extension(port)
                await ws.send(reply if isinstance(reply, str) else json.dumps(reply))
                with self.assertRaises(cookie.CookieSyncError) as caught:
                    await task
                self.assertEqual(caught.exception.code, code)
                assert_port_free(self, port)

    async def test_incompatible_extension_fails_without_fallback(self):
        port, task = await self.start_fetch()
        async with connect(f'ws://127.0.0.1:{port}/ext', proxy=None, origin=ORIGIN,
                           subprotocols=[cookie.SUBPROTOCOL]) as ws:
            await ws.send(json.dumps({**cookie.identity('extension'), 'protocol': 999}))
            with self.assertRaises(cookie.CookieSyncError) as caught:
                await task
            self.assertEqual(caught.exception.code, 'PROTOCOL_MISMATCH')
        assert_port_free(self, port)

    async def test_disconnect_fails_and_releases_port(self):
        port, task = await self.start_fetch()
        ws, _ = await self.extension(port)
        await ws.close()
        with self.assertRaises(cookie.CookieSyncError) as caught:
            await task
        self.assertEqual(caught.exception.code, 'EXTENSION_DISCONNECTED')
        assert_port_free(self, port)

    async def test_total_deadline_covers_waiting_and_response(self):
        for with_extension in [False, True]:
            with self.subTest(with_extension=with_extension):
                port, task = await self.start_fetch(timeout=.3)
                if with_extension:
                    await self.extension(port)
                with self.assertRaises(cookie.CookieSyncError) as caught:
                    await task
                self.assertEqual(caught.exception.code,
                                 'TIMEOUT' if with_extension else 'EXTENSION_UNAVAILABLE')
                assert_port_free(self, port)

    async def test_cancellation_closes_temporary_listener(self):
        port, task = await self.start_fetch()
        await self.extension(port)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        assert_port_free(self, port)


class ProcessTests(unittest.IsolatedAsyncioTestCase):
    async def start_cli(self, *args, port=None, no_site=False):
        directory = tempfile.TemporaryDirectory(prefix='cookie-sync-test-')
        self.addCleanup(directory.cleanup)
        process = await asyncio.create_subprocess_exec(
            sys.executable, '-B', *(['-S'] if no_site else []), str(SCRIPT), *args,
            cwd=directory.name, env={**os.environ, 'COOKIE_SYNC_PORT': str(port or unused_port())},
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        async def cleanup():
            if process.returncode is None:
                process.kill()
            await process.wait()
        self.addAsyncCleanup(cleanup)
        return process, Path(directory.name)

    async def output(self, process):
        out, err = await asyncio.wait_for(process.communicate(), 5)
        return process.returncode, out.decode(), err.decode()

    async def test_help_and_missing_dependency_without_site_packages(self):
        process, _ = await self.start_cli('--help', no_site=True)
        status, out, err = await self.output(process)
        self.assertEqual(status, 0)
        self.assertIn('--url', out)
        self.assertEqual(err, '')
        for args, code in [(('example.invalid',), 'DEPENDENCY_MISSING'),
                           (('--list',), 'USAGE_ERROR'), (('--bad',), 'USAGE_ERROR')]:
            process, _ = await self.start_cli(*args, no_site=True)
            status, out, err = await self.output(process)
            self.assertNotEqual(status, 0)
            self.assertEqual(out, '')
            self.assertEqual(json.loads(err)['error_code'], code)

    async def test_each_invocation_fetches_once_without_files_or_background_listener(self):
        port = unused_port()
        records = [{'name': 'session', 'value': 'synthetic', 'domain': '.example.invalid',
                    'path': '/', 'secure': True}, {'name': 'x', 'value': 'quoted"\\值'}]
        for args, data in [(('example.invalid',), records),
                           (('--url', 'https://api.example.invalid/private'), records[:1]),
                           (('example.invalid',), [])]:
            process, directory = await self.start_cli(*args, '-v', '--timeout', '3', port=port)
            await wait_started(port, process=process)
            async with connect(f'ws://127.0.0.1:{port}/ext', proxy=None, origin=ORIGIN,
                               subprotocols=[cookie.SUBPROTOCOL]) as ws:
                await ws.send(json.dumps(cookie.identity('extension')))
                cookie.check_identity(json.loads(await ws.recv()), 'service')
                request = json.loads(await ws.recv())
                await ws.send(json.dumps({**request, 'ok': True, 'data': data}))
                status, out, err = await self.output(process)
                diagnostics = [json.loads(line) for line in err.splitlines()]
                self.assertEqual([d['event'] for d in diagnostics[:2]],
                                 ['waiting_extension', 'extension_connected'])
                self.assertNotIn('synthetic', err)
                if data:
                    self.assertEqual(status, 0)
                    self.assertEqual(len(out.splitlines()), 1)
                    expected = ('session=synthetic; x=quoted"\\值' if len(data) == 2
                                else 'session=synthetic')
                    self.assertEqual(json.loads(out), {'cookie_header': expected})
                    self.assertEqual(len(diagnostics), 2)
                else:
                    self.assertEqual((status, out), (1, ''))
                    self.assertEqual(diagnostics[-1]['error_code'], 'COOKIE_EMPTY')
                await asyncio.wait_for(ws.wait_closed(), 1)
            self.assertEqual(list(directory.iterdir()), [])
            assert_port_free(self, port)

    async def test_occupied_port_fails_without_contacting_or_replacing_its_owner(self):
        contacted = asyncio.Event()
        async def foreign_service(reader, writer):
            contacted.set()
            writer.close()
            await writer.wait_closed()
        server = await asyncio.start_server(foreign_service, '127.0.0.1', 0)
        async with server:
            port = server.sockets[0].getsockname()[1]
            process, directory = await self.start_cli('example.invalid', port=port)
            status, out, err = await self.output(process)
            self.assertEqual((status, out), (1, ''))
            self.assertEqual(json.loads(err)['error_code'], 'LOCAL_UNAVAILABLE')
            self.assertFalse(contacted.is_set())
            self.assertTrue(server.is_serving())
            self.assertEqual(list(directory.iterdir()), [])

    async def test_interrupt_exits_130_and_releases_port(self):
        port = unused_port()
        process, directory = await self.start_cli('example.invalid', port=port)
        await wait_started(port, process=process)
        process.send_signal(signal.SIGINT)
        status, out, err = await self.output(process)
        self.assertEqual((status, out), (130, ''))
        self.assertEqual(len(err.splitlines()), 1)
        self.assertEqual(json.loads(err)['error_code'], 'LOCAL_UNAVAILABLE')
        self.assertEqual(list(directory.iterdir()), [])
        assert_port_free(self, port)


if __name__ == '__main__':
    unittest.main()
