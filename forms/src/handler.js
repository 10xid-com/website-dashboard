// The forms Worker: the enquiry forms on the client sites post here.
//
//   GET  /embed.js?site=KEY   the script the site loads (client.js, with the
//                             site's settings in it)
//   POST /submit/KEY          one form, sent by that script
//
// A submission is accepted only from the site's own hostnames (sites.js),
// with a Turnstile token issued on that same hostname. It is saved to D1
// first, then emailed through Resend, so an enquiry survives a Resend outage:
// the email is the notification, the row is the record.
//
// The email comes From the shared sending domain, never the client's own, so
// nothing here can touch the client's mail reputation. Reply-To is the
// visitor, so the client's reply goes to the person who asked.
//
// Kept apart from worker.js, which only wires in client.js as text, so the
// handler can be tested under plain Node with client.js read from disk.

import { SITES, secretName } from './sites.js';

export const DEFAULT_FROM_ADDRESS = 'noreply@brandingcentres.com';
const RESEND = 'https://api.resend.com/emails';
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_BODY = 64 * 1024;
const MAX_FIELDS = 80;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const SENT = 'Thank you. Your message has been sent.';
const FAILED = 'Sorry, that could not be sent. Please try again, or call or email us directly.';

// The answer to the browser. Only a site's own origin is ever echoed back.
function reply(body, status = 200, origin = null) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (origin) Object.assign(headers, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
  return new Response(JSON.stringify(body), { status, headers });
}

