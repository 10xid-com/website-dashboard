import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHandler, originOf, readSubmission, visitorEmail, buildEmail, embed } from '../forms/src/handler.js';
import { SITES, secretName } from '../forms/src/sites.js';

const CLIENT = readFileSync(new URL('../forms/src/client.js', import.meta.url), 'utf8');
const SITE = SITES.aerospot;
const LIVE = 'https://www.aerospot.ca';
const STAGING = `https://${SITE.staging[0]}`;

const FIELDS = [
  { label: 'First Name', value: 'Mira', type: 'text' },
  { label: 'Email', value: 'mira@example.com', type: 'email' },
  { label: 'Message', value: 'Two cars on <Friday>', type: 'textarea' },
];

// A fake Turnstile and Resend: what was sent to each, and what they answer.
function fakeFetch({ turnstile = { success: true }, resend = { status: 200, body: { id: 'em_1' } } } = {}) {
  const calls = { siteverify: [], resend: [] };
  const fetchImpl = async (url, init) => {
    if (url.includes('siteverify')) {
      calls.siteverify.push(Object.fromEntries(init.body.entries()));
      return new Response(JSON.stringify(turnstile));
    }
    calls.resend.push({ headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(resend.body), { status: resend.status });
  };
  return { fetchImpl, calls };
}

// A fake D1 that keeps the statements it ran.
function fakeDb() {
  const runs = [];
  return {
    runs,
    prepare(sql) {
      return { bind: (...args) => ({ run: async () => { runs.push({ sql, args }); return { meta: { last_row_id: 7 } }; } }) };
    },
  };
}

const ENV = (over = {}) => ({
  RESEND_API_KEY: 're_test', [secretName('aerospot')]: 'ts_secret', STAGING_TO: 'team@example.com',
  FROM_ADDRESS: 'noreply@brandingcentres.com', DB: fakeDb(), ...over,
});

const post = (origin, body, headers = {}) => new Request('https://forms.10xid.com/submit/aerospot', {
  method: 'POST', headers: { Origin: origin, 'CF-Connecting-IP': '203.0.113.9', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const turnstileHost = (origin) => new URL(origin).hostname;

test('every site has a sitekey, a client address, and hostnames in lower case', () => {
  for (const [key, site] of Object.entries(SITES)) {
    assert.match(site.sitekey, /^0x4A/, key);
    assert.ok(site.to.length && site.to.every((t) => /^[^@\s]+@[^@\s]+$/.test(t)), key);
    for (const h of [...site.live, ...site.staging]) assert.equal(h, h.toLowerCase(), `${key} ${h}`);
    assert.match(secretName(key), /^TURNSTILE_SECRET_[A-Z0-9_]+$/);
  }
});

test('only the site’s own https hostnames are accepted, and they say live or staging', () => {
  assert.deepEqual(originOf(SITE, LIVE), { host: 'www.aerospot.ca', live: true });
  assert.deepEqual(originOf(SITE, STAGING), { host: SITE.staging[0], live: false });
  for (const bad of ['http://aerospot.ca', 'https://aerospot.ca:8443', 'https://evil.example', 'https://aerospot.ca.evil.example', null, 'nonsense']) {
    assert.equal(originOf(SITE, bad), null, String(bad));
  }
  // Another client's hostname is not this site's.
  assert.equal(originOf(SITE, 'https://designtosuit.ca'), null);
});

test('a submission is cleaned: empty answers dropped, long ones cut, junk refused', () => {
  const sub = readSubmission(JSON.stringify({ form: 'Contact', page: 'https://aerospot.ca/', token: 't',
    fields: [{ label: 'Name', value: '  Mira ' }, { label: 'Empty', value: '' }, { label: '', value: 'x'.repeat(6000) }] }));
  assert.deepEqual(sub.fields.map((f) => [f.label, f.value.length]), [['Name', 4], ['Field', 5000]]);
  assert.equal(readSubmission('not json'), null);
  assert.equal(readSubmission(JSON.stringify({ fields: 'no' })), null);
});

test('the visitor’s email comes from the email field, else a label that says email', () => {
  assert.equal(visitorEmail(FIELDS), 'mira@example.com');
  assert.equal(visitorEmail([{ label: 'Your e-mail', value: 'a@b.co', type: 'text' }]), 'a@b.co');
  assert.equal(visitorEmail([{ label: 'Email', value: 'not an address', type: 'email' }]), null);
});

test('the email comes from the shared domain, replies go to the visitor, and the answers are escaped', () => {
  const mail = buildEmail(SITE, { form: 'Booking', page: 'https://aerospot.ca/booking/', fields: FIELDS },
    { live: true, to: SITE.to });
  assert.equal(mail.from, 'Aerospot Airport Parking website <noreply@brandingcentres.com>');
  assert.deepEqual(mail.to, ['info@aerospot.ca']);
  assert.equal(mail.reply_to, 'mira@example.com');
  assert.equal(mail.subject, 'Aerospot Airport Parking website: Booking from Mira');
  assert.ok(mail.text.includes('Message:\nTwo cars on <Friday>'));
  assert.ok(mail.html.includes('Two cars on &lt;Friday&gt;'));
  assert.ok(!mail.html.includes('<Friday>'));
});

test('a staging email says so, and says where the live one would go', () => {
  const mail = buildEmail(SITE, { form: 'Booking', page: '', fields: FIELDS }, { live: false, to: ['team@example.com'] });
  assert.match(mail.subject, /^\[Staging\] /);
  assert.ok(mail.text.includes('On the live site this goes to info@aerospot.ca'));
});

test('a live submission is checked with Turnstile, saved, and sent to the client', async () => {
  const { fetchImpl, calls } = fakeFetch({ turnstile: { success: true, hostname: turnstileHost(LIVE) } });
  const env = ENV();
  const res = await createHandler(CLIENT, { fetchImpl })(post(LIVE, { form: 'Contact', fields: FIELDS, token: 'tok' }), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), LIVE);
  assert.deepEqual(await res.json(), { ok: true, message: 'Thank you. Your message has been sent.' });
  assert.deepEqual(calls.siteverify, [{ secret: 'ts_secret', response: 'tok', remoteip: '203.0.113.9' }]);
  assert.equal(calls.resend.length, 1);
  assert.deepEqual(calls.resend[0].body.to, ['info@aerospot.ca']);
  assert.equal(calls.resend[0].headers.Authorization, 'Bearer re_test');
  assert.match(env.DB.runs[0].sql, /INSERT INTO submissions/);
  assert.deepEqual(env.DB.runs[1].args, ['sent', 'em_1', null, 7]);
});

test('a staging submission goes to STAGING_TO, never the client', async () => {
  const { fetchImpl, calls } = fakeFetch({ turnstile: { success: true, hostname: turnstileHost(STAGING) } });
  const res = await createHandler(CLIENT, { fetchImpl })(post(STAGING, { form: 'Contact', fields: FIELDS, token: 'tok' }), ENV());
  assert.equal(res.status, 200);
  assert.deepEqual(calls.resend[0].body.to, ['team@example.com']);
});

test('a token from another hostname, or no token, is refused and nothing is sent', async () => {
  for (const turnstile of [{ success: true, hostname: 'evil.example' }, { success: false }]) {
    const { fetchImpl, calls } = fakeFetch({ turnstile });
    const res = await createHandler(CLIENT, { fetchImpl })(post(LIVE, { form: 'C', fields: FIELDS, token: 'tok' }), ENV());
    assert.equal(res.status, 400);
    assert.equal(calls.resend.length, 0);
  }
  const { fetchImpl, calls } = fakeFetch();
  const res = await createHandler(CLIENT, { fetchImpl })(post(LIVE, { form: 'C', fields: FIELDS, token: '' }), ENV());
  assert.equal(res.status, 400);
  assert.equal(calls.siteverify.length, 0);
});

test('another origin is refused without a CORS header', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const res = await createHandler(CLIENT, { fetchImpl })(post('https://evil.example', { fields: FIELDS, token: 't' }), ENV());
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(calls.siteverify.length + calls.resend.length, 0);
});

test('the honeypot answers as if sent, and sends nothing', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const res = await createHandler(CLIENT, { fetchImpl })(post(LIVE, { fields: FIELDS, token: 't', hp: 'bot' }), ENV());
  assert.equal(res.status, 200);
  assert.equal(calls.siteverify.length + calls.resend.length, 0);
});

test('the rate limit refuses before anything is checked or sent', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const env = ENV({ LIMITER: { limit: async ({ key }) => ({ success: key !== 'aerospot:203.0.113.9' }) } });
  const res = await createHandler(CLIENT, { fetchImpl })(post(LIVE, { fields: FIELDS, token: 't' }), env);
  assert.equal(res.status, 429);
  assert.equal(calls.siteverify.length + calls.resend.length, 0);
});

