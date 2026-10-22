// Ready to go live: whether a staged site is ready for its domain to be
// pointed at it. Go live's own check (golive.js) reads Cloudflare and needs
// the person's Access login; this one only looks at the sites from the
// outside, the way a visitor or a search engine would, so anyone with the
// desk key can run it at any time and it changes nothing.
//
// It answers what Go live's check does not: is every page of the old site on
// the new one, does the contact form still have somewhere to post, does the
// new site load the Google tags the old one did, and has someone recorded
// that gate 12 is approved. A site is Ready when the last check passed, it is
// less than a week old, it was for the addresses the site has now, and the
// approval is recorded (readinessSummary, below).
//
// Workers Free allows 50 calls a request, and an old site can have hundreds
// of pages. So a check is a run in steps: startRun() reads the two home
// pages, the robots.txt files and public DNS, and lists the old site's
// sitemaps; then each continueRun() reads a few sitemaps or checks the next
// batch of old addresses on staging, until nothing is left. The page drives
// the steps, one request each, and the database keeps the run between them.
//
// Every text a check carries is plain text, some of it quoted from the sites
// (a path, a form's action), so the page escapes all of it.
//
// Kept apart from worker.js so it can be tested under plain Node.

import {
  addressesCheck, getPage, hasPage, answerText, anyBody, noBody,
  robotsNoindex, canonicalHost, resourceUrls, oldFiles, robotsBlocksAll, doh, DESK_HOST,
} from './golive.js';

// A check counts for this long. A site edited since may have broken, and the
// gate's own rule is that a site clean at review and edited since is not
// still clean; a week is as long as the desk trusts it.
export const FRESH_FOR = 7 * 24 * 60 * 60 * 1000;

// A run with no step for this long has stopped: the tab that drove it closed.
export const STALLED = 2 * 60 * 1000;

// How much of an old site one check reads: sitemaps, and addresses in them.
// A site with more is checked as far as this, and the check says so.
const MAX_SITEMAPS = 40;
const MAX_PATHS = 2000;

// What one step does at most. A sitemap can be big (up to the 1 MB a page is
// read to), and the Free plan allows 10 ms of CPU a request, so a step reads
// a few. An address costs one call, two when it redirects.
const SITEMAPS_PER_STEP = 3;
const PAGES_PER_STEP = 20;

// The most lines a check lists. The count says how many there are in all.
const MAX_ITEMS = 20;

// Where WordPress and its SEO plugins put the sitemap (Yoast and Rank Math,
// then WordPress itself), tried in turn when robots.txt names none. Astro's
// is sitemap-index.xml.
const OLD_SITEMAPS = ['/sitemap_index.xml', '/wp-sitemap.xml', '/sitemap.xml'];
const STAGING_SITEMAPS = ['/sitemap-index.xml', '/sitemap.xml'];

// The order the page lists the checks in, whichever step made them.
const ORDER = ['addresses', 'staging', 'canonical', 'old-files', 'old-addresses', 'contact', 'tags',
  'sitemap', 'nameservers', 'noindex', 'robots', 'approval'];

// --- Small helpers ---

const bare = (name) => String(name ?? '').trim().toLowerCase().replace(/\.$/, '');
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const unique = (list) => [...new Set(list)];

// "a", "a and b", "a, b and c".
function listed(names, word = 'and') {
  return names.length > 1 ? names.slice(0, -1).join(', ') + ' ' + word + ' ' + names.at(-1) : names[0] || '';
}

function check(id, label, status, detail, items) {
  return items?.length ? { id, label, status, detail, items } : { id, label, status, detail };
}

const sorted = (checks) => [...checks].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));

export const isReady = (checks) => checks.length > 0 && !checks.some((c) => c.status === 'fail');

// The other half of an apex/www pair: acme.com and www.acme.com.
const pairOf = (host) => (host.startsWith('www.') ? host.slice(4) : 'www.' + host);

// At most MAX_ITEMS lines, and a last one that says how many more there are.
function capped(lines) {
  if (lines.length <= MAX_ITEMS) return lines;
  return [...lines.slice(0, MAX_ITEMS), `…and ${lines.length - MAX_ITEMS} more`];
}

