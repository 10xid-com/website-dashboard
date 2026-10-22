import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startRun, continueRun, readinessSummary, googleTags, formOn, isReady, FRESH_FOR, STALLED,
} from '../src/readiness.js';
import { handleReadiness } from '../src/readiness-routes.js';
import { budget, countedFetch, LIMIT } from '../src/budget.js';
import { cleanSite } from '../src/sites.js';
import { Store } from '../src/store.js';
import { createFakeSites, createFakeDoh, combineFetches } from './fake-cloudflare.js';
import { freshDatabase } from './pglite.js';

// Every call must go through the fetch a test passes in, so the budget
// counts it.
globalThis.fetch = async () => { throw new Error('readiness.js used the global fetch'); };

const STAGING = 'staging-acme.10xid.com';
const SITE = {
  id: '0007', name: 'Acme Plumbing', live_domain: 'acme.com', staging_domain: STAGING,
  github_repo: 'tbox/acme-site', live_platform: 'wordpress', approved_by: 'Paolo', approved_on: '2026-10-20',
};
const GTM = "<script>(function(w,d,s,l,i){w[l]=w[l]||[];})(window,document,'script','dataLayer','GTM-AB12CD');</script>";
const FORM = '<form method="post" action="/api/contact"><input type="email" name="email"><button>Send</button></form>';

const html = ({ canonical = 'https://acme.com/', head = '', body = '' } = {}) =>
  `<!doctype html><html><head><title>Acme</title><link rel="canonical" href="${canonical}">${head}</head>
<body><img src="https://img.acme.com/logo.webp" alt="">${body}</body></html>`;

const xml = (type, locs) => ({
  headers: { 'content-type': 'application/xml' },
  body: `<?xml version="1.0" encoding="UTF-8"?><${type} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`
    + locs.map((l) => (type === 'sitemapindex' ? `<sitemap><loc>${l}</loc></sitemap>` : `<url><loc>${l}</loc></url>`)).join('')
    + `</${type}>`,
});
const text = (body) => ({ headers: { 'content-type': 'text/plain' }, body });

// An old WordPress site with three pages behind a Yoast index, and a staging
// build that has all of them, the same tag, a form and a sitemap.
function world({ pages = {}, dns } = {}) {
  const sites = createFakeSites({
    'https://acme.com/': { body: html({ head: GTM, body: '<link rel="stylesheet" href="/wp-content/themes/acme/style.css">' }) },
    'https://acme.com/robots.txt': text('User-agent: *\nDisallow: /wp-admin/\nSitemap: https://acme.com/sitemap_index.xml\n'),
    'https://acme.com/sitemap_index.xml': xml('sitemapindex', ['https://acme.com/page-sitemap.xml', 'https://acme.com/post-sitemap.xml']),
    'https://acme.com/page-sitemap.xml': xml('urlset', ['https://acme.com/', 'https://acme.com/services/', 'https://acme.com/contact-us/']),
    'https://acme.com/post-sitemap.xml': xml('urlset', ['https://acme.com/blog/leaky-taps/', 'https://cdn.other.com/elsewhere/']),
    'https://acme.com/contact-us/': { body: html({ body: '<form action="/wp-admin/admin-ajax.php"><input name="email"></form>' }) },
    [`https://${STAGING}/`]: { body: html({ head: GTM }) },
    [`https://${STAGING}/robots.txt`]: text('User-agent: *\nAllow: /\n'),
    [`https://${STAGING}/sitemap-index.xml`]: xml('sitemapindex', ['https://acme.com/sitemap-0.xml']),
    [`https://${STAGING}/services/`]: { body: html() },
    [`https://${STAGING}/contact-us/`]: { body: html({ body: FORM }) },
    [`https://${STAGING}/blog/leaky-taps/`]: { body: html() },
    ...pages,
  });
  const resolvers = createFakeDoh({ 'dns.google': dns ?? { 'acme.com': { NS: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] } } });
  return { sites, resolvers, fetch: combineFetches(resolvers, sites) };
}

