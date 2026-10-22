import test from 'node:test';
import assert from 'node:assert/strict';

test('real entrypoint creates packaged-safe local alarm and sends versioned replies', async (t) => {
  const keys = ['chrome', 'fetch', 'WebSocket', 'setTimeout', 'clearTimeout'];
  const originals = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  t.after(() => Object.assign(globalThis, originals));
  const listeners = {};
  const alarms = [];
  const sockets = [];
  const queries = [];
  let sequence = 0;
  globalThis.setTimeout = () => ++sequence;
  globalThis.clearTimeout = () => {};
  const hello = { type: 'hello', role: 'service', service: 'cookie-sync', protocol: 1, capabilities: ['domain', 'url'] };
  globalThis.fetch = async () => ({ ok: true, json: async () => hello });
  class FakeSocket {
    static OPEN = 1; static CONNECTING = 0;
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  globalThis.WebSocket = FakeSocket;
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => Array.isArray(keys) ? { cloudDomains: { domains: {
          'api.example.invalid': { localAccess: true, cloudSync: 'disabled' },
        } } } : {},
        set: async () => { assert.fail('unexpected storage write'); },
      },
      sync: { get: async () => ({}), remove: async () => {} },
    },
    cookies: { getAll: async (query) => {
      queries.push(query);
      return [{ name: 'session', value: 'synthetic', domain: '.example.invalid', path: '/private' }];
    } },
    alarms: {
      create: (name, options) => alarms.push({ name, options }),
      clear: async () => true,
      onAlarm: { addListener: (fn) => { listeners.alarm = fn; } },
    },
    runtime: {
      onInstalled: { addListener: (fn) => { listeners.install = fn; } },
      onStartup: { addListener: (fn) => { listeners.startup = fn; } },
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
    },
  };
  await import('../cookie-sync-extension/background/main.js');
  await listeners.install();
  await Promise.resolve();
  assert.deepEqual(alarms, [{ name: 'keepalive', options: { periodInMinutes: .5 } }]);
  assert.equal(sockets.length, 1);
  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  await socket.onmessage({ data: JSON.stringify(hello) });
  const url = 'https://api.example.invalid/private/profile';
  await socket.onmessage({ data: JSON.stringify({ id: 'fixture-url', protocol: 1, action: 'getCookies', url }) });
  const result = socket.sent.at(-1);
  assert.equal(result.id, 'fixture-url');
  assert.equal(result.protocol, 1);
  assert.equal(result.ok, true);
  assert.equal(result.data[0].domain, '.example.invalid');
  assert.deepEqual(queries, [{ url }]);
});