// A page whose answer is a redirect to another page on `hosts`, followed
// once. Old sites often send acme.com to www.acme.com, or http to https.
async function getFollowed(fetchImpl, url, hosts, wanted) {
  const first = await getPage(fetchImpl, url, wanted);
  if (first.error || first.status < 300 || first.status > 399 || !first.location) return first;
  let next;
  try { next = new URL(first.location, url); } catch { return first; }
  if (next.protocol !== 'https:' || !hosts.includes(next.hostname)) return first;
  return getPage(fetchImpl, next.href, wanted);
}

const isSitemap = (p) => hasPageOrText(p) && /<(urlset|sitemapindex)[\s>]/i.test(p.body);
const hasPageOrText = (p) => !p.error && p.status === 200 && typeof p.body === 'string';

// The addresses a sitemap lists, decoded: <loc>…</loc>, CDATA or not. An
// index lists sitemaps; any other lists pages.
function sitemapLocs(xml) {
  const index = /<sitemapindex[\s>]/i.test(xml);
  const locs = [];
  for (const m of xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s][^<\]]*?)\s*(?:\]\]>)?\s*<\/loc>/gi)) {
    locs.push(m[1].replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  }
  return { index, locs };
}

// The robots.txt Sitemap: lines.
const robotsSitemaps = (text) => [...String(text || '').matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]);

const parse = (raw) => {
  try { return new URL(raw); } catch { return null; }
};

// The path a visitor asks for, query and all, without the fragment.
const pathOf = (u) => u.pathname + u.search;

// --- What a page carries ---