const SERVICES = [{ kind: 'gtm', identifier: 'GTM-AB12CD' }, { kind: 'resend', identifier: 'acme.com' }];

// A whole check, step by step, the way the page drives it: each step in a
// request of its own, with a fresh budget. → { result, steps, most }, `most`
// being the most calls any one request made.
async function runAll(w, { site = SITE, services = SERVICES } = {}) {
  let allowance = budget();
  let result = await startRun({ site, services, fetch: countedFetch(w.fetch, allowance) });
  let most = allowance.used;
  let steps = 0;
  while (result.state === 'running') {
    assert.ok(++steps < 200, 'the check never finished');
    allowance = budget();
    result = await continueRun({ checks: result.checks, progress: result.progress, fetch: countedFetch(w.fetch, allowance), allowance });
    most = Math.max(most, allowance.used);
  }
  return { result, steps, most };
}

const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));

// The row the store would hand readinessSummary for a finished result.
const doneRow = (result, { site = SITE, finished = Date.now() } = {}) => ({
  run: 'r1', step: 3, state: 'done', live_host: site.live_domain, staging_host: site.staging_domain,
  checks: result.checks, counts: result.counts,
  started_at: new Date(finished - 60000).toISOString(), finished_at: new Date(finished).toISOString(), updated_at: new Date(finished).toISOString(),
});

test('a site with every old page, its tag, a form and a sitemap is ready once gate 12 is recorded', async () => {
  const w = world();
  const { result } = await runAll(w);
  const c = byId(result.checks);
  assert.equal(result.state, 'done');
  assert.equal(c['old-addresses'].status, 'pass', c['old-addresses'].detail);
  // The index's two sitemaps, and only acme.com's own addresses.
  assert.match(c['old-addresses'].detail, /All 4 addresses/);
  assert.equal(c.contact.status, 'pass');
  assert.equal(c.tags.status, 'pass');
  assert.equal(c.sitemap.status, 'pass');
  assert.equal(c.nameservers.status, 'pass');
  assert.ok(isReady(result.checks));

  const summary = readinessSummary(SITE, doneRow(result));
  assert.equal(summary.ready, true);
  assert.equal(byId(summary.checks).approval.status, 'pass');
  const unapproved = readinessSummary({ ...SITE, approved_on: null }, doneRow(result));
  assert.equal(unapproved.ready, false);
  assert.equal(byId(unapproved.checks).approval.status, 'fail');
});

test('an old page that staging does not have fails, with its path; a 301 to a page that works passes', async () => {
  const w = world({
    pages: {
      'https://acme.com/page-sitemap.xml': xml('urlset', ['https://acme.com/', 'https://acme.com/about/', 'https://acme.com/team', 'https://acme.com/old-offer/', 'https://acme.com/promo/']),
      'https://acme.com/post-sitemap.xml': xml('urlset', []),
      [`https://${STAGING}/old-offer/`]: { status: 301, headers: { location: '/offers/' } },
      [`https://${STAGING}/offers/`]: { body: html() },
      // The host's own trailing slash, whatever its code, is not a move.
      [`https://${STAGING}/team`]: { status: 307, headers: { location: '/team/' } },
      [`https://${STAGING}/team/`]: { body: html() },
      [`https://${STAGING}/promo/`]: { status: 302, headers: { location: '/offers/' } },
    },
  });
  const { result } = await runAll(w);
  const c = byId(result.checks)['old-addresses'];
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /^2 of the old site's 5 addresses do not work on staging/);
  assert.deepEqual(c.items, [
    '/about/: HTTP 404',
    '/promo/: HTTP 302 to /offers/. Make it a 301, or search engines do not move its ranking.',
  ]);
  assert.equal(readinessSummary(SITE, doneRow(result)).ready, false);
});

