'use strict';
// scripts/provision-node.sh provisions a node's pipeline directory and starts nothing. Every test runs the real script in a temp directory.
// Run: node --test scripts/provision-node.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'provision-node.sh');
const QUEUES = ['pending', 'adhoc', 'drafting', 'review', 'blocked', 'needs-clarification', 'done', 'node-outbox', 'node-sent'];

function tmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-node-'));
  return { root, pipe: path.join(root, 'pipe'), repo: path.join(root, 'repo') };
}

function provision(args) {
  return spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', timeout: 60000 });
}

const read = (file) => fs.readFileSync(file, 'utf8');

test('the script is valid bash', () => {
  assert.equal(spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' }).status, 0);
});

test('a first run creates the nine queue directories, the domains, one disabled cloud lane and node.env, and starts nothing', () => {
  const t = tmp();
  const r = provision(['grimm', t.pipe, t.repo]);
  assert.equal(r.status, 0, r.stderr);
  for (const q of QUEUES) assert.equal(fs.statSync(path.join(t.pipe, 'queue', q)).isDirectory(), true, q);
  assert.deepEqual(fs.readdirSync(path.join(t.pipe, 'queue')).sort(), [...QUEUES].sort());
  const domains = JSON.parse(read(path.join(t.pipe, 'task-domains.json')));
  assert.ok(domains.default && domains.adhoc);
  const lanes = JSON.parse(read(path.join(t.pipe, 'lanes.json')));
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].provider, 'cloud');
  assert.equal(lanes[0].enabled, false);
  assert.deepEqual(lanes[0].taskClasses, ['adhoc']);
  assert.equal(lanes[0].preempt, 'never');
  assert.equal(read(path.join(t.pipe, 'node.env')), [
    'AGENT_MANAGER_NODE_ID=grimm', `AGENT_MANAGER_PIPELINE_DIR=${t.pipe}`, `AGENT_MANAGER_REPO_ROOT=${t.repo}`, `AGENT_MANAGER_DOMAINS_PATH=${t.pipe}/task-domains.json`, '',
  ].join('\n'));
  assert.deepEqual(fs.readdirSync(t.pipe).sort(), ['lanes.json', 'node.env', 'queue', 'task-domains.json']);
  assert.match(r.stdout, /Nothing was started/);
  assert.match(r.stdout, /does not exist yet/);
  assert.match(r.stdout, /created .*lanes\.json \(the cloud lane, disabled\)/);
});

test('no file the script writes mentions a token, and the note about a missing repo disappears once the repo exists', () => {
  const t = tmp();
  fs.mkdirSync(t.repo);
  const r = provision(['grimm', t.pipe, t.repo]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /does not exist yet/);
  for (const f of ['task-domains.json', 'lanes.json', 'node.env']) assert.doesNotMatch(read(path.join(t.pipe, f)), /token/i, f);
});

test('a second run keeps everything: files unchanged, an edited lanes.json untouched, no backup made, node.env rewritten identically', () => {
  const t = tmp();
  assert.equal(provision(['grimm', t.pipe, t.repo]).status, 0);
  const lanesFile = path.join(t.pipe, 'lanes.json');
  fs.writeFileSync(lanesFile, '[{"gpu":"mine","enabled":true}]\n');
  fs.writeFileSync(path.join(t.pipe, 'queue', 'adhoc', 'keep-me.json'), '{}');
  const before = { domains: read(path.join(t.pipe, 'task-domains.json')), env: read(path.join(t.pipe, 'node.env')) };
  const r = provision(['grimm', t.pipe, t.repo]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(lanesFile), '[{"gpu":"mine","enabled":true}]\n');
  assert.equal(read(path.join(t.pipe, 'task-domains.json')), before.domains);
  assert.equal(read(path.join(t.pipe, 'node.env')), before.env);
  assert.equal(fs.readFileSync(path.join(t.pipe, 'queue', 'adhoc', 'keep-me.json'), 'utf8'), '{}');
  assert.deepEqual(fs.readdirSync(t.pipe).sort(), ['lanes.json', 'node.env', 'queue', 'task-domains.json']);
  assert.equal((r.stdout.match(/^kept /gm) || []).length, QUEUES.length + 1);
  assert.doesNotMatch(r.stdout, /^created /m);
});

