import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';

let sequence = 0;

async function fixture(t) {
  const keys = ['document', 'window', 'chrome'];
  const original = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  t.after(() => Object.assign(globalThis, original));
  const elements = new Map();
  const documentEvents = new Map();
  const windowEvents = new Map();
  const timers = new Map();
  const calls = [];
  const delayed = [];
  let response = { connected: false, reconnecting: true };
  let fail = false;
  let defer = false;
  let timerId = 0;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', innerHTML: '', className: '',
      addEventListener() {}, querySelectorAll: () => [],
    });
    return elements.get(id);
  }
  globalThis.document = {
    hidden: false,
    getElementById: element,
    querySelectorAll: () => [],
    addEventListener: (name, listener) => documentEvents.set(name, listener),
  };
  globalThis.window = {
    setInterval: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearInterval: (id) => timers.delete(id),
    addEventListener: (name, listener) => windowEvents.set(name, listener),
  };
  const runtime = {
    sendMessage(message, callback) {
      calls.push(message.type);
      if (message.type === 'getDomains') { callback({ entries: [] }); return; }
      if (defer) { delayed.push(callback); return; }
      runtime.lastError = fail ? { message: 'synthetic background unavailable' } : undefined;
      callback(response);
      runtime.lastError = undefined;
    },
  };
  globalThis.chrome = { runtime };
  await import(`../cookie-sync-extension/popup/popup.js?fixture=${++sequence}`);
  await flush();
  return {
    element, timers, calls, delayed,
    respond(value) { response = value; },
    fail(value) { fail = value; },
    defer(value) { defer = value; },
    async tick() {
      const timer = [...timers.values()][0];
      assert.ok(timer, 'visible popup should keep one status observer');
      await timer.callback();
      await flush();
    },
    async hide(hidden) {
      document.hidden = hidden;
      documentEvents.get('visibilitychange')();
      await flush();
    },
    close() { windowEvents.get('pagehide')(); },
  };
}

test('waiting is neutral standby and connected UI returns to standby after idle exit', async (t) => {
  const f = await fixture(t);
  assert.equal(f.element('status').textContent, '待命');
  assert.equal(f.element('dot').className, 'dot standby');
  assert.equal(f.element('statusHint').textContent, '有本地请求时自动接入');
  assert.equal(f.timers.size, 1);

  f.respond({ connected: true, reconnecting: false });
  await f.tick();
  assert.equal(f.element('status').textContent, '已接入');
  assert.equal(f.element('dot').className, 'dot connected');
  assert.equal(f.timers.size, 1);

  f.respond({ connected: false, reconnecting: false });
  await f.tick();
  assert.equal(f.element('status').textContent, '待命');
  assert.equal(f.element('dot').className, 'dot standby');
  assert.deepEqual(f.calls, ['popupOpened', 'getDomains', 'getStatus', 'getStatus']);
});

test('status observation pauses when hidden and stops on popup close', async (t) => {
  const f = await fixture(t);
  const staleTick = [...f.timers.values()][0].callback;
  await f.hide(true);
  assert.equal(f.timers.size, 0);
  const before = f.calls.length;
  await staleTick();
  assert.equal(f.calls.length, before);

  f.respond({ connected: true });
  await f.hide(false);
  assert.equal(f.timers.size, 1);
  assert.equal(f.element('status').textContent, '已接入');
  f.close();
  assert.equal(f.timers.size, 0);
  await f.hide(false);
  assert.equal(f.timers.size, 0);
});

test('background errors recover without overlapping requests or stale updates after close', async (t) => {
  const f = await fixture(t);
  f.fail(true);
  await f.tick();
  assert.equal(f.element('status').textContent, '状态暂不可用');
  assert.equal(f.timers.size, 1);

  f.fail(false);
  f.respond({ connected: true });
  await f.tick();
  assert.equal(f.element('status').textContent, '已接入');

  f.defer(true);
  const timer = [...f.timers.values()][0];
  const pending = timer.callback();
  await timer.callback();
  assert.equal(f.delayed.length, 1);
  f.close();
  f.delayed[0]({ connected: false });
  await pending;
  assert.equal(f.element('status').textContent, '已接入');
  assert.equal(f.timers.size, 0);
});