test('with no sitemap in robots.txt it tries where WordPress puts one, and says so when there is none', async () => {
  const w = world({
    pages: {
      'https://acme.com/robots.txt': text('User-agent: *\nDisallow:\n'),
      'https://acme.com/sitemap_index.xml': { status: 404 },
      'https://acme.com/wp-sitemap.xml': xml('urlset', ['https://acme.com/services/']),
    },
  });
  const { result } = await runAll(w);
  assert.match(byId(result.checks)['old-addresses'].detail, /All 1 address in the old site's sitemap work on staging/);
  // wp-sitemap.xml answered, so sitemap.xml was never asked for.
  assert.ok(!w.sites.calls.some((c) => c.url === 'https://acme.com/sitemap.xml'));

  const none = world({ pages: { 'https://acme.com/robots.txt': { status: 404 }, 'https://acme.com/sitemap_index.xml': { status: 404 } } });
  const c = byId((await runAll(none)).result.checks)['old-addresses'];
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /found no sitemap on acme\.com/);
});

test('a site that is not live yet has no old addresses to keep', async () => {
  const w = world();
  const { result } = await runAll(w, { site: { ...SITE, live_platform: 'none' } });
  assert.equal(byId(result.checks)['old-addresses'].status, 'pass');
  assert.ok(!w.sites.calls.some((c) => c.url.startsWith('https://acme.com/')), 'the old site was not read');
});

test('a tag the old site loads, missing on staging, fails; one the desk lists, too', async () => {
  const w = world({ pages: { [`https://${STAGING}/`]: { body: html({ body: '<div class="g-recaptcha"></div>' }) } } });
  const { result } = await runAll(w, { services: [{ kind: 'ga4', identifier: 'G-XY12345' }, { kind: 'resend' }] });
  const c = byId(result.checks).tags;
  assert.equal(c.status, 'fail');
  assert.deepEqual(c.items, ['GTM-AB12CD (the old site loads it)', 'G-XY12345 (the desk lists it)']);

  // Tag Manager often loads Analytics, so a G- id need not be on a page that has a container.
  assert.deepEqual(googleTags(GTM + '<div class="g-recaptcha" data-x="G-LOWER"></div>'), { gtm: ['GTM-AB12CD'], ga: [] });
  assert.deepEqual(googleTags('<script async src="https://www.googletagmanager.com/gtag/js?id=G-XY12345"></script>'), { gtm: [], ga: ['G-XY12345'] });
});

test('the contact form: missing where the old one had one, or posting to WordPress, fails', async () => {
  const noForm = world({
    pages: {
      'https://acme.com/contact-us/': { body: html({ body: '<form action="/wp-admin/admin-ajax.php"><input name="email"></form>' }) },
      [`https://${STAGING}/contact-us/`]: { body: html({ body: '<p>Call us.</p>' }) },
    },
  });
  const a = byId((await runAll(noForm)).result.checks).contact;
  assert.equal(a.status, 'fail');
  assert.match(a.detail, /old site's \/contact-us\/ has a form, and staging's has none/);

  const toWordPress = world({ pages: { [`https://${STAGING}/contact-us/`]: { body: html({ body: '<form action="https://acme.com/wp-json/contact-form-7/v1/contact-forms/5/feedback"></form>' }) } } });
  assert.match(byId((await runAll(toWordPress)).result.checks).contact.detail, /posts to WordPress/);

  // A form, but no Resend account on the desk to send it.
  assert.equal(byId((await runAll(world(), { services: [{ kind: 'gtm', identifier: 'GTM-AB12CD' }] })).result.checks).contact.status, 'warn');

  assert.deepEqual(formOn('<iframe src="https://form.jotform.com/123"></iframe>'), { found: true, wordpress: null });
  assert.deepEqual(formOn('<p>No form</p>'), { found: false, wordpress: null });
});

