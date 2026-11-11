import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';

const assets = { fetch: async () => new Response('frontend') };
const request = (path, init) => new Request('https://parking.example' + path, init);

test('serves assets and SPA routes through the assets binding', async () => {
  const res = await worker.fetch(request('/entry'), { ASSETS: assets });
  assert.equal(await res.text(), 'frontend');
});

test('unconfigured and unsafe backend origins fail closed', async () => {
  for (const BACKEND_ORIGIN of [undefined, 'http://backend.example', 'https://user:pass@backend.example', 'https://backend.example/path', 'https://parking.example']) {
    const res = await worker.fetch(request('/api/health'), { BACKEND_ORIGIN, ASSETS: assets });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'BACKEND_NOT_CONFIGURED');
  }
});

test('proxies method, path, query, authentication and body without following redirects', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (req, options) => {
      assert.equal(req.url, 'https://backend.example/api/auth/login?x=1');
      assert.equal(req.method, 'POST');
      assert.equal(req.headers.get('authorization'), 'Bearer token');
      assert.equal(await req.text(), '{"username":"admin"}');
      assert.equal(options.redirect, 'manual');
      return Response.json({ ok: true }, { status: 201 });
    };
    const res = await worker.fetch(request('/api/auth/login?x=1', { method: 'POST', headers: { authorization: 'Bearer token' }, body: '{"username":"admin"}' }), { BACKEND_ORIGIN: 'https://backend.example', ASSETS: assets });
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { ok: true });
    globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://other.example' } });
    assert.equal((await worker.fetch(request('/api/health'), { BACKEND_ORIGIN: 'https://backend.example' })).status, 502);
    globalThis.fetch = async () => { throw new Error('unavailable'); };
    assert.equal((await worker.fetch(request('/api/health'), { BACKEND_ORIGIN: 'https://backend.example' })).status, 502);
  } finally { globalThis.fetch = originalFetch; }
});
