'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { notify, configFrom, headerSafe, parseArgs, main } = require('./notify.js');

function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-test-'));
  const env = { AGENT_MANAGER_PIPELINE_DIR: dir, AGENT_MANAGER_NOTIFY_URL: 'http://ntfy.test/agentmanager', ...extra };
  const calls = [];
  let clock = Date.UTC(2026, 10, 11, 12, 0, 0);
  const post = async (url, headers, body) => { calls.push({ url, headers, body }); };
  const opts = { env, post, now: () => clock };
  return { dir, env, calls, opts, advance: (ms) => { clock += ms; }, log: () => fs.readFileSync(path.join(dir, 'notify', 'notify-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) };
}

test('an urgent message is posted at once with the title, priority and body', async () => {
  const t = setup();
  const r = await notify({ level: 'urgent', key: 'stale-node:grimm', title: 'grimm is not answering', text: 'last seen 12 min ago' }, t.opts);
  assert.deepEqual(r, { sent: true, reason: 'sent' });
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].url, 'http://ntfy.test/agentmanager');
  assert.equal(t.calls[0].headers.Title, 'grimm is not answering');
  assert.equal(t.calls[0].headers.Priority, 'urgent');
  assert.equal(t.calls[0].body, 'last seen 12 min ago');
});

test('a summary is posted with default priority; a missing text falls back to the title', async () => {
  const t = setup();
  await notify({ level: 'summary', key: 'summary:d', title: 'Daily summary' }, t.opts);
  assert.equal(t.calls[0].headers.Priority, 'default');
  assert.equal(t.calls[0].body, 'Daily summary');
});

test('a routine message is never posted but is logged', async () => {
  const t = setup();
  const r = await notify({ level: 'routine', key: 'k', title: 'a task finished' }, t.opts);
  assert.deepEqual(r, { sent: false, reason: 'routine' });
  assert.equal(t.calls.length, 0);
  assert.equal(t.log()[0].outcome, 'routine');
});

test('an unknown level is not posted', async () => {
  const t = setup();
  assert.equal((await notify({ level: 'panic', key: 'k', title: 't' }, t.opts)).reason, 'unknown-level');
  assert.equal((await notify({}, t.opts)).reason, 'unknown-level');
  assert.equal((await notify(null, t.opts)).reason, 'unknown-level');
  assert.equal(t.calls.length, 0);
});

test('without a URL nothing is posted and the log says so', async () => {
  const t = setup({ AGENT_MANAGER_NOTIFY_URL: '' });
  const r = await notify({ level: 'urgent', key: 'k', title: 't' }, t.opts);
  assert.equal(r.reason, 'no-url');
  assert.equal(t.calls.length, 0);
  assert.equal(t.log()[0].outcome, 'no-url');
});

test('the kill switch stops everything', async () => {
  const t = setup({ AGENT_MANAGER_NOTIFY: 'false' });
  assert.equal((await notify({ level: 'urgent', key: 'k', title: 't' }, t.opts)).reason, 'disabled');
  assert.equal(t.calls.length, 0);
});

test('the same key inside the window is sent once; after the window it is sent again', async () => {
  const t = setup();
  const m = { level: 'urgent', key: 'pause-stuck:grimm', title: 'pause stuck' };
  assert.equal((await notify(m, t.opts)).sent, true);
  t.advance(59 * 60 * 1000);
  assert.equal((await notify(m, t.opts)).reason, 'duplicate');
  t.advance(2 * 60 * 1000);
  assert.equal((await notify(m, t.opts)).sent, true);
  assert.equal(t.calls.length, 2);
});

test('a different key is not treated as a duplicate', async () => {
  const t = setup();
  await notify({ level: 'urgent', key: 'a', title: 't' }, t.opts);
  assert.equal((await notify({ level: 'urgent', key: 'b', title: 't' }, t.opts)).sent, true);
});

test('the window follows AGENT_MANAGER_NOTIFY_DEDUPE_MIN', async () => {
  const t = setup({ AGENT_MANAGER_NOTIFY_DEDUPE_MIN: '5' });
  const m = { level: 'urgent', key: 'k', title: 't' };
  await notify(m, t.opts);
  t.advance(6 * 60 * 1000);
  assert.equal((await notify(m, t.opts)).sent, true);
});