// Which of the site's hostnames the request came from, and whether it is the
// live site or staging. → { host, live } or null
export function originOf(site, origin) {
  if (!site || !origin) return null;
  let url;
  try { url = new URL(origin); } catch { return null; }
  if (url.protocol !== 'https:' || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (site.live.includes(host)) return { host, live: true };
  if (site.staging.includes(host)) return { host, live: false };
  return null;
}

// The submission as the script sends it, cleaned. → { form, page, fields, token, hp } or null
export function readSubmission(text) {
  let body;
  try { body = JSON.parse(text); } catch { return null; }
  if (!body || typeof body !== 'object' || !Array.isArray(body.fields)) return null;
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const fields = body.fields.slice(0, MAX_FIELDS)
    .map((f) => ({ label: str(f && f.label, 200) || 'Field', value: str(f && f.value, 5000), type: str(f && f.type, 20) }))
    .filter((f) => f.value);
  return {
    form: str(body.form, 120) || 'Form',
    page: str(body.page, 500),
    fields,
    token: str(body.token, 4096),
    hp: str(body.hp, 200),
  };
}

// The visitor's address, if they gave one: the first email field, else the
// first answer under a label that says email.
export function visitorEmail(fields) {
  const byType = fields.find((f) => f.type === 'email' && EMAIL.test(f.value));
  if (byType) return byType.value;
  const byLabel = fields.find((f) => /e-?mail/i.test(f.label) && EMAIL.test(f.value));
  return byLabel ? byLabel.value : null;
}

const visitorName = (fields) => {
  const f = fields.find((x) => /name/i.test(x.label) && !/last|surname|company|business/i.test(x.label));
  return f ? f.value.slice(0, 80) : null;
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The email for one submission. → { from, to, reply_to?, subject, text, html }
export function buildEmail(site, sub, { live, to, fromAddress = DEFAULT_FROM_ADDRESS }) {
  const who = visitorName(sub.fields);
  const email = visitorEmail(sub.fields);
  const subject = `${live ? '' : '[Staging] '}${site.name} website: ${sub.form}${who ? ` from ${who}` : ''}`;
  const intro = live
    ? `Someone filled in the "${sub.form}" form on the ${site.name} website.`
    : `A test of the "${sub.form}" form on the ${site.name} STAGING site. On the live site this goes to ${site.to.join(', ')}.`;
  const footer = [
    sub.page && `Page: ${sub.page}`,
    email ? 'Reply to this email to answer them.' : 'They did not leave an email address.',
  ].filter(Boolean);
  const text = [intro, '', ...sub.fields.map((f) => `${f.label}:\n${f.value}\n`), ...footer].join('\n');
  const html = [
    `<p>${esc(intro)}</p>`,
    '<table cellpadding="6" style="border-collapse:collapse;font:14px/1.45 Arial,sans-serif">',
    ...sub.fields.map((f) => `<tr><th align="left" valign="top" style="border-bottom:1px solid #ddd;padding-right:16px">${esc(f.label)}</th>` +
      `<td valign="top" style="border-bottom:1px solid #ddd">${esc(f.value).replace(/\n/g, '<br>')}</td></tr>`),
    '</table>',
    ...footer.map((line) => `<p style="color:#555;font:13px Arial,sans-serif">${esc(line)}</p>`),
  ].join('\n');
  const out = { from: `${site.name} website <${fromAddress}>`, to, subject: subject.slice(0, 250), text, html };
  if (email) out.reply_to = email;
  return out;
}

async function verifyTurnstile(secret, token, ip, host, fetchImpl) {
  if (!token) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  try {
    const res = await fetchImpl(SITEVERIFY, { method: 'POST', body: form });
    const out = await res.json();
    return out.success === true && String(out.hostname || '').toLowerCase() === host;
  } catch {
    return false;
  }
}

async function record(db, row) {
  if (!db) return null;
  try {
    const res = await db.prepare(
      `INSERT INTO submissions (site, form, page, origin, live, email, fields, country, user_agent, delivery, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).bind(row.site, row.form, row.page, row.origin, row.live ? 1 : 0, row.email, JSON.stringify(row.fields),
      row.country, row.userAgent, new Date().toISOString()).run();
    return res.meta?.last_row_id ?? null;
  } catch (err) {
    console.error('forms: could not save submission', err);
    return null;
  }
}

async function delivered(db, id, delivery, { resendId = null, error = null } = {}) {
  if (!db || id == null) return;
  try {
    await db.prepare('UPDATE submissions SET delivery = ?, resend_id = ?, error = ? WHERE id = ?')
      .bind(delivery, resendId, error && error.slice(0, 500), id).run();
  } catch (err) {
    console.error('forms: could not record delivery', err);
  }
}

async function submit(request, env, key, { fetchImpl }) {
  const site = SITES[key];
  const from = originOf(site, request.headers.get('Origin'));
  if (!from) return reply({ ok: false, message: 'Not allowed.' }, 403);
  const origin = `https://${from.host}`;
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin',
    } });
  }
  if (request.method !== 'POST') return reply({ ok: false, message: 'Method not allowed.' }, 405, origin);

  const ip = request.headers.get('CF-Connecting-IP');
  if (env.LIMITER) {
    const { success } = await env.LIMITER.limit({ key: `${key}:${ip || 'unknown'}` });
    if (!success) return reply({ ok: false, message: 'Too many messages at once. Please wait a minute and try again.' }, 429, origin);
  }

  const text = await request.text();
  if (text.length > MAX_BODY) return reply({ ok: false, message: 'That message is too long.' }, 413, origin);
  const sub = readSubmission(text);
  if (!sub) return reply({ ok: false, message: 'That form could not be read.' }, 400, origin);
  // The honeypot: people never see it, so only a bot fills it in. Answer as
  // if it worked, so the bot learns nothing.
  if (sub.hp) return reply({ ok: true, message: SENT }, 200, origin);
  if (!sub.fields.length) return reply({ ok: false, message: 'Please fill in the form first.' }, 400, origin);

  const secret = env[secretName(key)];
  if (!secret || !env.RESEND_API_KEY) {
    console.error(`forms: ${key} is not set up (${!secret ? secretName(key) : 'RESEND_API_KEY'} missing)`);
    return reply({ ok: false, message: FAILED }, 503, origin);
  }
  if (!(await verifyTurnstile(secret, sub.token, ip, from.host, fetchImpl))) {
    return reply({ ok: false, message: 'The security check did not pass. Please try again.' }, 400, origin);
  }

  const to = from.live ? site.to : String(env.STAGING_TO || '').split(/[\s,]+/).filter(Boolean);
  if (!to.length) {
    console.error('forms: STAGING_TO is not set');
    return reply({ ok: false, message: FAILED }, 503, origin);
  }
  const email = buildEmail(site, sub, { live: from.live, to, fromAddress: env.FROM_ADDRESS || DEFAULT_FROM_ADDRESS });
  const id = await record(env.DB, {
    site: key, form: sub.form, page: sub.page, origin, live: from.live, email: email.reply_to || null,
    fields: sub.fields, country: request.headers.get('CF-IPCountry'), userAgent: (request.headers.get('User-Agent') || '').slice(0, 300),
  });

  let res;
  try {
    res = await fetchImpl(RESEND, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(email),
    });
  } catch (err) {
    await delivered(env.DB, id, 'failed', { error: String(err) });
    return reply({ ok: false, message: FAILED }, 502, origin);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`forms: Resend answered ${res.status} for ${key}: ${detail.slice(0, 300)}`);
    await delivered(env.DB, id, 'failed', { error: `resend ${res.status}: ${detail}` });
    return reply({ ok: false, message: FAILED }, 502, origin);
  }
  const resendId = await res.json().then((b) => b && b.id).catch(() => null);
  await delivered(env.DB, id, 'sent', { resendId });
  return reply({ ok: true, message: SENT }, 200, origin);
}

// The script for one site, or null for a site that is not here.
export function embed(clientSource, key, endpointBase) {
  const site = SITES[key];
  if (!site) return null;
  const cfg = { site: key, sitekey: site.sitekey, endpoint: `${endpointBase}/submit/${key}`, thanks: site.thanks || null };
  // The call at the end of client.js, not the mention in its opening comment.
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  return clientSource.replace('})(__TENX_CONFIG__);', () => `})(${json});`);
}

export function createHandler(clientSource, { fetchImpl = (...a) => fetch(...a) } = {}) {
  return async function handle(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/embed.js' && request.method === 'GET') {
      const js = embed(clientSource, url.searchParams.get('site') || '', url.origin);
      if (!js) return new Response('// Unknown site.\n', { status: 404, headers: { 'Content-Type': 'text/javascript' } });
      return new Response(js, { headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        // Short, so a fix reaches every site within minutes.
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      } });
    }
    const m = url.pathname.match(/^\/submit\/([a-z0-9-]+)\/?$/);
    if (m) return submit(request, env, m[1], { fetchImpl });
    if (url.pathname === '/') return new Response('10XiD client forms.\n', { headers: { 'Content-Type': 'text/plain' } });
    return new Response('Not found.\n', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  };
}
