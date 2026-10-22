import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSite } from '../src/sites.js';
import { Store } from '../src/store.js';
import { freshDatabase, pgliteConnector } from './pglite.js';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/schema.js';

const sha = 'a'.repeat(40);
const ref = 'https://github.com/acme/site/pull/12';
const approval = { chatgpt_approved: 1, chatgpt_approval_ref: ref, chatgpt_approval_sha: sha };

test('approval requires a safe review link and the exact revision', () => {
  assert.deepEqual(cleanSite(approval), approval);
  assert.throws(() => cleanSite({ chatgpt_approved: true }), /requires the reviewed commit/);
  assert.throws(() => cleanSite({ ...approval, chatgpt_approval_ref: 'javascript:alert(1)' }));
  assert.throws(() => cleanSite({ ...approval, chatgpt_approval_ref: ref + '?token=secret' }));
  assert.throws(() => cleanSite({ ...approval, chatgpt_approval_sha: 'main' }));
});

test('approval is persisted with a timestamp and does not mark the site deployed', async () => {
  const { db, connect } = await freshDatabase();
  try {
    const store = new Store(connect);
    const site = await store.create({ name: 'Acme', live_platform: 'wordpress', needs_seo_ppc: 1 });
    assert.equal(site.chatgpt_approved, null);
    const approved = (await store.update(site.id, approval, site.updated_at)).site;
    assert.equal(approved.chatgpt_approved, true);
    assert.equal(approved.chatgpt_approval_sha, sha);
    assert.ok(Date.parse(approved.chatgpt_approved_at));
    assert.equal(approved.live_platform, 'wordpress');
    assert.equal(approved.needs_seo_ppc, true);
    assert.equal(approved.golive, null);
    assert.equal((await store.list())[0].chatgpt_approved, true);
    const h = (await db.query("SELECT * FROM history WHERE field='chatgpt_approved'")).rows;
    assert.equal(h.length, 1);
    await store.update(site.id, { chatgpt_approved: 0 }, null);
    const cleared = await store.read(site.id);
    assert.equal(cleared.chatgpt_approved, false);
    assert.equal(cleared.chatgpt_approval_ref, null);
    assert.equal(cleared.chatgpt_approved_at, null);
  } finally { await db.close(); }
});

test('direct database edits to tracked scope or jobs invalidate approval', async () => {
  const { db, connect } = await freshDatabase();
  try {
    const store = new Store(connect);
    const site = await store.create({ name: 'Acme', github_repo: 'acme/site' });
    await store.update(site.id, approval, null);
    await db.query("UPDATE sites SET staging_domain='stage.acme.com' WHERE id=$1", [site.id]);
    assert.equal((await store.read(site.id)).chatgpt_approved, false);
    await store.update(site.id, approval, null);
    const job = (await store.createItem('jobs', site.id, { url: 'acme.com', seo_ppc: 1 })).item;
    assert.equal((await store.read(site.id)).chatgpt_approved, false);
    await store.update(site.id, approval, null);
    await store.updateItem('jobs', site.id, job.id, { notes: 'New work requested' }, null);
    assert.equal((await store.read(site.id)).chatgpt_approved, false);
    await store.update(site.id, approval, null);
    await store.removeItem('jobs', site.id, job.id);
    assert.equal((await store.read(site.id)).chatgpt_approved, false);
    await assert.rejects(db.query("UPDATE sites SET chatgpt_approved=1 WHERE id=$1", [site.id]));
  } finally { await db.close(); }
});

test('migration preserves existing sites and starts them unapproved', async () => {
  const db = new PGlite();
  const connect = pgliteConnector(db);
  try {
    await migrate(connect, { upTo: 6 });
    await db.query("INSERT INTO sites (id,name,created_at,updated_at) VALUES ('existing','Existing','c','u')");
    await migrate(connect);
    await migrate(connect);
    const site = (await db.query("SELECT * FROM sites WHERE id='existing'")).rows[0];
    assert.equal(site.name, 'Existing');
    assert.equal(site.chatgpt_approved, null);
  } finally { await db.close(); }
});
