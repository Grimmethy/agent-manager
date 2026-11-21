#!/usr/bin/env node
'use strict';
// One-shot probe: loads a local scratch dashboard in headless Chromium, switches
// through each discovered tab, and reports computed spacing values (margin-top,
// margin-bottom, padding longhands) that are not multiples of 4px.
//
// Usage: node scripts/probe-spacing-scale.js <dashboard-url on 127.0.0.1 or localhost>
// Exit:  0 = clean, 1 = violations found, 2 = usage or runtime error.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost']);
const BROWSER_NAMES = ['chromium', 'chromium-browser', 'google-chrome'];
const SELECTORS = ['div', '.machine-pause-bar', '.meta'];
const LONGHANDS = [
  'margin-top',
  'margin-bottom',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function usage(message) {
  if (message) process.stderr.write(message + '\n');
  process.stderr.write(
    'usage: node scripts/probe-spacing-scale.js <dashboard-url on 127.0.0.1 or localhost>\n'
  );
  process.exit(2);
}

// Validates the target before any browser is looked for or started.
function parseTarget(raw) {
  if (!raw) usage('error: missing dashboard URL argument');
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    usage('error: not a valid URL: ' + raw);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    usage('error: dashboard URL must use http or https');
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    usage('error: host must be 127.0.0.1 or localhost, got ' + url.hostname);
  }
  return url.toString();
}

function findBrowser() {
  for (const name of BROWSER_NAMES) {
    const r = spawnSync('sh', ['-c', 'command -v ' + name], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from DevTools endpoint');
  return res.json();
}

// Waits until Chromium exposes a page target on the dashboard origin.
async function waitForPage(port, origin, deadline) {
  while (Date.now() < deadline) {
    try {
      const list = await getJson('http://127.0.0.1:' + port + '/json/list');
      const page = list.find(
        (t) =>
          t.type === 'page' &&
          t.webSocketDebuggerUrl &&
          typeof t.url === 'string' &&
          t.url.startsWith(origin)
      );
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) {
      // DevTools not up yet; retry.
    }
    await sleep(200);
  }
  throw new Error('timed out waiting for the dashboard page in Chromium');
}

function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  const open = new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('DevTools websocket error'));
  });
  return {
    open,
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      ws.close();
    },
  };
}

// Runs inside the dashboard page. Discovers tab controls from the DOM, clicks
// each one in turn, and reads computed spacing on every tab.
async function probeInPage(selectors, longhands) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  if (document.readyState !== 'complete') {
    await new Promise((resolve) => addEventListener('load', resolve, { once: true }));
  }
  await pause(500);
  const TAB_SELECTOR = '[role=tab], [data-tab], .tab, .tab-btn, nav button';
  const count = document.querySelectorAll(TAB_SELECTOR).length;
  const tabs = [];
  const violations = [];
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    const el = document.querySelectorAll(TAB_SELECTOR)[i];
    if (!el) break;
    const label =
      (el.getAttribute('data-tab') || el.textContent || '').trim().slice(0, 60) ||
      'tab#' + i;
    el.click();
    await pause(300);
    tabs.push(label);
    for (const sel of selectors) {
      for (const node of document.querySelectorAll(sel)) {
        const cs = getComputedStyle(node);
        for (const prop of longhands) {
          const raw = cs.getPropertyValue(prop).trim();
          const m = /^(-?\d+(?:\.\d+)?)px$/.exec(raw);
          if (!m) continue;
          if (Math.abs(parseFloat(m[1]) % 4) > 1e-9) {
            const key = label + '|' + sel + '|' + prop + '|' + raw;
            if (!seen.has(key)) {
              seen.add(key);
              violations.push({ tab: label, selector: sel, property: prop, value: raw });
            }
          }
        }
      }
    }
  }
  return { tabCount: count, tabs, violations };
}

async function main() {
  const target = parseTarget(process.argv[2]);
  if (typeof WebSocket === 'undefined') {
    usage('error: this script needs a global WebSocket (Node 22+)');
  }
  const browser = findBrowser();
  if (!browser) {
    usage('error: none of chromium, chromium-browser, google-chrome found on PATH');
  }

  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-spacing-'));
  const child = spawn(
    browser,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--remote-debugging-port=' + port,
      '--user-data-dir=' + profile,
      target,
    ],
    { stdio: 'ignore' }
  );

  let client = null;
  let exitCode = 0;
  try {
    const origin = new URL(target).origin;
    const wsUrl = await waitForPage(port, origin, Date.now() + 20000);
    client = cdpConnect(wsUrl);
    await client.open;
    const expression =
      '(' + probeInPage.toString() + ')(' +
      JSON.stringify(SELECTORS) + ', ' + JSON.stringify(LONGHANDS) + ')';
    const r = await client.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error('page probe threw: ' + (r.exceptionDetails.text || 'unknown'));
    }
    const out = r.result.value;
    if (!out || out.tabCount === 0) {
      throw new Error('no tab controls found on the dashboard page');
    }
    for (const v of out.violations) {
      console.log('tab=' + v.tab + ' selector=' + v.selector + ' ' + v.property + '=' + v.value);
    }
    console.log(
      'checked ' + out.tabCount + ' tab(s) x ' + SELECTORS.length + ' selector(s); ' +
        out.violations.length + ' violation(s)'
    );
    exitCode = out.violations.length > 0 ? 1 : 0;
  } catch (err) {
    process.stderr.write('error: ' + err.message + '\n');
    exitCode = 2;
  } finally {
    if (client) client.close();
    child.kill();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  process.exitCode = exitCode;
}

main();
