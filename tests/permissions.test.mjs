import test from 'node:test';
import assert from 'node:assert/strict';
import * as whitelist from '../cookie-sync-extension/background/whitelist.js';
import { handleGetCookies } from '../cookie-sync-extension/background/cookie-ops.js';
import { normalizeDomain } from '../cookie-sync-extension/background/domain-utils.js';

let calls;
async function configure(domains, cookies = []) {
  calls = [];
  globalThis.chrome = {
    storage: {
      local: { get: async () => ({ cloudDomains: { domains } }), set: async () => {} },
      sync: { get: async () => ({}), remove: async () => {} },
    },
    cookies: { getAll: async (query) => { calls.push(query); return cookies; } },
  };
  await whitelist.init();
}
const entry = (localAccess, cloudSync) => ({ localAccess, cloudSync });
const cookie = (domain, path = '/') => ({ name: 'session', value: 'synthetic', domain, path, secure: true });

test('most specific entry wins for both independent switches', async () => {
  for (const parentLocal of [true, false]) {
    for (const childLocal of [true, false]) {
      for (const parentCloud of ['enabled', 'disabled', 'pending']) {
        for (const childCloud of ['enabled', 'disabled', 'pending']) {
          await configure({
            'example.invalid': entry(parentLocal, parentCloud),
            'api.example.invalid': entry(childLocal, childCloud),
          });
          assert.equal(whitelist.isAllowed('api.example.invalid'), childLocal);
          assert.equal(whitelist.isAllowed('deep.api.example.invalid'), childLocal);
          assert.equal(whitelist.isCloudEnabled('api.example.invalid'), childCloud === 'enabled');
          assert.equal(whitelist.isCloudEnabled('deep.api.example.invalid'), childCloud === 'enabled');
          assert.equal(whitelist.isAllowed('other.example.invalid'), parentLocal);
          assert.equal(whitelist.isCloudEnabled('other.example.invalid'), parentCloud === 'enabled');
        }
      }
    }
  }
});

test('URL mode queries full URL and authorizes matching parent cookie by target host', async () => {
  await configure({
    'example.invalid': entry(false, 'enabled'),
    'api.example.invalid': entry(true, 'disabled'),
  }, [cookie('.example.invalid', '/private')]);
  const url = 'https://api.example.invalid:8443/private/profile?q=1';
  const result = await handleGetCookies({ url });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ url }]);
  assert.equal(result.data[0].domain, '.example.invalid');
  assert.equal(whitelist.isCloudEnabled('api.example.invalid'), false);
});

test('target explicitly OFF rejects entire URL before Chrome query', async () => {
  await configure({
    'example.invalid': entry(true, 'enabled'),
    'api.example.invalid': entry(false, 'enabled'),
  });
  const result = await handleGetCookies({ url: 'https://api.example.invalid/private' });
  assert.deepEqual(result, { ok: false, error_code: 'DOMAIN_NOT_ALLOWED' });
  assert.deepEqual(calls, []);
});

test('domain mode preserves owner-domain permission filtering', async () => {
  await configure({
    'example.invalid': entry(false, 'enabled'),
    'api.example.invalid': entry(true, 'disabled'),
    'blocked.api.example.invalid': entry(false, 'enabled'),
  }, [cookie('.example.invalid'), cookie('api.example.invalid'), cookie('blocked.api.example.invalid')]);
  const result = await handleGetCookies({ domain: 'api.example.invalid' });
  assert.deepEqual(calls, [{ domain: 'api.example.invalid' }]);
  assert.deepEqual(result.data.map((c) => c.domain), ['api.example.invalid']);
});

test('empty cookies remain a valid extension result', async () => {
  await configure({ 'example.invalid': entry(true, 'disabled') });
  assert.deepEqual(await handleGetCookies({ domain: 'example.invalid' }), { ok: true, data: [] });
});

test('Chrome failures never echo raw credential-bearing exception messages', async () => {
  await configure({ 'example.invalid': entry(true, 'disabled') });
  chrome.cookies.getAll = async () => { throw new Error('synthetic-cookie-value'); };
  assert.deepEqual(await handleGetCookies({ domain: 'example.invalid' }),
                   { ok: false, error_code: 'COOKIE_READ_FAILED' });
});

test('invalid and ambiguous query modes fail before Chrome query', async () => {
  await configure({});
  for (const params of [{}, { domain: 'example.invalid', url: 'https://example.invalid/' },
                        { url: 'file:///private/tmp/synthetic' }, { url: 'not a URL' },
                        { url: 'https://fixture:fake-password@example.invalid/' }]) {
    assert.equal((await handleGetCookies(params)).error_code, 'USAGE_ERROR');
  }
  assert.deepEqual(calls, []);
});

test('normalization uses native URL canonicalization without changing UI grouping', () => {
  assert.equal(normalizeDomain('HTTPS://BÜCHER.Example.invalid:8443/private?q=1'), 'xn--bcher-kva.example.invalid');
  assert.equal(normalizeDomain('.Example.invalid'), 'example.invalid');
  assert.equal(normalizeDomain('faß.example.invalid'), 'xn--fa-hia.example.invalid');
  assert.equal(normalizeDomain('http://[::1]:8080/private'), '[::1]');
  assert.equal(normalizeDomain('https://fixture:fake-password@example.invalid/'), '');
});