test('urgent messages are capped per hour, then allowed again', async () => {
  const t = setup({ AGENT_MANAGER_NOTIFY_MAX_PER_HOUR: '2' });
  assert.equal((await notify({ level: 'urgent', key: '1', title: 't' }, t.opts)).sent, true);
  assert.equal((await notify({ level: 'urgent', key: '2', title: 't' }, t.opts)).sent, true);
  assert.equal((await notify({ level: 'urgent', key: '3', title: 't' }, t.opts)).reason, 'rate-limited');
  t.advance(61 * 60 * 1000);
  assert.equal((await notify({ level: 'urgent', key: '3', title: 't' }, t.opts)).sent, true);
});

test('the hourly cap does not count summaries', async () => {
  const t = setup({ AGENT_MANAGER_NOTIFY_MAX_PER_HOUR: '1' });
  await notify({ level: 'summary', key: 's', title: 't' }, t.opts);
  assert.equal((await notify({ level: 'urgent', key: 'u', title: 't' }, t.opts)).sent, true);
});

test('a failed post is reported, logged, and retried at the next call (not remembered as sent)', async () => {
  const t = setup();
  let fail = true;
  const opts = { ...t.opts, post: async () => { if (fail) throw new Error('connection refused'); } };
  const m = { level: 'urgent', key: 'k', title: 't' };
  const first = await notify(m, opts);
  assert.equal(first.sent, false);
  assert.equal(first.reason, 'error');
  assert.match(first.error, /connection refused/);
  assert.equal(t.log()[0].outcome, 'error');
  fail = false;
  assert.equal((await notify(m, opts)).sent, true);
});

test('a throwing post and a bad state file never make notify throw', async () => {
  const t = setup();
  fs.mkdirSync(path.join(t.dir, 'notify'), { recursive: true });
  fs.writeFileSync(path.join(t.dir, 'notify', 'notify-state.json'), '{not json');
  const r = await notify({ level: 'urgent', key: 'k', title: 't' }, t.opts);
  assert.equal(r.sent, true);
});

test('the state survives between calls through the file', async () => {
  const t = setup();
  await notify({ level: 'urgent', key: 'k', title: 't' }, t.opts);
  const state = JSON.parse(fs.readFileSync(path.join(t.dir, 'notify', 'notify-state.json'), 'utf8'));
  assert.ok(state.lastSent['urgent:k']);
  assert.equal(state.urgentSent.length, 1);
});

test('keys older than two days are forgotten from the state file', async () => {
  const t = setup();
  await notify({ level: 'urgent', key: 'old', title: 't' }, t.opts);
  t.advance(49 * 60 * 60 * 1000);
  await notify({ level: 'urgent', key: 'new', title: 't' }, t.opts);
  const state = JSON.parse(fs.readFileSync(path.join(t.dir, 'notify', 'notify-state.json'), 'utf8'));
  assert.deepEqual(Object.keys(state.lastSent), ['urgent:new']);
});

test('the log has the title and outcome but never the message body', async () => {
  const t = setup();
  await notify({ level: 'urgent', key: 'k', title: 'a title', text: 'SECRET BODY TEXT' }, t.opts);
  const raw = fs.readFileSync(path.join(t.dir, 'notify', 'notify-log.jsonl'), 'utf8');
  assert.ok(!raw.includes('SECRET BODY TEXT'));
  const line = t.log()[0];
  assert.equal(line.title, 'a title');
  assert.equal(line.outcome, 'sent');
  assert.equal(line.level, 'urgent');
});

test('a long body is cut and a title with a newline or non-ASCII is made header-safe', async () => {
  const t = setup();
  await notify({ level: 'urgent', key: 'k', title: 'line one\nline two é中', text: 'x'.repeat(5000) }, t.opts);
  assert.equal(t.calls[0].body.length, 1000);
  assert.equal(t.calls[0].headers.Title, 'line one line two');
  assert.equal(headerSafe(null), '');
  assert.equal(headerSafe('a'.repeat(500)).length, 200);
});

