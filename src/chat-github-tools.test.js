'use strict';

// The read-only GitHub tools as CHAT sees them: registered once in CHAT_TOOLS only, handlers wired with the argument shapes github-readonly.js really takes,
// and AGENT_MANAGER_CHAT_GITHUB=off removing tools AND handlers without breaking the rest of the module. The client itself is tested in github-readonly.test.js.
// Run: node --test src/chat-github-tools.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GITHUB_NAMES = ['github_list_contents', 'github_read_file', 'github_recent_commits', 'github_repo_overview', 'github_search_code', 'github_search_repos'];

function load(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-github-tools-'));
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  delete require.cache[require.resolve('./local-tool-client.js')];
  return { mod: require('./local-tool-client.js'), dir };
}

test('the six GitHub tools are in CHAT_TOOLS exactly once and never in the pipeline worker lists', () => {
  const { mod } = load();
  const chat = mod.CHAT_TOOLS.map((t) => t.function.name);
  for (const n of GITHUB_NAMES) assert.equal(chat.filter((x) => x === n).length, 1, `${n} registered once`);
  assert.equal(new Set(chat).size, chat.length, 'no duplicate tool names in CHAT_TOOLS');
  for (const list of [mod.TOOLS, mod.WRITE_TOOLS]) {
    const names = list.map((t) => t.function.name);
    for (const n of GITHUB_NAMES) assert.ok(!names.includes(n), `${n} must not be visible to pipeline workers`);
  }
});

test('every GitHub tool has a handler on the chat set and none on the worker set', () => {
  const { mod, dir } = load();
  const chat = mod.buildChatToolHandlers([dir], dir, dir);
  const worker = mod.buildWriteToolHandlers([dir], dir);
  for (const n of GITHUB_NAMES) {
    assert.equal(typeof chat[n], 'function', n);
    assert.equal(worker[n], undefined, n);
  }
});

test('handlers pass sort, perPage, path and ref through to the real GitHub requests', async () => {
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const body = /search\/repositories/.test(url) ? { total_count: 0, items: [] } : /commits/.test(url) ? [] : { type: 'file', encoding: 'base64', content: Buffer.from('hello').toString('base64'), size: 5 };
    return { ok: true, status: 200, headers: new Map(), json: async () => body, text: async () => JSON.stringify(body) };
  };
  try {
    const { mod, dir } = load();
    const h = mod.buildChatToolHandlers([dir], dir, dir);
    await h.github_search_repos({ query: 'forge', sort: 'updated', perPage: 3 });
    await h.github_recent_commits({ owner: 'o', repo: 'r', perPage: 4, path: 'src/a.js' });
    await h.github_read_file({ owner: 'o', repo: 'r', path: 'README.md', ref: 'v1.0.0' });
    assert.ok(urls.some((u) => u.includes('search/repositories') && u.includes('sort=updated') && u.includes('per_page=3')), urls.join('\n'));
    assert.ok(urls.some((u) => u.includes('/commits') && u.includes('per_page=4') && u.includes('path=src')), urls.join('\n'));
    assert.ok(urls.some((u) => u.includes('/contents/README.md?ref=v1.0.0')), urls.join('\n'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('invalid owner, repo or path is answered as text and no request is made', async () => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error('must not be called'); };
  try {
    const { mod, dir } = load();
    const h = mod.buildChatToolHandlers([dir], dir, dir);
    assert.match(await h.github_repo_overview({ owner: 'a b', repo: 'r' }), /invalid owner/);
    assert.match(await h.github_read_file({ owner: 'o', repo: 'r', path: '../etc/passwd' }), /must not contain/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('AGENT_MANAGER_CHAT_GITHUB=off removes the tools and handlers, and the module still loads with every other chat tool', () => {
  const out = execFileSync('node', ['-e', `
    process.env.AGENT_MANAGER_REPO_ROOT = process.env.AGENT_MANAGER_PIPELINE_DIR = require('os').tmpdir();
    const m = require('./src/local-tool-client.js');
    const names = m.CHAT_TOOLS.map((t) => t.function.name);
    const handlers = Object.keys(m.buildChatToolHandlers(['/tmp'], '/tmp', '/tmp'));
    console.log(JSON.stringify({ github: names.filter((n) => n.startsWith('github')), handlers: handlers.filter((n) => n.startsWith('github')), hasRunBash: names.includes('run_bash'), hasHandlerRunBash: handlers.includes('run_bash'), exported: typeof m.buildChatToolHandlers }));
  `], { cwd: path.join(__dirname, '..'), env: { ...process.env, AGENT_MANAGER_CHAT_GITHUB: 'off' }, encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.deepEqual(r, { github: [], handlers: [], hasRunBash: true, hasHandlerRunBash: true, exported: 'function' });
});

test('any other value of AGENT_MANAGER_CHAT_GITHUB keeps the tools on (exact match on off only)', () => {
  const out = execFileSync('node', ['-e', `
    process.env.AGENT_MANAGER_REPO_ROOT = process.env.AGENT_MANAGER_PIPELINE_DIR = require('os').tmpdir();
    console.log(require('./src/local-tool-client.js').CHAT_TOOLS.filter((t) => t.function.name.startsWith('github')).length);
  `], { cwd: path.join(__dirname, '..'), env: { ...process.env, AGENT_MANAGER_CHAT_GITHUB: 'OFF' }, encoding: 'utf8' });
  assert.equal(out.trim().split('\n').pop(), '6');
});
