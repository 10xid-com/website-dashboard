// Exercise the shipped static UI with API fixtures; never touch live data.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

const sha = 'a'.repeat(40);
const sample = { id: '0001', name: 'Approval example', live_domain: 'acme.example',
  live_platform: 'wordpress', staging_domain: 'stage.acme.example', needs_seo_ppc: true,
  github_repo: 'acme/site', chatgpt_approved: true, chatgpt_approved_at: new Date().toISOString(),
  chatgpt_approval_ref: 'https://github.com/acme/site/pull/12', chatgpt_approval_sha: sha };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(url.pathname.endsWith('/details')
      ? { services: [], contacts: [], domains: [], jobs: [], socials: [], history: [], choices: {} }
      : { sites: [sample, { id: '0002', name: 'Unreviewed example', needs_seo_ppc: true }] }));
    return;
  }
  try {
    const file = path.join('public', url.pathname === '/' ? 'index.html' : url.pathname);
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch(process.platform === 'win32' ? { channel: 'msedge' } : {});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const approved = page.locator('.site[data-id="0001"]');
  await approved.getByText('ChatGPT approved', { exact: true }).waitFor();
  assert.equal(await approved.locator('.flags li').nth(3).textContent(), 'ChatGPT approved');
  await page.locator('.site[data-id="0002"]').getByText('Awaiting ChatGPT review', { exact: true }).waitFor();
  await approved.locator('.nm').click();
  assert.equal(await approved.locator('.review-ready a').first().getAttribute('href'), sample.chatgpt_approval_ref);
  assert.ok((await approved.locator('.review-ready').textContent()).includes(sha));
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`);
  }
  assert.deepEqual(errors, []);
  console.log('Approval badge, review link, commit, pending state, and responsive layouts passed.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
