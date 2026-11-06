// Repeatable real-browser check of the Workers Graph view (HUB0323 piece W-A5).
//
// Run it against a SCRATCH dashboard, never the live one (see docs/agents/workflow-graph.md):
//   PLAYWRIGHT_DIR=<dir of a playwright or playwright-core install> DASHBOARD_URL=http://127.0.0.1:7499 \
//     node python/dashboard/tests/browser_workflow_graph.mjs
// Optional: SCREENSHOT=<png path> (default /tmp/workflow-graph.png), CHROMIUM=<chromium or headless-shell binary>.
//
// With no PLAYWRIGHT_DIR it prints "skipped: PLAYWRIGHT_DIR not set" and exits 0. It refuses port 7420 (the live dashboard) and exits 2.
// It only reads: it opens the tab, switches the view, clicks a node and takes a screenshot. It never presses a Turn on / Turn off button.

import path from 'node:path';
import { createRequire } from 'node:module';

const LIVE_PORT = '7420';
const POLL_WAIT_MS = 12000; // two 5 s poll cycles plus margin

export function dashboardPort(url) {
  try {
    const u = new URL(url);
    return u.port || (u.protocol === 'https:' ? '443' : '80');
  } catch (e) {
    return null;
  }
}

// instanceId -> the graph node id the builder gives it (services are prefixed, everything else keeps its id).
export function nodeIdForInstance(instanceId) {
  return instanceId === 'watchdog' || instanceId === 'apply-loop' ? 'service:' + instanceId : instanceId;
}

function loadPlaywright(dir) {
  const req = createRequire(path.join(path.resolve(dir), 'noop.js'));
  for (const name of ['playwright', 'playwright-core']) {
    try { return req(name); } catch (e) { /* try the next name */ }
  }
  throw new Error('no playwright or playwright-core found under PLAYWRIGHT_DIR=' + dir);
}

async function main() {
  const url = (process.env.DASHBOARD_URL || 'http://127.0.0.1:7499').replace(/\/+$/, '');
  if (dashboardPort(url) === LIVE_PORT) {
    console.error('refusing to run against port ' + LIVE_PORT + ' (the live dashboard); start a scratch dashboard and point DASHBOARD_URL at it');
    process.exit(2);
  }
  if (!process.env.PLAYWRIGHT_DIR) {
    console.log('skipped: PLAYWRIGHT_DIR not set');
    process.exit(0);
  }
  const screenshot = process.env.SCREENSHOT || '/tmp/workflow-graph.png';
  const pw = loadPlaywright(process.env.PLAYWRIGHT_DIR);
  const problems = [];
  const check = (ok, message) => { console.log((ok ? 'ok   ' : 'FAIL ') + message); if (!ok) problems.push(message); };

  const instances = await (await fetch(url + '/api/instances')).json();
  const ids = instances.map((i) => i.instanceId);
  check(ids.length > 0, 'the dashboard reports at least one instance (' + ids.length + ')');

  const browser = await pw.chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(url + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await page.locator('text=/^\\s*Workers\\s*$/').first().click();
    await page.waitForTimeout(2500);

    await page.locator('.wf-view-btn[data-view="graph"]').click();
    await page.waitForSelector('.wf-node', { timeout: 30000 }); // the first /api/workflow-graph call runs several node processes
    const missing = [];
    for (const id of ids) {
      if ((await page.locator('.wf-node[data-node-id="' + nodeIdForInstance(id) + '"]').count()) === 0) missing.push(id);
    }
    check(missing.length === 0, 'the graph has a node for every instance' + (missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''));
    check(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'the page does not scroll sideways');

    const node = page.locator('.wf-node').first();
    const selectedId = await node.getAttribute('data-node-id');
    await node.click();
    await page.waitForTimeout(1000);
    check((await page.locator('#wf-detail').count()) === 1, 'clicking a node opens its detail panel (' + selectedId + ')');

    await page.waitForTimeout(POLL_WAIT_MS);
    check((await page.locator('.wf-node.wf-selected[data-node-id="' + selectedId + '"]').count()) === 1, 'the selection is still there after two poll cycles');

    await page.screenshot({ path: screenshot });
    console.log('screenshot: ' + screenshot);

    await page.locator('.wf-view-btn[data-view="cards"]').click();
    await page.waitForSelector('.worker-card[data-instance-id]', { timeout: 30000 });
    const cards = await page.locator('.worker-card[data-instance-id]').count(); // instance cards only: the stalled-worker panel is a card without an instance id
    check(cards === ids.length, 'the Cards view shows one card per instance (' + cards + ' of ' + ids.length + ')');
    check(pageErrors.length === 0, 'no page errors' + (pageErrors.length ? ': ' + pageErrors.join(' | ') : ''));
  } finally {
    await browser.close();
  }
  if (problems.length) {
    console.error(problems.length + ' check(s) did not pass');
    process.exit(1);
  }
  console.log('all checks passed');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((e) => { console.error('error: ' + e.message); process.exit(1); });
}
