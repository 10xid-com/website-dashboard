import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { uidLogins, checkPass, MAX_LIFE_MS } from '../src/uid-login.js';
import { Store } from '../src/store.js';
import { freshDatabase } from './pglite.js';

const UID = 'https://uid-bypaolo.10xid.com';
const DESK = 'https://website.10xid.com';
const NOW = Date.parse('2026-11-07T12:00:00Z');

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, pub: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url') };
}
const paolo = keys();
const logins = uidLogins({ [UID]: { key: paolo.pub, emails: ['Paolo@TBoxStudio.com'] } });

// As the UiD signs one (server/desk-pass.mjs in UiD by Paolo).
function pass(over = {}, privateKey = paolo.privateKey) {
  const claim = { v: 1, iss: UID, aud: DESK, email: 'paolo@tboxstudio.com', exp: NOW + 60_000, nonce: 'n0nce-of-at-least-22-chars', ...over };
  const body = Buffer.from(JSON.stringify(claim)).toString('base64url');
  return `${body}.${sign(null, Buffer.from(body), privateKey).toString('base64url')}`;
}
const check = (p, over = {}) => checkPass(p, { logins, audience: DESK, now: NOW, ...over });

test('a pass signed by the UiD, for this desk, in time, for its person, logs in', async () => {
  assert.deepEqual(await check(pass()), { ok: true, iss: UID, email: 'paolo@tboxstudio.com', nonce: 'n0nce-of-at-least-22-chars', exp: NOW + 60_000 });
  const shouting = await check(pass({ email: 'PAOLO@tboxstudio.com' }));
  assert.equal(shouting.ok, true, 'an address is the same in any case');
});

test('a pass that was changed, or signed by anyone else, is refused', async () => {
  const good = pass();
  const [body, sig] = good.split('.');
  const other = Buffer.from(JSON.stringify({ v: 1, iss: UID, aud: DESK, email: 'someone@example.com', exp: NOW + 60_000, nonce: 'n0nce-of-at-least-22-chars' })).toString('base64url');
  assert.equal((await check(`${other}.${sig}`)).why, 'bad-signature', 'a new payload under the old signature');
  assert.equal((await check(`${body}.${'A'.repeat(86)}`)).why, 'bad-signature');
  assert.equal((await check(pass({}, keys().privateKey))).why, 'bad-signature', 'another key');
  assert.equal((await check(pass({ iss: 'https://uid-ethan.10xid.com' }))).why, 'unknown-uid', 'a UiD not in UID_LOGINS');
});

test('a pass for another desk, out of time, or for someone else is refused', async () => {
  assert.equal((await check(pass({ aud: 'https://website.example.com' }))).why, 'wrong-desk');
  assert.equal((await check(pass({ exp: NOW }))).why, 'expired');
  assert.equal((await check(pass({ exp: NOW + 60_000 }), { now: NOW + 61_000 })).why, 'expired');
  assert.equal((await check(pass({ exp: NOW + MAX_LIFE_MS + 1 }))).why, 'expired', 'longer than a pass may live');
  assert.equal((await check(pass({ exp: String(NOW + 60_000) }))).why, 'expired');
  assert.equal((await check(pass({ email: 'ethan@10xid.com' }))).why, 'not-allowed');
  assert.equal((await check(pass({ email: undefined }))).why, 'not-allowed');
});

test('anything that is not a pass is refused before it is read', async () => {
  for (const bad of [null, undefined, '', 'nope', 'a.b', `${pass()}.x`, `${pass()} `, 'x'.repeat(5000)]) {
    assert.equal((await check(bad)).why, 'malformed', String(bad).slice(0, 20));
  }
  assert.equal((await check(pass({ v: 2 }))).why, 'malformed');
  assert.equal((await check(pass({ nonce: 'short' }))).why, 'malformed');
  assert.equal((await check(pass({ nonce: undefined }))).why, 'malformed');
});

test('UID_LOGINS is read from wrangler.jsonc or .dev.vars, and a broken entry opens nothing', () => {
  const entry = { key: paolo.pub, emails: ['paolo@tboxstudio.com'] };
  assert.deepEqual([...uidLogins(JSON.stringify({ [UID]: entry })).keys()], [UID], 'text, from .dev.vars');
  assert.equal(uidLogins(undefined).size, 0);
  assert.equal(uidLogins('not json').size, 0);
  assert.equal(uidLogins([entry]).size, 0);
  assert.equal(uidLogins({ [UID]: { ...entry, key: 'short' } }).size, 0);
  assert.equal(uidLogins({ [UID]: { key: paolo.pub } }).size, 0, 'nobody named');
  assert.equal(uidLogins({ [UID]: { ...entry, emails: [] } }).size, 0);
  assert.equal(uidLogins({ 'uid-bypaolo.10xid.com': entry }).size, 0, 'an origin, not a host');
  assert.equal(uidLogins({ [`${UID}/`]: entry }).size, 0);
});

test('wrangler.jsonc names Paolo\'s UiD, with a whole public key, for Paolo only', () => {
  const text = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
  const live = uidLogins(config.vars.UID_LOGINS);
  assert.deepEqual([...live.keys()], [UID]);
  assert.deepEqual([...live.get(UID).emails], ['paolo@tboxstudio.com']);
});

test('a pass works once, and spent passes are cleared once they would have expired', async () => {
  const { db, connect } = await freshDatabase();
  const store = new Store(connect);
  const later = new Date(Date.now() + 60_000).toISOString();
  assert.equal(await store.usePass('nonce-one-of-22-chars-x', UID, later), true);
  assert.equal(await store.usePass('nonce-one-of-22-chars-x', UID, later), false, 'the same pass again');
  assert.equal(await store.usePass('nonce-two-of-22-chars-x', UID, later), true);
  await db.query("INSERT INTO uid_passes (nonce, iss, expires_at) VALUES ('old-nonce-of-22-chars-x', $1, '2026-01-01T00:00:00.000Z')", [UID]);
  await store.usePass('nonce-three-of-22-chars', UID, later);
  const left = (await db.query('SELECT nonce FROM uid_passes ORDER BY nonce')).rows.map((r) => r.nonce);
  assert.deepEqual(left, ['nonce-one-of-22-chars-x', 'nonce-three-of-22-chars', 'nonce-two-of-22-chars-x']);
});
