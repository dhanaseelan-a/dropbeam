import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/ice-servers.js';

function env(t, key, value) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
}

function response() {
  return { headers: {}, statusCode: 200, body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('unconfigured relay endpoint fails explicitly instead of returning fake credentials', async t => {
  env(t, 'METERED_DOMAIN', ''); env(t, 'METERED_API_KEY', '');
  const res = response(); await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 503); assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('relay endpoint returns ICE credentials without disclosing its API key', async t => {
  env(t, 'METERED_DOMAIN', 'dropbeam.metered.live'); env(t, 'METERED_API_KEY', 'server-only-key');
  const servers = [{ urls: 'turns:relay.example:443?transport=tcp', username: 'short-lived', credential: 'rtc-password' }];
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url.hostname, 'dropbeam.metered.live');
    assert.equal(url.searchParams.get('apiKey'), 'server-only-key');
    return { ok: true, json: async () => servers };
  });
  const res = response(); await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body.iceServers, servers);
  assert.ok(!JSON.stringify(res).includes('server-only-key'));
});

test('relay endpoint rejects non-provider hosts and unsupported methods', async t => {
  env(t, 'METERED_DOMAIN', 'example.org'); env(t, 'METERED_API_KEY', 'secret');
  const res = response(); await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 503);
  const post = response(); await handler({ method: 'POST' }, post);
  assert.equal(post.statusCode, 405); assert.equal(post.headers.Allow, 'GET');
});

test('relay provider failure does not leak its request URL or API key', async t => {
  env(t, 'METERED_DOMAIN', 'dropbeam.metered.ca'); env(t, 'METERED_API_KEY', 'secret');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('https://dropbeam.metered.ca/?apiKey=secret'); });
  const res = response(); await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 502); assert.ok(!JSON.stringify(res).includes('secret'));
});
