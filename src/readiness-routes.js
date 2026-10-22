// The readiness endpoints, under a site (readiness.js says what they check):
//   GET  /api/sites/:id/readiness        the last check, as the list has it
//   POST /api/sites/:id/readiness        start a new check: its first step
//   POST /api/sites/:id/readiness/next   { run }: the next step of that check
// worker.js has checked the desk key (and x-desk on a change) by the time a
// request gets here. A check only reads the sites from the outside, so it
// needs no Access login, unlike going live.
//
// Every call a step makes goes through one counted fetch (budget.js), and a
// step stops while it still has calls left, so no step is ever the one that
// goes over the Free plan's 50.
//
// Kept apart from worker.js so it can be tested under plain Node.

import { json } from './answers.js';
import { budget, countedFetch } from './budget.js';
import { startRun, continueRun } from './readiness.js';

const notFound = () => json({ error: 'No site with that id.' }, 404);

// An empty body is {}; anything else that is not a JSON object is refused.
async function readBody(request) {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

export async function handleReadiness(request, { store, siteId, action = '', fetchImpl = fetch }) {
  if (action && action !== 'next') return json({ error: 'Not found.' }, 404);
  const m = request.method;
  if (!action && m === 'GET') {
    const site = await store.read(siteId);
    return site ? json({ readiness: site.readiness }) : notFound();
  }
  if (m !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const allowance = budget();
  const counted = countedFetch(fetchImpl, allowance);
  return action ? next(request, store, siteId, counted, allowance) : start(store, siteId, counted);
}

async function start(store, siteId, counted) {
  const site = await store.read(siteId);
  if (!site) return notFound();
  const services = await store.servicesOf(siteId);
  const first = await startRun({ site, services, fetch: counted });
  const saved = await store.readinessStart(siteId, {
    ...first, run: crypto.randomUUID(), live_host: site.live_domain ?? null, staging_host: site.staging_domain ?? null,
  });
  if (saved.missing) return notFound();
  return json({ site: saved.site, readiness: saved.site.readiness });
}

async function next(request, store, siteId, counted, allowance) {
  const body = await readBody(request);
  if (!body || typeof body.run !== 'string' || !body.run || body.run.length > 64) {
    return json({ error: 'Name the check to carry on: { run }.', field: 'run' }, 400);
  }
  const row = await store.readinessRun(siteId);
  if (!row || row.run !== body.run) {
    const site = await store.read(siteId);
    if (!site) return notFound();
    return json({ error: 'Someone started a new check on this site, so this one stopped.', code: 'run-replaced', site, readiness: site.readiness }, 409);
  }
  // A finished check has nothing left to do: it answers as it stands, so a
  // step sent twice does no harm.
  if (row.state === 'done' || !row.progress) {
    const site = await store.read(siteId);
    return site ? json({ site, readiness: site.readiness }) : notFound();
  }
  const out = await continueRun({ checks: row.checks, progress: row.progress, fetch: counted, allowance });
  const saved = await store.readinessStep(siteId, { ...out, run: row.run, step: row.step });
  if (saved.missing) return notFound();
  if (saved.replaced) {
    return json({ error: 'Someone started a new check on this site, so this one stopped.', code: 'run-replaced', site: saved.site, readiness: saved.site.readiness }, 409);
  }
  return json({ site: saved.site, readiness: saved.site.readiness });
}