test('a re-run with another node id or repo directory rewrites node.env', () => {
  const t = tmp();
  assert.equal(provision(['grimm', t.pipe, t.repo]).status, 0);
  assert.equal(provision(['rack-2', t.pipe, `${t.repo}-b`]).status, 0);
  const env = read(path.join(t.pipe, 'node.env'));
  assert.match(env, /^AGENT_MANAGER_NODE_ID=rack-2$/m);
  assert.match(env, new RegExp(`^AGENT_MANAGER_REPO_ROOT=${t.repo}-b$`, 'm'));
});

test('an existing task-domains.json keeps its own domains and gains the missing standard ones, with a backup', () => {
  const t = tmp();
  fs.mkdirSync(t.pipe, { recursive: true });
  fs.writeFileSync(path.join(t.pipe, 'task-domains.json'), JSON.stringify({ custom: { workDirKind: 'x' } }));
  assert.equal(provision(['grimm', t.pipe, t.repo]).status, 0);
  const domains = JSON.parse(read(path.join(t.pipe, 'task-domains.json')));
  assert.deepEqual(domains.custom, { workDirKind: 'x' });
  assert.ok(domains.default && domains.adhoc);
  assert.ok(fs.readdirSync(t.pipe).some((f) => f.startsWith('task-domains.json.bak-')));
});

test('a task-domains.json that is not JSON stops the script with a failure and is left alone', () => {
  const t = tmp();
  fs.mkdirSync(t.pipe, { recursive: true });
  fs.writeFileSync(path.join(t.pipe, 'task-domains.json'), '{broken');
  const r = provision(['grimm', t.pipe, t.repo]);
  assert.notEqual(r.status, 0);
  assert.equal(read(path.join(t.pipe, 'task-domains.json')), '{broken');
  assert.equal(fs.existsSync(path.join(t.pipe, 'node.env')), false);
});

test('ids that are refused exit 2 with a message and create nothing: wok, uppercase first or later, underscore, 32 characters, leading dash, empty', () => {
  const t = tmp();
  for (const id of ['wok', 'Grimm', 'grImm', 'gri_mm', 'a'.repeat(32), '-grimm', '']) {
    const r = provision([id, t.pipe, t.repo]);
    assert.equal(r.status, 2, JSON.stringify(id));
    assert.match(r.stderr, /^provision-node: /);
    assert.equal(fs.existsSync(t.pipe), false, JSON.stringify(id));
  }
});

test('the shortest and the longest allowed ids are accepted', () => {
  for (const id of ['a', '0', 'a'.repeat(31), 'a-b-9']) {
    const t = tmp();
    assert.equal(provision([id, t.pipe, t.repo]).status, 0, id);
    assert.match(read(path.join(t.pipe, 'node.env')), new RegExp(`^AGENT_MANAGER_NODE_ID=${id}$`, 'm'));
  }
});

test('a missing or extra argument exits 2 with the usage line and creates nothing', () => {
  const t = tmp();
  for (const args of [[], ['grimm'], ['grimm', t.pipe], ['grimm', t.pipe, t.repo, 'extra'], ['grimm', '', t.repo], ['grimm', t.pipe, '']]) {
    const r = provision(args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.match(r.stderr, /usage|absolute/);
    assert.equal(fs.existsSync(t.pipe), false);
  }
});

test('a directory that is relative or holds a space, a quote, a dollar sign, a backtick or a newline is refused before anything is created', () => {
  const t = tmp();
  for (const bad of ['relative/dir', `${t.root}/with space`, `${t.root}/$(touch evil)`, `${t.root}/back\`tick`, `${t.root}/quo"te`, `${t.root}/new\nline`, `${t.root}/semi;colon`]) {
    for (const args of [['grimm', bad, t.repo], ['grimm', t.pipe, bad]]) {
      const r = provision(args);
      assert.equal(r.status, 2, JSON.stringify(args));
      assert.match(r.stderr, /absolute path/);
    }
  }
  assert.equal(fs.existsSync(t.pipe), false);
  assert.equal(fs.existsSync(path.join(t.root, 'evil')), false);
});
