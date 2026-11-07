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

// Phone-size checks (HUB0346): at 390x844 the Graph view is a row of swipeable loop cards, a node can be dragged, and where it was left is still there after a reload.
// Reads and moves nodes only; it never presses a Turn on / Turn off button (a drag starts on the node title, away from the buttons).
async function phoneChecks(browser, url, check) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const open = async () => {
    await page.goto(url + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await page.locator('text=/^\\s*Workers\\s*$/').first().click();
    await page.waitForTimeout(2500);
    await page.locator('.wf-view-btn[data-view="graph"]').click();
    await page.waitForSelector('.wf-card', { timeout: 30000 });
    await page.waitForTimeout(1000);
  };
  try {
    await open();
    await page.evaluate(() => localStorage.removeItem('workersGraphPositions'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await open();
    const cards = await page.locator('.wf-card').count();
    check(cards >= 1, 'the phone view shows one card per loop (' + cards + ')');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'the phone page does not scroll sideways');
    check(await page.evaluate(() => [...document.querySelectorAll('.wf-card')].every((c) => Number(c.dataset.scale) >= 0.5 && Number(c.dataset.scale) <= 1)), 'every card is scaled between 0.5 and 1');
    check(await page.evaluate(() => [...document.querySelectorAll('.wf-card-body')].every((b) => b.scrollWidth <= b.clientWidth + 1)), 'no card scrolls sideways inside itself');
    // Readability pass 2: a big loop shows its sources as ONE group card, with a Show/Hide button; titles tell the lanes apart; a group header is drawn once.
    check(await page.evaluate(() => [...document.querySelectorAll('.wf-card')].every((c) => c.querySelectorAll('.wf-node').length <= 12)), 'no card starts as a wall of nodes (a big loop is collapsed)');
    check(await page.evaluate(() => [...document.querySelectorAll('.wf-card')].every((c) => { const t = [...c.querySelectorAll('.wf-node .id')].map((e) => e.textContent); return new Set(t).size === t.length; })), 'no two nodes on a card have the same title (worker and reviewer are told apart)');
    const bigId = await page.evaluate(() => { const b = document.querySelector('.wf-sources-toggle'); return b ? b.dataset.loopId : null; });
    if (bigId) {
      const card = page.locator('.wf-card[data-loop-id="' + bigId + '"]');
      const before = await card.locator('.wf-node').count();
      const label = (await card.locator('.wf-sources-toggle').textContent()).trim();
      check(/^Show \d+ sources$/.test(label), 'the big loop offers "' + label + '"');
      check(await card.evaluate((c) => Number(c.dataset.scale) >= 0.6), 'the collapsed big loop is drawn at a readable size');
      await card.locator('.wf-sources-toggle').click();
      await page.waitForTimeout(600);
      const after = await page.locator('.wf-card[data-loop-id="' + bigId + '"] .wf-node').count();
      check(after > before + 6, 'Show sources reveals the sources (' + before + ' to ' + after + ' nodes)');
      check((await page.locator('.wf-card[data-loop-id="' + bigId + '"] .wf-sources-toggle').textContent()).trim() === 'Hide sources', 'the button now says Hide sources');
      check(await page.evaluate(() => [...document.querySelectorAll('.wf-card')].every((c) => { const ids = [...c.querySelectorAll('.wf-group-toggle')].map((b) => b.dataset.groupId); return new Set(ids).size === ids.length; })), 'a group header is drawn once, not on every row');
      await page.locator('.wf-card[data-loop-id="' + bigId + '"] .wf-sources-toggle').click();
      await page.waitForTimeout(600);
      check((await page.locator('.wf-card[data-loop-id="' + bigId + '"] .wf-node').count()) === before, 'Hide sources collapses it again');
    } else {
      check(false, 'no loop card has a Show sources button (the scratch data should have a loop with more than 6 sources)');
    }
    if (cards > 1) {
      await page.evaluate(() => { const row = document.getElementById('wf-surface'); row.scrollTo({ left: row.querySelectorAll('.wf-card')[1].offsetLeft - row.offsetLeft + 40, behavior: 'instant' }); });
      await page.waitForTimeout(900);
      const off = await page.evaluate(() => { const row = document.getElementById('wf-surface'); return Math.abs(row.querySelectorAll('.wf-card')[1].getBoundingClientRect().left - row.getBoundingClientRect().left); });
      check(off <= 2, 'a swipe settles on the next card (' + Math.round(off) + ' px off)');
      await page.evaluate(() => { const row = document.getElementById('wf-surface'); row.scrollTo({ left: 0, behavior: 'instant' }); });
      await page.waitForTimeout(500);
    }
    const node = page.locator('.wf-card').first().locator('.wf-node').first();
    const id = await node.getAttribute('data-node-id');
    await node.scrollIntoViewIfNeeded(); // the first node in the page can sit far down a tall card, out of reach of the mouse
    const before = await node.evaluate((el) => [el.offsetLeft, el.offsetTop]);
    const box = await node.boundingBox();
    await page.mouse.move(box.x + 24, box.y + 14);
    await page.mouse.down();
    await page.mouse.move(box.x + 24 + 30, box.y + 14 + 40, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const after = await page.locator('.wf-card').first().locator('.wf-node[data-node-id="' + id + '"]').evaluate((el) => [el.offsetLeft, el.offsetTop]);
    check(after[0] !== before[0] || after[1] !== before[1], 'dragging a node moves it (' + id + ')');
    check((await page.locator('.wf-node.wf-selected').count()) === 0, 'a drag does not select the node');
    check(await page.evaluate(() => !!localStorage.getItem('workersGraphPositions')), 'the position is saved');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await open();
    const again = await page.locator('.wf-card').first().locator('.wf-node[data-node-id="' + id + '"]').evaluate((el) => [el.offsetLeft, el.offsetTop]);
    check(again[0] === after[0] && again[1] === after[1], 'the dragged position is still there after a reload');
    await page.locator('.wf-reset-btn').click();
    await page.waitForTimeout(600);
    const reset = await page.locator('.wf-card').first().locator('.wf-node[data-node-id="' + id + '"]').evaluate((el) => [el.offsetLeft, el.offsetTop]);
    check(reset[0] === before[0] && reset[1] === before[1], 'Reset layout puts the node back');
    check(errors.length === 0, 'no page errors on the phone view' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } finally {
    await context.close();
  }
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
    // A node that sits on several loop cards (the apply service, a shared source) is marked on every one of them, so one or more.
    check((await page.locator('.wf-node.wf-selected[data-node-id="' + selectedId + '"]').count()) >= 1, 'the selection is still there after two poll cycles');

    await page.screenshot({ path: screenshot });
    console.log('screenshot: ' + screenshot);

    await page.locator('.wf-view-btn[data-view="cards"]').click();
    await page.waitForSelector('.worker-card[data-instance-id]', { timeout: 30000 });
    const cards = await page.locator('.worker-card[data-instance-id]').count(); // instance cards only: the stalled-worker panel is a card without an instance id
    check(cards === ids.length, 'the Cards view shows one card per instance (' + cards + ' of ' + ids.length + ')');
    await phoneChecks(browser, url, check);
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
