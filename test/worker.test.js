// The Worker's request boundary, exercised through its real fetch(): routing,
// the key check, the x-desk rule for cookie callers, and the headers on every
// sensitive answer. worker.js imports `cloudflare:workers` and `pg`, which
// plain Node cannot load, so test/worker/hooks.mjs stands in for those two
// (the database is PGlite) and nothing in src/ is changed for the test.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { timingSafeEqual, generateKeyPairSync, sign } from 'node:crypto';

register('./worker/hooks.mjs', import.meta.url);

// Everything that reaches db.js is imported after the hooks are registered, so
// that it gets the stand-in `pg` and not one already loaded with the real one.
const { freshDatabase } = await import('./pglite.js');
const { Store } = await import('../src/store.js');
const { encryptPassword } = await import('../src/secrets.js');
const { sessionToken, COOKIE } = await import('../src/session.js');

// The Workers runtime has crypto.subtle.timingSafeEqual; Node does not.
crypto.subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b));

const ORIGIN = 'https://website.10xid.com';
const KEY = 'test-desk-key-not-a-real-secret';
const CREDENTIALS_KEY = Buffer.alloc(32, 5).toString('base64');
const PASSWORD = 'correct-horse-battery-staple';

let worker, env, cookie, siteId, serviceId;
const pending = [];
const ctx = { waitUntil: (p) => { pending.push(Promise.resolve(p).catch(() => {})); } };

before(async () => {
  const { db, connect } = await freshDatabase();
  globalThis.deskTestDb = db;
  const store = new Store(connect);
  siteId = (await store.create({ name: 'Example Site' })).id;
  const made = await store.createItem('services', siteId, { kind: 'github', identifier: 'example' },
    { password: await encryptPassword(CREDENTIALS_KEY, PASSWORD) });
  serviceId = made.item.id;
  env = { DASH_KEY: KEY, DATABASE_URL: 'postgres://stub', CREDENTIALS_KEY, ASSETS: { fetch: () => new Response('page') } };
  cookie = `${COOKIE}=${await sessionToken(KEY)}`;
  worker = (await import('../src/worker.js')).default;
});

async function call(path, { method = 'GET', headers = {}, body, e = env } = {}) {
  const res = await worker.fetch(new Request(ORIGIN + path, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }), e, ctx);
  await Promise.allSettled(pending.splice(0));
  return res;
}
const reveal = () => `/api/sites/${siteId}/services/${serviceId}/password`;
const asCookie = (extra = {}) => ({ cookie, ...extra });
const asBearer = (extra = {}) => ({ authorization: `Bearer ${KEY}`, ...extra });
const noStore = (res, what) => assert.equal(res.headers.get('cache-control'), 'no-store', `${what} must be no-store`);

test('a cookie request that changes anything without x-desk: 1 is refused, password reveal included', async () => {
  const cases = [
    ['POST', reveal()],
    ['POST', '/api/sites', { name: 'Intruder' }],
    ['PATCH', `/api/sites/${siteId}`, { notes: 'x' }],
    ['DELETE', `/api/sites/${siteId}`],
    ['POST', `/api/sites/${siteId}/services`, { kind: 'github' }],
  ];
  for (const [method, path, body] of cases) {
    for (const extra of [{}, { 'x-desk': '0' }, { 'x-desk': 'true' }]) {
      const res = await call(path, { method, headers: asCookie(extra), body });
      const text = await res.text();
      const label = `${method} ${path} x-desk=${extra['x-desk']}`;
      assert.equal(res.status, 403, label);
      assert.equal(JSON.parse(text).code, 'not-from-desk', label);
      assert.ok(!text.includes(PASSWORD), label);
      noStore(res, label);
    }
  }
  const after = await call('/api/sites', { headers: asBearer() });
  assert.deepEqual((await after.json()).sites.map((s) => s.name), ['Example Site'], 'nothing was created or changed');
});