test('staging that names another host, loads old files or has no sitemap fails; noindex only warns', async () => {
  const w = world({
    pages: {
      [`https://${STAGING}/`]: {
        headers: { 'x-robots-tag': 'noindex' },
        body: html({ canonical: `https://${STAGING}/`, head: GTM + '<link rel="stylesheet" href="https://acme.com/wp-content/themes/acme/style.css">' }),
      },
      [`https://${STAGING}/sitemap-index.xml`]: { status: 404 },
    },
  });
  const c = byId((await runAll(w)).result.checks);
  assert.equal(c.canonical.status, 'fail');
  assert.equal(c['old-files'].status, 'fail');
  assert.equal(c.sitemap.status, 'fail');
  assert.equal(c.noindex.status, 'warn');
});

test('staging that does not answer, or a missing address, ends the check at once', async () => {
  const down = world({ pages: { [`https://${STAGING}/`]: { status: 403, body: 'Forbidden' } } });
  const r = await startRun({ site: SITE, services: [], fetch: down.fetch });
  assert.equal(r.state, 'done');
  assert.equal(byId(r.checks).staging.status, 'fail');

  const r2 = await startRun({ site: { ...SITE, staging_domain: null }, fetch: down.fetch });
  assert.deepEqual(r2.checks.map((c) => [c.id, c.status]), [['addresses', 'fail']]);
});