test('the default sender posts a real HTTP request with the headers and body', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { seen.push({ method: req.method, url: req.url, title: req.headers.title, priority: req.headers.priority, body }); res.end('ok'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const t = setup({ AGENT_MANAGER_NOTIFY_URL: `http://127.0.0.1:${server.address().port}/topic` });
  try {
    const r = await notify({ level: 'urgent', key: 'k', title: 'real post', text: 'hello' }, { env: t.env });
    assert.equal(r.sent, true);
    assert.deepEqual(seen, [{ method: 'POST', url: '/topic', title: 'real post', priority: 'urgent', body: 'hello' }]);
  } finally {
    server.close();
  }
});

test('the default sender reports a non-2xx answer and an invalid URL as errors', async () => {
  const server = http.createServer((req, res) => { res.statusCode = 500; res.end('no'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const t = setup({ AGENT_MANAGER_NOTIFY_URL: `http://127.0.0.1:${server.address().port}/x` });
    const r = await notify({ level: 'urgent', key: 'k', title: 't' }, { env: t.env });
    assert.equal(r.reason, 'error');
    assert.match(r.error, /HTTP 500/);
    const bad = setup({ AGENT_MANAGER_NOTIFY_URL: 'not a url' });
    const r2 = await notify({ level: 'urgent', key: 'k', title: 't' }, { env: bad.env });
    assert.match(r2.error, /invalid AGENT_MANAGER_NOTIFY_URL/);
  } finally {
    server.close();
  }
});

test('without a pipeline dir or notify dir nothing is posted', async () => {
  const calls = [];
  const r = await notify({ level: 'urgent', key: 'k', title: 't' }, { env: { AGENT_MANAGER_NOTIFY_URL: 'http://x.test/' }, post: async () => { calls.push(1); } });
  assert.equal(r.reason, 'no-state-dir');
  assert.equal(calls.length, 0);
});

test('configFrom reads defaults and overrides', () => {
  const d = configFrom({});
  assert.equal(d.urgentWindowMs, 60 * 60 * 1000);
  assert.equal(d.summaryWindowMs, 20 * 60 * 60 * 1000);
  assert.equal(d.urgentPerHour, 6);
  assert.equal(d.timeoutMs, 5000);
  const o = configFrom({ AGENT_MANAGER_NOTIFY_DEDUPE_MIN: '10', AGENT_MANAGER_NOTIFY_MAX_PER_HOUR: '3', AGENT_MANAGER_NOTIFY_DIR: '/x/n' });
  assert.equal(o.urgentWindowMs, 10 * 60 * 1000);
  assert.equal(o.urgentPerHour, 3);
  assert.equal(o.stateDir, '/x/n');
  assert.equal(configFrom({ AGENT_MANAGER_NOTIFY_DEDUPE_MIN: '-4' }).urgentWindowMs, 60 * 60 * 1000);
});

test('parseArgs and main handle the command line', async () => {
  assert.deepEqual(parseArgs(['--level', 'urgent', '--key', 'k', '--title', 'a b']), { level: 'urgent', key: 'k', title: 'a b' });
  const realErr = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal(await main([]), 2);
    assert.equal(await main(['--level', 'urgent']), 2);
  } finally {
    process.stderr.write = realErr;
  }
});

test('a message without a key is de-duplicated by its title', async () => {
  const t = setup();
  assert.equal((await notify({ level: 'urgent', title: 'same title' }, t.opts)).sent, true);
  assert.equal((await notify({ level: 'urgent', title: 'same title' }, t.opts)).reason, 'duplicate');
  assert.equal(t.log()[1].key, 'same title');
});

test('a message without a title gets the Agent Manager title', async () => {
  const t = setup();
  await notify({ level: 'urgent', key: 'k' }, t.opts);
  assert.equal(t.calls[0].headers.Title, 'Agent Manager');
  assert.equal(t.calls[0].body, 'Agent Manager');
});

test('each level carries its own tag', async () => {
  const t = setup();
  await notify({ level: 'urgent', key: 'u', title: 't' }, t.opts);
  await notify({ level: 'summary', key: 's', title: 't' }, t.opts);
  assert.equal(t.calls[0].headers.Tags, 'rotating_light');
  assert.equal(t.calls[1].headers.Tags, 'bar_chart');
});

test('a log over one megabyte is rotated to notify-log.jsonl.1 and a fresh log started', async () => {
  const t = setup();
  const dir = path.join(t.dir, 'notify');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notify-log.jsonl'), 'x'.repeat(1024 * 1024 + 10));
  await notify({ level: 'urgent', key: 'k', title: 't' }, t.opts);
  assert.equal(fs.readFileSync(path.join(dir, 'notify-log.jsonl.1'), 'utf8').length, 1024 * 1024 + 10);
  assert.equal(t.log().length, 1);
});