test('the refused reveal grants no CORS permission to another page', async () => {
  const evil = 'https://evil.10xid.com';
  const res = await call(reveal(), { method: 'POST', headers: asCookie({ origin: evil }) });
  assert.equal(res.status, 403);
  const preflight = await call(reveal(), { method: 'OPTIONS', headers: asCookie({
    origin: evil, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-desk' }) });
  assert.equal(preflight.status, 403, 'the preflight is not agreed to');
  for (const r of [res, preflight]) {
    assert.deepEqual([...r.headers.keys()].filter((h) => h.startsWith('access-control-')), []);
    noStore(r, 'the answer');
  }
});

test('the desk page itself (cookie with x-desk: 1) can still reveal, read and change', async () => {
  const shown = await call(reveal(), { method: 'POST', headers: asCookie({ 'x-desk': '1' }) });
  assert.equal(shown.status, 200);
  assert.equal((await shown.json()).password, PASSWORD);
  noStore(shown, 'the password reveal');
  assert.match(shown.headers.get('set-cookie'), /^desk_session=[0-9a-f]{64}; .*HttpOnly; SameSite=Strict; Secure/, 'the login is still renewed');

  const read = await call('/api/sites', { headers: asCookie() });
  assert.equal(read.status, 200, 'a plain GET needs no x-desk');
  const made = await call('/api/sites', { method: 'POST', headers: asCookie({ 'x-desk': '1' }), body: { name: 'Made From Page' } });
  assert.equal(made.status, 201);
  const gone = await call(`/api/sites/${(await made.json()).site.id}`, { method: 'DELETE', headers: asCookie({ 'x-desk': '1' }) });
  assert.equal(gone.status, 200);
});

test('a bearer caller needs no x-desk, for reads, changes and the reveal', async () => {
  const shown = await call(reveal(), { method: 'POST', headers: asBearer() });
  assert.equal(shown.status, 200);
  assert.equal((await shown.json()).password, PASSWORD);
  assert.equal(shown.headers.get('set-cookie'), null, 'a script is not given a login cookie');
  noStore(shown, 'the bearer reveal');
  const made = await call('/api/sites', { method: 'POST', headers: asBearer(), body: { name: 'Made By Script' } });
  assert.equal(made.status, 201);
  assert.equal((await call(`/api/sites/${(await made.json()).site.id}`, { method: 'DELETE', headers: asBearer() })).status, 200);
});

test('every refusal and error answer is private, uncacheable and has no CORS', async () => {
  const seen = {
    'no credentials': await call('/api/sites'),
    'wrong bearer': await call('/api/sites', { headers: { authorization: 'Bearer nope' } }),
    'stale cookie': await call('/api/sites', { headers: { cookie: `${COOKIE}=old` } }),
    'no key configured': await call('/api/sites', { headers: asBearer(), e: { ...env, DASH_KEY: '' } }),
    'bad login': await call('/api/session', { method: 'POST', body: { key: 'wrong' } }),
    'plain http': await worker.fetch(new Request('http://website.10xid.com/api/sites', { headers: asBearer() }), env, ctx),
    'database missing': await call('/api/sites', { headers: asBearer(), e: { ...env, DATABASE_URL: '' } }),
    'site not found': await call('/api/sites/9999', { method: 'DELETE', headers: asBearer() }),
    'service not found': await call(`/api/sites/${siteId}/services/9999/password`, { method: 'POST', headers: asBearer() }),
    'wrong method on reveal': await call(reveal(), { headers: asBearer() }),
  };
  assert.deepEqual(Object.fromEntries(Object.entries(seen).map(([k, r]) => [k, r.status])), {
    'no credentials': 401, 'wrong bearer': 401, 'stale cookie': 401, 'no key configured': 401, 'bad login': 401,
    'plain http': 403, 'database missing': 503, 'site not found': 404, 'service not found': 404, 'wrong method on reveal': 405,
  });
  for (const [what, res] of Object.entries(seen)) {
    noStore(res, what);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', what);
    assert.equal(res.headers.get('access-control-allow-origin'), null, what);
  }
  assert.match(seen['stale cookie'].headers.get('set-cookie'), /Max-Age=0/, 'a stale login is cleared');
});

test('login answers and UiD redirects are no-store; a pass that is not valid logs nobody in', async () => {
  const login = await call('/api/session', { method: 'POST', body: { key: KEY } });
  assert.equal(login.status, 200);
  noStore(login, 'the login');
  assert.match(login.headers.get('set-cookie'), /^desk_session=[0-9a-f]{64}; .*HttpOnly/);
  noStore(await call('/api/session', { method: 'DELETE' }), 'log off');

  for (const url of ['/api/session/uid?pass=garbage', '/api/session/uid']) {
    const res = await call(url);
    assert.equal(res.status, 302, url);
    assert.equal(res.headers.get('location'), '/');
    assert.equal(res.headers.get('set-cookie'), null, 'no cookie for a refused pass');
    noStore(res, 'the UiD redirect');
  }
});

test('the page still goes to the assets binding, and the Access return trip needs no key', async () => {
  assert.equal(await (await call('/')).text(), 'page');
  assert.notEqual((await call('/api/golive/signin')).status, 401);
});

test('a valid UiD pass logs in once through the worker; a replay or a pass for another desk does not', async () => {
  const UID = 'https://uid-bypaolo.10xid.com';
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const uidEnv = { ...env, UID_LOGINS: { [UID]: { key: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'), emails: ['paolo@tboxstudio.com'] } } };
  const pass = (over = {}) => {
    const claim = { v: 1, iss: UID, aud: ORIGIN, email: 'paolo@tboxstudio.com', exp: Date.now() + 30_000, nonce: 'worker-test-nonce-22-chars-x', ...over };
    const body = Buffer.from(JSON.stringify(claim)).toString('base64url');
    return `${body}.${sign(null, Buffer.from(body), privateKey).toString('base64url')}`;
  };
  const go = (p) => call('/api/session/uid?pass=' + encodeURIComponent(p), { e: uidEnv });

  const wrongDesk = await go(pass({ aud: 'https://website.example.com', nonce: 'worker-test-nonce-22-chars-y' }));
  assert.equal(wrongDesk.headers.get('set-cookie'), null);

  const good = await go(pass());
  assert.equal(good.status, 302);
  assert.equal(good.headers.get('location'), '/');
  noStore(good, 'the UiD login redirect');
  assert.equal(good.headers.get('set-cookie').split(';')[0], cookie, 'the same login the key gives');

  const replay = await go(pass());
  assert.equal(replay.status, 302);
  assert.equal(replay.headers.get('set-cookie'), null, 'a pass works once');
  noStore(replay, 'the replay redirect');
});