test('DNS that is not on Cloudflare fails; a subdomain is looked up by its zone', async () => {
  const w = world({ dns: { 'acme.com': { NS: ['ns1.godaddy.com'] } } });
  assert.equal(byId((await runAll(w)).result.checks).nameservers.status, 'fail');
  const sub = world({ dns: { 'acme.com': { NS: ['ada.ns.cloudflare.com'] }, 'shop.acme.com': { A: '192.0.2.1' } } });
  const r = await startRun({ site: { ...SITE, live_domain: 'shop.acme.com', live_platform: 'none' }, fetch: sub.fetch });
  assert.match(byId(r.checks).nameservers.detail, /^acme\.com uses Cloudflare's nameservers/);
});

test('a big old site is checked in steps that each stay inside the Free plan\'s calls', async () => {
  const many = Array.from({ length: 150 }, (_, i) => `https://acme.com/p/${i}/`);
  const w = world({
    pages: {
      'https://acme.com/page-sitemap.xml': xml('urlset', many),
      'https://acme.com/post-sitemap.xml': xml('urlset', []),
      [`https://${STAGING}/*`]: (url) => (url.pathname.startsWith('/p/') ? { body: html() } : { status: 404 }),
    },
  });
  const { result, steps, most } = await runAll(w);
  assert.equal(byId(result.checks)['old-addresses'].status, 'pass');
  assert.ok(steps >= 8, `${steps} steps`);
  assert.ok(most <= LIMIT, `a step made ${most} calls`);
  assert.deepEqual(result.counts, { sitemaps_left: 0, pages_found: 150, pages_checked: 150 });
});

test('the summary: a week old, other addresses, or a stalled run is not ready', async () => {
  const { result } = await runAll(world());
  const now = Date.now();
  assert.equal(readinessSummary(SITE, doneRow(result, { finished: now - FRESH_FOR - 1000 }), now).stale, 'old');
  assert.equal(readinessSummary({ ...SITE, staging_domain: 'new.10xid.com' }, doneRow(result), now).stale, 'addresses');
  const running = { ...doneRow(result), state: 'running', finished_at: null, updated_at: new Date(now - STALLED - 1000).toISOString() };
  assert.equal(readinessSummary(SITE, running, now).state, 'stalled');
  assert.deepEqual(readinessSummary(SITE, null), { state: 'none', ready: false, stale: null, checks: [] });
});

test('the approval is a site field: a day that exists, saved and in the history', async () => {
  assert.deepEqual(cleanSite({ approved_by: '  Paolo   F ', approved_on: '2026-10-21' }), { approved_by: 'Paolo F', approved_on: '2026-10-21' });
  assert.throws(() => cleanSite({ approved_on: '2026-02-30' }), /Approved on should be a date/);
  const { db, connect } = await freshDatabase();
  const store = new Store(connect);
  const site = await store.create({ name: 'Acme' });
  const { site: changed } = await store.update(site.id, { approved_by: 'Paolo', approved_on: '2026-10-21' });
  assert.equal(changed.approved_on, '2026-10-21');
  const rows = (await db.query("SELECT field, new_value FROM history WHERE action = 'changed' ORDER BY id")).rows;
  assert.deepEqual(rows, [{ field: 'approved_by', new_value: 'Paolo' }, { field: 'approved_on', new_value: '2026-10-21' }]);
});

test('the endpoints run a check to its end, save it, and the list carries it', async () => {
  const { connect } = await freshDatabase();
  const store = new Store(connect);
  const site = await store.create({
    name: 'Acme', live_domain: 'acme.com', staging_domain: STAGING, live_platform: 'wordpress', approved_by: 'Paolo', approved_on: '2026-10-21',
  });
  for (const s of SERVICES) await store.createItem('services', site.id, s);
  const w = world();
  const call = async (method, action = '', body) => {
    const request = new Request('https://website.10xid.com/api/sites/' + site.id + '/readiness' + (action ? '/' + action : ''), {
      method, ...(body && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
    const res = await handleReadiness(request, { store, siteId: site.id, action, fetchImpl: w.fetch });
    return { status: res.status, body: await res.json() };
  };

  assert.equal((await call('GET')).body.readiness.state, 'none');
  let r = await call('POST');
  assert.equal(r.status, 200);
  const run = r.body.readiness.run;
  assert.equal(r.body.readiness.state, 'running');
  while (r.body.readiness.state === 'running') r = await call('POST', 'next', { run });
  assert.equal(r.body.readiness.state, 'done');
  assert.equal(r.body.readiness.ready, true, JSON.stringify(r.body.readiness.checks.filter((c) => c.status !== 'pass')));
  const [listed] = await store.list();
  assert.equal(listed.readiness.ready, true);
  // A step sent again after the end changes nothing.
  assert.equal((await call('POST', 'next', { run })).body.readiness.state, 'done');

  // Recording no approval takes the site out of Ready at once.
  const { site: unapproved } = await store.update(site.id, { approved_on: null });
  assert.equal(unapproved.readiness.ready, false);

  // A new check replaces the old one, and the old run's steps are refused.
  const fresh = await call('POST');
  const stale = await call('POST', 'next', { run });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'run-replaced');
  assert.notEqual(fresh.body.readiness.run, run);
  assert.equal((await call('POST', 'next', {})).status, 400);
  assert.equal((await call('POST', 'again')).status, 404);
});

test('two tabs driving one run save each step once', async () => {
  const { connect } = await freshDatabase();
  const store = new Store(connect);
  const site = await store.create({ name: 'Acme', live_domain: 'acme.com', staging_domain: STAGING });
  await store.readinessStart(site.id, {
    run: 'r1', state: 'running', checks: [], progress: { x: 1 }, counts: { pages_checked: 0 }, live_host: 'acme.com', staging_host: STAGING,
  });
  const step = { run: 'r1', step: 0, state: 'running', checks: [], progress: { x: 2 }, counts: { pages_checked: 20 } };
  await store.readinessStep(site.id, step);
  await store.readinessStep(site.id, { ...step, progress: { x: 3 }, counts: { pages_checked: 99 } });
  const row = await store.readinessRun(site.id);
  assert.equal(row.step, 1);
  assert.deepEqual(row.progress, { x: 2 });
  assert.deepEqual((await store.readinessStep(site.id, { ...step, run: 'other' })).replaced, true);
  // The check goes with its site.
  await store.remove(site.id);
  assert.equal(await store.readinessRun(site.id), null);
});