// Google tags: Tag Manager containers (GTM-…) and Analytics 4 streams
// (G-…), as a page names them, in a script, a quoted string or a URL. Only
// in capitals and with a digit, as Google writes them, so a class such as
// "g-recaptcha" is not taken for one.
export function googleTags(html) {
  const text = String(html || '');
  const ids = (re) => unique([...text.matchAll(re)].map((m) => m[1]));
  return {
    gtm: ids(/['"=]\s*(GTM-(?=[A-Z0-9]*[0-9])[A-Z0-9]{4,10})\b/g),
    ga: ids(/['"=]\s*(G-(?=[A-Z0-9]*[0-9])[A-Z0-9]{6,12})\b/g),
  };
}

// Embedded forms from the services clients use, for a page that has one
// inside an iframe instead of a form of its own.
const FORM_EMBEDS = /(jotform|typeform|hsforms|hubspot|docs\.google\.com\/forms|forms\.gle|formstack|cognitoforms|wufoo|tally\.so|calendly|cal\.com)/i;

// Whether a page has a form a visitor can send, and the first action that
// posts to WordPress, which goes away with the old site (gate 20).
// → { found, wordpress }.
export function formOn(html) {
  const text = String(html || '');
  let found = false;
  let wordpress = null;
  for (const m of text.matchAll(/<form\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    found = true;
    const action = /\baction\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1]);
    const to = action ? (action[1] ?? action[2] ?? action[3] ?? '') : '';
    if (!wordpress && /wp-json|admin-ajax|admin-post|wp-admin|wp-content/i.test(to)) wordpress = to;
  }
  if (!found) {
    for (const m of text.matchAll(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
      if (FORM_EMBEDS.test(m[1])) { found = true; break; }
    }
  }
  return { found, wordpress };
}

// --- The checks ---

// The live domain's nameservers, from public DNS: Go live needs the zone on
// Cloudflare (gate 6). A subdomain has none of its own, so the name is
// shortened one label at a time until one answers.
async function nameServersCheck(fetchImpl, live) {
  const label = 'DNS on Cloudflare';
  let name = bare(live);
  for (;;) {
    let answer;
    try {
      answer = await doh(fetchImpl, 'dns.google', name, 'NS');
    } catch (e) {
      return check('nameservers', label, 'warn', `Could not ask public DNS for ${name}'s nameservers (${e.message}).`);
    }
    const ns = unique(answer.filter((a) => a.type === 'NS' && bare(a.name) === name).map((a) => bare(a.data))).sort();
    if (ns.length) {
      if (ns.every((n) => n.endsWith('.ns.cloudflare.com'))) {
        return check('nameservers', label, 'pass', `${name} uses Cloudflare's nameservers (${ns.join(', ')}).`);
      }
      return check('nameservers', label, 'fail',
        `${name} uses other nameservers, not Cloudflare's, so the desk cannot point it at staging. Move its DNS to Cloudflare first (gate 6).`, ns);
    }
    if (name.split('.').length <= 2) {
      return check('nameservers', label, 'fail', `Public DNS has no nameservers for ${name}. Is the domain registered?`);
    }
    name = name.slice(name.indexOf('.') + 1);
  }
}

function canonicalCheck(page, main) {
  const label = 'Canonical address';
  const canonical = canonicalHost(page.body, page.url);
  if (!canonical) {
    return check('canonical', label, 'warn',
      `Staging's home page names no canonical address. Set site: 'https://${main}' in the Astro config so every page names one.`);
  }
  if (canonical !== main) {
    return check('canonical', label, 'fail',
      `Staging's pages name ${canonical} as their canonical address. Set site: 'https://${main}' in the Astro config, or search engines will index ${canonical} instead of ${main}.`);
  }
  return check('canonical', label, 'pass', `Staging's pages name ${main} as their canonical address.`);
}

function oldFilesCheck(page, hosts) {
  const olds = oldFiles(resourceUrls(page.body, page.url), hosts);
  return olds.length
    ? check('old-files', 'Files from the old site', 'fail',
      `Staging's home page loads ${plural(olds.length, 'file')} from the old site (WordPress paths, or ${listed(hosts, 'or')}), which break when the old site goes. Point them at the new site's own files.`,
      capped(olds))
    : check('old-files', 'Files from the old site', 'pass', 'Staging\'s home page loads nothing from the old site.');
}

// Noindex and a robots.txt that blocks every crawler are right on staging
// until just before it goes live: they keep the copy out of search. So they
// warn here, as the last thing to do. Go live itself refuses while either is
// there.
function noindexCheck(page, repo) {
  const found = robotsNoindex(page.headers, page.body);
  const where = repo ? ` in ${repo}` : '';
  return found
    ? check('noindex', 'Search engines', 'warn',
      `Staging still tells search engines not to index it. That is right until just before going live; then delete the X-Robots-Tag block in public/_headers${where}, push, and wait for the build. Go live refuses until it is gone.`,
      [found])
    : check('noindex', 'Search engines', 'pass', 'Staging lets search engines index it.');
}

function robotsCheck(p) {
  const label = 'robots.txt';
  if (!p.error && p.status === 404) return check('robots', label, 'pass', 'Staging has no robots.txt.');
  if (!hasPageOrText(p)) return check('robots', label, 'warn', `Could not read staging's robots.txt (${answerText(p)}).`);
  if (robotsBlocksAll(p.body)) {
    return check('robots', label, 'warn',
      'Staging\'s robots.txt blocks every crawler (Disallow: /). Take it out just before going live, or the live site keeps it. Go live refuses until it is gone.');
  }
  return check('robots', label, 'pass', 'Staging\'s robots.txt lets crawlers in.');
}

// Astro's sitemap names the live domain, from the same site: setting as the
// canonical links. One on any other host sends search engines there.
function sitemapCheck(found, hosts, main) {
  const label = 'Sitemap';
  if (!found) {
    return check('sitemap', label, 'fail',
      `Staging has no sitemap at ${listed(STAGING_SITEMAPS, 'or')}. Add @astrojs/sitemap (the SEO kit does), so search engines find every page of the new site.`);
  }
  const { locs } = sitemapLocs(found.page.body);
  const elsewhere = unique(locs.map(parse).filter(Boolean).map((u) => u.hostname.toLowerCase()).filter((h) => !hosts.includes(h)));
  if (elsewhere.length) {
    return check('sitemap', label, 'fail',
      `Staging's sitemap (${found.path}) lists addresses on ${listed(elsewhere)}, not ${main}. Set site: 'https://${main}' in the Astro config.`);
  }
  return check('sitemap', label, 'pass', `Staging has a sitemap at ${found.path}.`);
}

// The tags the old site loads should still load, and the ones the desk lists
// under the site's services should be there. Analytics 4 is often loaded by
// Tag Manager, so a G- id may be missing from a page that has a container.
function tagsCheck(staging, old, services) {
  const label = 'Google tags';
  const now = googleTags(staging);
  const before = old ? googleTags(old) : { gtm: [], ga: [] };
  const listedIds = (kind, re) => unique(services.filter((s) => s.kind === kind)
    .map((s) => (String(s.identifier || '').match(re) || [])[0]).filter(Boolean).map((id) => id.toUpperCase()));
  const desk = { gtm: listedIds('gtm', /GTM-[A-Z0-9]+/i), ga: listedIds('ga4', /G-[A-Z0-9]+/i) };
  const lost = [];
  for (const id of unique([...before.gtm, ...desk.gtm])) {
    if (!now.gtm.includes(id)) lost.push(`${id} (${before.gtm.includes(id) ? 'the old site loads it' : 'the desk lists it'})`);
  }
  if (!now.gtm.length) {
    for (const id of unique([...before.ga, ...desk.ga])) {
      if (!now.ga.includes(id)) lost.push(`${id} (${before.ga.includes(id) ? 'the old site loads it' : 'the desk lists it'})`);
    }
  }
  if (lost.length) {
    return check('tags', label, 'fail',
      `Staging's home page does not load ${plural(lost.length, 'Google tag')} it should, so the new site would go unmeasured. Add ${lost.length > 1 ? 'them' : 'it'} to the layout.`,
      lost);
  }
  const loads = [...now.gtm, ...now.ga];
  if (!loads.length) {
    return check('tags', label, 'warn',
      'Staging loads no Google tag (Tag Manager or Analytics), and neither the old site nor the desk names one. If the client wants the site measured, add one now.');
  }
  const unlisted = loads.filter((id) => !desk.gtm.includes(id) && !desk.ga.includes(id));
  return check('tags', label, 'pass', `Staging loads ${listed(loads)}.`
    + (unlisted.length ? ` The desk does not list ${listed(unlisted)} under Services & accounts yet.` : ''));
}

// --- A run ---

// The first of `paths` on `host` that answers 200 with a sitemap.
async function firstSitemap(fetchImpl, host, paths) {
  for (const path of paths) {
    const page = await getPage(fetchImpl, `https://${host}${path}`, anyBody);
    if (isSitemap(page)) return { path, page };
  }
  return null;
}

// The first step. → { state, checks, progress, counts }: `progress` is the
// work still to do, null when the check is already over (an address is
// missing, or staging does not answer). `services` are the site's services,
// for the tags it should load and the account that sends its form.
export async function startRun({ site, services = [], fetch: fetchImpl, deskHost = DESK_HOST }) {
  const live = site.live_domain;
  const staging = site.staging_domain;
  const addresses = addressesCheck(live, staging, deskHost);
  if (addresses.status === 'fail') return finished([addresses]);

  const hosts = [live, pairOf(live)];
  // A site that is not live yet has no old site, and no old pages to keep.
  const oldSite = site.live_platform !== 'none';
  const [home, robots, sitemap, oldHome, oldRobots, nameservers] = await Promise.all([
    getPage(fetchImpl, `https://${staging}/`),
    getPage(fetchImpl, `https://${staging}/robots.txt`, anyBody),
    firstSitemap(fetchImpl, staging, STAGING_SITEMAPS),
    oldSite ? getFollowed(fetchImpl, `https://${live}/`, hosts) : null,
    oldSite ? getFollowed(fetchImpl, `https://${live}/robots.txt`, hosts, anyBody) : null,
    nameServersCheck(fetchImpl, live),
  ]);

  if (!hasPage(home)) {
    return finished([addresses, nameservers, check('staging', 'Staging page', 'fail',
      `Staging did not answer with a page (${answerText(home)}). If it is behind Cloudflare Access or a login, the desk cannot check it.`)]);
  }
  const checks = [
    addresses,
    check('staging', 'Staging page', 'pass', `https://${staging}/ answers with a page.`),
    canonicalCheck(home, live),
    oldFilesCheck(home, hosts),
    tagsCheck(home.body, hasPage(oldHome || {}) ? oldHome.body : null, services),
    sitemapCheck(sitemap, hosts, live),
    nameservers,
    noindexCheck(home, site.github_repo),
    robotsCheck(robots),
  ];

  // The old site's sitemaps: the ones its robots.txt names, or else the
  // places WordPress puts them, tried in turn.
  const named = oldRobots && hasPageOrText(oldRobots)
    ? unique(robotsSitemaps(oldRobots.body)).filter((u) => hosts.includes(parse(u)?.hostname?.toLowerCase()))
    : [];
  const sitemaps = !oldSite ? []
    : named.length ? named.map((url) => ({ url }))
      : OLD_SITEMAPS.map((path) => ({ url: `https://${live}${path}`, guess: true }));
  const progress = {
    live, staging, hosts, oldSite,
    sitemaps, seen: sitemaps.map((s) => s.url), found: false, notes: [],
    paths: [], next: 0, moved: 0, problems: [], truncated: false,
    oldUnreachable: oldSite && oldHome?.error ? answerText(oldHome) : null,
    homeForm: formOn(home.body),
    hasResend: services.some((s) => s.kind === 'resend'),
    contact: null,
  };
  return { state: 'running', checks, progress, counts: countsOf(progress) };
}

function finished(checks) {
  return { state: 'done', checks: sorted(checks), progress: null, counts: { sitemaps_left: 0, pages_found: 0, pages_checked: 0 } };
}

const countsOf = (p) => ({ sitemaps_left: p.sitemaps.length, pages_found: p.paths.length, pages_checked: p.next });

// One sitemap of the old site: an index adds its sitemaps to the front of
// the queue, so every sitemap is read before any page is checked; any other
// adds its pages. Only addresses on the live domain or its pair count.
async function readSitemap(fetchImpl, task, p, known) {
  const page = await getFollowed(fetchImpl, task.url, p.hosts, anyBody);
  if (!isSitemap(page)) {
    // A guess that is not there is not news; a sitemap robots.txt names is.
    if (!task.guess) p.notes.push(`Could not read ${task.url} (${answerText(page)}).`);
    return;
  }
  p.found = true;
  const { index, locs } = sitemapLocs(page.body);
  const urls = locs.map(parse).filter((u) => u && p.hosts.includes(u.hostname.toLowerCase()));
  if (index) {
    const children = [];
    for (const u of urls) {
      if (p.seen.includes(u.href)) continue;
      if (p.seen.length >= MAX_SITEMAPS) { p.truncated = true; break; }
      p.seen.push(u.href);
      if (/\.gz$/i.test(u.pathname)) { p.notes.push(`Skipped ${u.href}: the desk does not read compressed sitemaps.`); continue; }
      children.push({ url: u.href });
    }
    p.sitemaps.unshift(...children);
    return;
  }
  for (const u of urls) {
    const path = pathOf(u);
    if (known.has(path)) continue;
    if (p.paths.length >= MAX_PATHS) { p.truncated = true; break; }
    known.add(path);
    p.paths.push(path);
  }
}

const noSlash = (path) => path.replace(/\/+$/, '') || '/';

// One old address on staging. 200 is there; a 301 or 308 to a page that
// answers is a page that moved. A 302 or 307 tells search engines the move
// is not for good, so their ranking does not follow it (gate 19 fails any).
// Adding or dropping the trailing slash is the host's own tidying, whatever
// its code. → null when it works, or the line that says why not.
async function pageProblem(fetchImpl, p, path) {
  const url = `https://${p.staging}${path}`;
  const first = await getPage(fetchImpl, url, noBody);
  if (!first.error && first.status === 200) return { ok: true };
  if (first.error || first.status < 300 || first.status > 399 || !first.location) return { problem: `${path}: ${answerText(first)}` };
  const to = URL.canParse(first.location, url) ? new URL(first.location, url) : null;
  if (!to) return { problem: `${path}: ${answerText(first)}` };
  const onSite = (to.hostname === p.staging || p.hosts.includes(to.hostname));
  if (!onSite) return { ok: true, moved: true };   // sent to another site on purpose, such as a booking page
  const slashOnly = noSlash(to.pathname) === noSlash(new URL(url).pathname) && to.search === new URL(url).search;
  if (!slashOnly && (first.status === 302 || first.status === 307)) {
    return { problem: `${path}: HTTP ${first.status} to ${pathOf(to)}. Make it a 301, or search engines do not move its ranking.` };
  }
  const second = await getPage(fetchImpl, `https://${p.staging}${pathOf(to)}`, noBody);
  if (!second.error && second.status === 200) return { ok: true, moved: !slashOnly };
  return { problem: `${path}: redirects to ${pathOf(to)}, which answers ${answerText(second)}` };
}

// The contact page: the old site's, if it has one, and the same address on
// staging. Both are read, since an old contact page with no form needs none.
async function contactCheck(fetchImpl, p) {
  const label = 'Contact form';
  const path = p.paths.filter((x) => /contact/i.test(x)).sort((a, b) => a.length - b.length)[0];
  const resend = p.hasResend ? '' : ' The desk lists no Resend account for this site, which sends the form\'s emails (gate 11). Add it under Services & accounts.';
  const wordpress = (where, form) => check('contact', label, 'fail',
    `The form on staging's ${where} posts to WordPress (${form.wordpress}), which goes when the old site does. Point it at the site's own /api/contact (gate 11).`);

  if (!path) {
    const f = p.homeForm;
    if (f.wordpress) return wordpress('home page', f);
    if (f.found) return check('contact', label, p.hasResend ? 'pass' : 'warn', 'Staging\'s home page has a form.' + resend);
    const status = p.oldSite && p.found ? 'pass' : 'warn';
    return check('contact', label, status, p.oldSite && p.found
      ? 'The old site\'s sitemap has no contact page, and staging\'s home page has no form.'
      : 'The desk found no contact page to check, and staging\'s home page has no form. If the site should have one, add it (gate 11).');
  }
  const [now, before] = await Promise.all([
    getPage(fetchImpl, `https://${p.staging}${path}`),
    getFollowed(fetchImpl, `https://${p.live}${path}`, p.hosts),
  ]);
  if (!hasPage(now)) {
    return check('contact', label, 'fail', `The old site's contact page ${path} does not answer on staging (${answerText(now)}).`);
  }
  const form = formOn(now.body);
  if (form.wordpress) return wordpress(path, form);
  if (form.found) return check('contact', label, p.hasResend ? 'pass' : 'warn', `Staging's ${path} has a form.` + resend);
  if (hasPage(before) && formOn(before.body).found) {
    return check('contact', label, 'fail', `The old site's ${path} has a form, and staging's has none. Rebuild it (gate 11), or visitors cannot get in touch.`);
  }
  return check('contact', label, 'pass', `Neither the old site's ${path} nor staging's has a form.`);
}

function oldAddressesCheck(p) {
  const label = 'Old addresses';
  if (!p.oldSite) return check('old-addresses', label, 'pass', 'The site is not live yet, so there are no old addresses to keep working.');
  const notes = p.notes;
  if (!p.found) {
    const why = p.oldUnreachable ? `The old site did not answer (${p.oldUnreachable}). ` : '';
    return check('old-addresses', label, 'warn',
      `${why}The desk found no sitemap on ${p.live} (it looked in robots.txt, then at ${listed(OLD_SITEMAPS)}), so it could not check that every old page works on staging. Check gate 0.4's list by hand.`,
      notes);
  }
  const total = p.paths.length;
  if (!total) return check('old-addresses', label, 'warn', 'The old site\'s sitemap lists no pages, so there was nothing to check.', notes);
  const more = p.truncated ? ` The desk checked the first ${plural(total, 'address', 'addresses')}; the site has more.` : '';
  if (p.problems.length) {
    return check('old-addresses', label, 'fail',
      `${p.problems.length} of the old site's ${plural(total, 'address', 'addresses')} do not work on staging. Build each page, or give it a 301 to where it moved, or the links and search results that lead to it break.${more}`,
      capped([...p.problems, ...notes]));
  }
  const moved = p.moved ? ` (${p.moved} through a 301)` : '';
  return check('old-addresses', label, p.truncated || notes.length ? 'warn' : 'pass',
    `All ${plural(total, 'address', 'addresses')} in the old site's sitemap work on staging${moved}.${more}`, notes);
}

// The next step of a run. `allowance` is the request's budget (budget.js):
// a step stops while it still has calls left. → { state, checks, progress,
// counts }, the checks complete once the state is done.
export async function continueRun({ checks, progress, fetch: fetchImpl, allowance }) {
  const p = structuredClone(progress);
  const left = () => allowance.remaining();
  const known = new Set(p.paths);

  let read = 0;
  while (p.sitemaps.length && read < SITEMAPS_PER_STEP && left() > 2) {
    const task = p.sitemaps.shift();
    if (task.guess && p.found) continue;
    read++;
    await readSitemap(fetchImpl, task, p, known);
  }
  if (p.sitemaps.length) return { state: 'running', checks, progress: p, counts: countsOf(p) };

  if (!p.contact) {
    if (left() < 3) return { state: 'running', checks, progress: p, counts: countsOf(p) };
    p.contact = await contactCheck(fetchImpl, p);
  }

  const batch = Math.max(0, Math.min(PAGES_PER_STEP, Math.floor((left() - 1) / 2), p.paths.length - p.next));
  const results = await Promise.all(p.paths.slice(p.next, p.next + batch).map((path) => pageProblem(fetchImpl, p, path)));
  for (const r of results) {
    if (r.problem) p.problems.push(r.problem);
    else if (r.moved) p.moved++;
  }
  p.next += batch;
  if (p.next < p.paths.length) return { state: 'running', checks, progress: p, counts: countsOf(p) };

  const done = finished([...checks, oldAddressesCheck(p), p.contact]);
  return { ...done, counts: countsOf(p) };
}

// --- What the list shows ---

// The approval is the site's own field, so it is read fresh every time, not
// saved with the check: recording it after a check counts at once.
function approvalCheck(site) {
  const label = 'Approval (gate 12)';
  if (!site.approved_on) {
    return check('approval', label, 'fail',
      'Nobody has recorded that gate 12 is approved. Add who approved it and on which day with Edit details.');
  }
  return check('approval', label, 'pass', `Approved${site.approved_by ? ' by ' + site.approved_by : ''} on ${site.approved_on}.`);
}

// A site's readiness as the page gets it, from its row in site_readiness
// (as the store reads it, JSON parsed) or null when it was never checked.
//   state:  'none' · 'running' · 'stalled' (no step for two minutes) · 'done'
//   stale:  null · 'addresses' (the live or staging address changed since) ·
//           'old' (finished more than a week ago)
//   ready:  done, not stale, and no check fails, the approval included.
export function readinessSummary(site, row, now = Date.now()) {
  if (!row) return { state: 'none', ready: false, stale: null, checks: [] };
  const running = row.state === 'running';
  const state = running ? (now - Date.parse(row.updated_at) > STALLED ? 'stalled' : 'running') : 'done';
  const checks = running ? row.checks : sorted([...row.checks, approvalCheck(site)]);
  const stale = state !== 'done' ? null
    : row.live_host !== (site.live_domain ?? null) || row.staging_host !== (site.staging_domain ?? null) ? 'addresses'
      : !(now - Date.parse(row.finished_at) <= FRESH_FOR) ? 'old' : null;
  return {
    run: row.run,
    state,
    started_at: row.started_at,
    finished_at: row.finished_at ?? null,
    updated_at: row.updated_at,
    counts: row.counts,
    checks,
    stale,
    ready: state === 'done' && !stale && isReady(checks),
  };
}
