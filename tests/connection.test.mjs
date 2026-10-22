import test from 'node:test';
import assert from 'node:assert/strict';

const original = Object.fromEntries(['fetch', 'WebSocket', 'setTimeout', 'clearTimeout'].map((key) => [key, globalThis[key]]));
let sequence = 0;
const hello = { type: 'hello', role: 'service', service: 'cookie-sync', protocol: 1, capabilities: ['domain', 'url'] };

async function fixture(t, fetcher = async () => ({ ok: true, json: async () => hello })) {
  const timers = new Map();
  const sockets = [];
  let nextTimer = 0;
  class FakeSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
    constructor(url, protocol) {
      this.url = url; this.protocol = protocol; this.readyState = 0; this.sent = [];
      sockets.push(this);
    }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    async message(data) { await this.onmessage?.({ data: JSON.stringify(data) }); }
  }
  globalThis.WebSocket = FakeSocket;
  globalThis.fetch = fetcher;
  globalThis.setTimeout = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  t.after(() => Object.assign(globalThis, original));
  const connection = await import(`../cookie-sync-extension/background/connection.js?fixture=${++sequence}`);
  return { connection, timers, sockets };
}

test('concurrent attempts share guard across asynchronous ping', async (t) => {
  let resolvePing;
  let pings = 0;
  const f = await fixture(t, () => { pings++; return new Promise((resolve) => { resolvePing = resolve; }); });
  const initial = f.connection.init(async () => ({}));
  await Promise.all([f.connection.tryConnect(), f.connection.tryConnect(), f.connection.restartShortRetryWindow()]);
  assert.equal(pings, 1);
  resolvePing({ ok: true, json: async () => hello });
  await initial;
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].protocol, 'cookie-sync-v1');
  f.sockets[0].open();
  assert.equal(f.connection.getStatus().connected, false);
  assert.equal(f.sockets[0].sent[0].role, 'extension');
  await f.sockets[0].message(hello);
  assert.equal(f.connection.getStatus().connected, true);
});

test('old callbacks and in-flight responses cannot affect a new socket', async (t) => {
  const f = await fixture(t);
  let resolveReply;
  await f.connection.init(() => new Promise((resolve) => { resolveReply = resolve; }));
  const old = f.sockets[0];
  old.open(); await old.message(hello);
  const reply = old.message({ id: 'synthetic-id', protocol: 1, action: 'getCookies', domain: 'example.invalid' });
  old.close();
  await f.connection.tryConnect();
  const current = f.sockets[1];
  current.open(); await current.message(hello);
  old.onclose(); old.onerror();
  assert.equal(current.readyState, 1);
  assert.equal(f.connection.getStatus().connected, true);
  resolveReply({ id: 'synthetic-id', protocol: 1, ok: true, data: [] });
  await reply;
  assert.equal(current.sent.length, 1); // Only its own hello.
});

test('wrong service and missing capabilities do not open WebSocket', async (t) => {
  let payload = { ...hello, service: 'foreign' };
  const f = await fixture(t, async () => ({ ok: true, json: async () => payload }));
  await f.connection.init(() => ({}));
  assert.equal(f.sockets.length, 0);
  payload = { ...hello, capabilities: ['domain'] };
  await f.connection.tryConnect();
  assert.equal(f.sockets.length, 0);
  assert.equal(f.timers.size, 1);
});

test('failed ping schedules one bounded backoff timer', async (t) => {
  const f = await fixture(t, async () => { throw new Error('synthetic offline'); });
  await f.connection.init(() => ({}));
  await Promise.all([f.connection.tryConnect(), f.connection.tryConnect()]);
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 2000);
});

test('unacknowledged handshake closes socket without exposing connected status', async (t) => {
  const f = await fixture(t);
  await f.connection.init(() => ({}));
  f.sockets[0].open();
  const handshake = [...f.timers.values()].find((timer) => timer.delay === 2000);
  handshake.callback();
  assert.equal(f.sockets[0].readyState, 3);
  assert.equal(f.connection.getStatus().connected, false);
});
