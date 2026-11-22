'use strict';

// propose_command and the allowlist reader (proposal side of the chat write-command feature, 2026-10-25). Run: node --test src/chat-command-allowlist.test.js
// Nothing here runs a command: proposing only records a proposal.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadAllowlist, findEntry, proposeCommand, proposalsFromToolLog, MAX_TIMEOUT_S, DEFAULT_TIMEOUT_S } = require('./chat-command-allowlist.js');

const ARGV = ['python3', '-m', 'inventory', 'sales', 'email'];

function world(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-command-allowlist-'));
  const repo = path.join(root, 'inventory-plugin');
  fs.mkdirSync(repo);
  const pipelineDir = path.join(root, 'pipeline');
  fs.mkdirSync(path.join(pipelineDir, 'queue'), { recursive: true });
  const file = path.join(root, 'command-allowlist.json');
  fs.writeFileSync(file, JSON.stringify({ commands: (entries || [{ repo, argv: ARGV, env: { PYTHONPATH: 'src' }, timeoutSeconds: 300 }]).map((e) => ({ ...e, repo: e.repo === 'REPO' ? repo : e.repo })) }));
  return { root, repo, pipelineDir, file };
}

test('loadAllowlist reads valid entries with the repo as a realpath, defaults and a clamped timeout', () => {
  const w = world([{ repo: 'REPO', argv: ARGV }, { repo: 'REPO', argv: ['a'], timeoutSeconds: 99999 }]);
  const list = loadAllowlist(w.file);
  assert.equal(list.length, 2);
  assert.equal(list[0].repo, fs.realpathSync(w.repo));
  assert.deepEqual([list[0].env, list[0].timeoutSeconds], [{}, DEFAULT_TIMEOUT_S]);
  assert.equal(list[1].timeoutSeconds, MAX_TIMEOUT_S);
});

test('a missing, unreadable or malformed allowlist file is empty, and invalid entries are skipped', () => {
  const w = world();
  assert.deepEqual(loadAllowlist(path.join(w.root, 'nope.json')), []);
  const bad = path.join(w.root, 'bad.json');
  for (const content of ['{not json', '[]', JSON.stringify({ commands: 'x' }), JSON.stringify({ commands: [
    { repo: w.repo, argv: [] }, { repo: 'relative', argv: ARGV }, { repo: w.repo, argv: [1] }, { repo: w.repo, argv: ARGV, env: { A: 1 } },
    { repo: w.repo, argv: ARGV, timeoutSeconds: '9' }, null, 'x',
  ] })]) {
    fs.writeFileSync(bad, content);
    assert.deepEqual(loadAllowlist(bad), [], content);
  }
});

test('findEntry needs the repo realpath and the argv to be exactly equal', () => {
  const w = world();
  const list = loadAllowlist(w.file);
  assert.ok(findEntry(list, w.repo, [...ARGV]));
  const link = path.join(w.root, 'link');
  fs.symlinkSync(w.repo, link);
  assert.ok(findEntry(list, link, [...ARGV]), 'a symlink to the repo matches by realpath');
  for (const argv of [[...ARGV, 'x'], ARGV.slice(0, 4), ['python3', '-m', 'inventory', 'sales', 'email '], 'python3 -m inventory sales email', null]) {
    assert.equal(findEntry(list, w.repo, argv), null);
  }
  assert.equal(findEntry(list, path.join(w.root, 'elsewhere'), [...ARGV]), null);
});

test('proposeCommand accepts an allowlisted command as a proposal that says nothing has run', () => {
  const w = world();
  const r = proposeCommand({ repo: w.repo, argv: ARGV, why: ' ingest the newest eBay sale emails ' }, { pipelineDir: w.pipelineDir, allowlistFile: w.file });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'awaiting-confirmation');
  assert.match(r.proposalId, /^cmd-\d+-[0-9a-f]{8}$/);
  assert.deepEqual(r.proposal, { proposalId: r.proposalId, repo: fs.realpathSync(w.repo), argv: ARGV, why: 'ingest the newest eBay sale emails' });
  assert.match(r.message, /NOTHING has run/);
  assert.equal(JSON.stringify(r).includes('PYTHONPATH'), false, 'the allowlist env is never shown to the model');
  const second = proposeCommand({ repo: w.repo, argv: ARGV, why: 'again' }, { pipelineDir: w.pipelineDir, allowlistFile: w.file });
  assert.notEqual(second.proposalId, r.proposalId);
});

test('proposeCommand refuses an unlisted command and names what is allowed for that repo; another repo has nothing allowed', () => {
  const w = world();
  const ctx = { pipelineDir: w.pipelineDir, allowlistFile: w.file };
  const r = proposeCommand({ repo: w.repo, argv: ['python3', '-m', 'inventory', 'sales', 'square'], why: 'x' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /not on the owner's allowlist/);
  assert.ok(r.error.includes(JSON.stringify([ARGV])));
  assert.equal(r.proposal, undefined);
  const other = proposeCommand({ repo: path.join(w.root, 'other'), argv: ARGV, why: 'x' }, ctx);
  assert.match(other.error, /No command is allowed for that repo/);
});

test('proposeCommand refuses bad arguments and the kill switch', () => {
  const w = world();
  const ctx = { pipelineDir: w.pipelineDir, allowlistFile: w.file };
  assert.match(proposeCommand({ argv: ARGV, why: 'x' }, ctx).error, /repo is required/);
  assert.match(proposeCommand({ repo: w.repo, argv: [], why: 'x' }, ctx).error, /argv must be/);
  assert.match(proposeCommand({ repo: w.repo, argv: 'python3 -m inventory', why: 'x' }, ctx).error, /argv must be/);
  assert.match(proposeCommand({ repo: w.repo, argv: ARGV, why: '  ' }, ctx).error, /why is required/);
  assert.match(proposeCommand(undefined, ctx).error, /repo is required/);
  fs.writeFileSync(path.join(w.pipelineDir, 'queue', '.chat-write-tools-disabled'), '');
  assert.match(proposeCommand({ repo: w.repo, argv: ARGV, why: 'x' }, ctx).error, /switched off/);
});

test('proposalsFromToolLog returns only the accepted proposals, in call order', () => {
  const w = world();
  const ctx = { pipelineDir: w.pipelineDir, allowlistFile: w.file };
  const ok1 = proposeCommand({ repo: w.repo, argv: ARGV, why: 'one' }, ctx);
  const refused = proposeCommand({ repo: w.repo, argv: ['x'], why: 'two' }, ctx);
  const ok2 = proposeCommand({ repo: w.repo, argv: ARGV, why: 'three' }, ctx);
  const log = [{ tool: 'read_file', args: {}, result: { ok: true } }, { tool: 'propose_command', args: {}, result: ok1 }, { tool: 'propose_command', args: {}, result: refused }, null, { tool: 'propose_command', args: {}, result: ok2 }];
  assert.deepEqual(proposalsFromToolLog(log).map((p) => p.why), ['one', 'three']);
  assert.deepEqual(proposalsFromToolLog(undefined), []);
});