test('a site with no Turnstile secret or no Resend key says it could not send, and sends nothing', async () => {
  for (const env of [ENV({ [secretName('aerospot')]: undefined }), ENV({ RESEND_API_KEY: undefined })]) {
    const { fetchImpl, calls } = fakeFetch();
    const res = await createHandler(CLIENT, { fetchImpl })(post(LIVE, { fields: FIELDS, token: 't' }), env);
    assert.equal(res.status, 503);
    assert.equal(calls.resend.length, 0);
  }
});

test('Resend failing is recorded and the visitor is told', async () => {
  const { fetchImpl } = fakeFetch({ turnstile: { success: true, hostname: 'www.aerospot.ca' }, resend: { status: 422, body: { message: 'bad' } } });
  const env = ENV();
  const res = await createHandler(CLIENT, { fetchImpl })(post(LIVE, { form: 'C', fields: FIELDS, token: 't' }), env);
  assert.equal(res.status, 502);
  assert.equal(env.DB.runs[1].args[0], 'failed');
  assert.match(env.DB.runs[1].args[2], /^resend 422/);
});

test('the preflight answers only the site’s own origin', async () => {
  const handle = createHandler(CLIENT, fakeFetch());
  const ok = await handle(new Request('https://forms.10xid.com/submit/aerospot', { method: 'OPTIONS', headers: { Origin: LIVE } }), ENV());
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), LIVE);
  const no = await handle(new Request('https://forms.10xid.com/submit/aerospot', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), ENV());
  assert.equal(no.status, 403);
});

test('embed.js is the client script with the site’s settings, and parses', async () => {
  const handle = createHandler(CLIENT, fakeFetch());
  const res = await handle(new Request('https://forms.10xid.com/embed.js?site=aerospot'), ENV());
  assert.equal(res.status, 200);
  const js = await res.text();
  assert.ok(!js.includes('})(__TENX_CONFIG__);'));
  assert.ok(js.includes('"endpoint":"https://forms.10xid.com/submit/aerospot"'));
  assert.ok(js.includes(`"sitekey":"${SITE.sitekey}"`));
  assert.doesNotThrow(() => new Function(js));
  assert.equal((await handle(new Request('https://forms.10xid.com/embed.js?site=nope'), ENV())).status, 404);
  assert.equal(embed(CLIENT, 'nope', 'https://x'), null);
});
