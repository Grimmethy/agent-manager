'use strict';

// archived-dirs.js and the three core walkers that use it (fact-checker findByBasename, grep-codebase-tool, file-grounding relocateStaleAnchor):
// a directory named archive / archived is never walked, so retired code neither gets cited as live nor makes a live lookup look ambiguous.
// Run: node --test src/lib/archived-dirs.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isArchivedDirName } = require('./archived-dirs.js');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

test('isArchivedDirName: archive / archived, any case, optional leading underscore -- and nothing that merely contains the word', () => {
  for (const n of ['archive', 'archived', 'Archive', 'ARCHIVED', '_archive', '_archived']) assert.equal(isArchivedDirName(n), true, n);
  for (const n of ['archives', 'archiver', 'my-archive', 'archive2', 'src', '', null, undefined, '.archive']) assert.equal(isArchivedDirName(n), false, String(n));
});

test('findByBasename: a second copy of the file under archive/ no longer makes the live one look ambiguous', () => {
  const { findByBasename } = require('../fact-checker.js');
  const root = tmp('arch-fc-');
  put(root, 'src/thing.js', 'live');
  put(root, 'archive/client/backend/thing.js', 'archived copy');
  put(root, 'Archived/deep/thing.js', 'another archived copy');
  assert.deepEqual(findByBasename(root, 'thing.js'), [path.join(root, 'src', 'thing.js')]);
  // a directory that merely resembles the word is still walked
  put(root, 'archives/thing.js', 'a real dir called archives');
  assert.equal(findByBasename(root, 'thing.js').length, 2);
});

test('grepCodebase: a whole-repo walk skips archive/ (retired code is not a hit); the live hit stays', () => {
  const { grepCodebase } = require('../grep-codebase-tool.js');
  const root = tmp('arch-grep-');
  put(root, 'src/worker.js', 'function draftTask(task) { return 1; }\n');
  put(root, 'archive/old/worker.js', 'function draftTask(task) { return 2; }\n');
  const prev = { r: process.env.AGENT_MANAGER_REPO_ROOT, d: process.env.AGENT_MANAGER_GREP_DIRS };
  process.env.AGENT_MANAGER_REPO_ROOT = root;
  delete process.env.AGENT_MANAGER_GREP_DIRS;
  try {
    const hits = grepCodebase({ query: 'draftTask' });
    const files = [...new Set(hits.map((h) => String(h.file || h.path || '')))];
    assert.ok(files.some((f) => f.endsWith(path.join('src', 'worker.js'))), JSON.stringify(files));
    assert.ok(!files.some((f) => /archive/i.test(f)), `archive was walked: ${JSON.stringify(files)}`);
  } finally {
    if (prev.r === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = prev.r;
    if (prev.d === undefined) delete process.env.AGENT_MANAGER_GREP_DIRS; else process.env.AGENT_MANAGER_GREP_DIRS = prev.d;
  }
});

test('relocateStaleAnchor: the cited code moved to ONE live file; an archived copy of it no longer makes the relocation ambiguous', () => {
  const { relocateStaleAnchor } = require('../sdk/lib/file-grounding.js');
  const root = tmp('arch-reloc-');
  const block = Array.from({ length: 12 }, (_, i) => `  const value${i} = compute(${i}) + offset; // distinctive line ${i}`).join('\n');
  const body = `function bigBody(opts) {\n${block}\n  return opts;\n}`;
  put(root, 'src/old.js', 'function stillHere() { return 1; }\n');
  put(root, 'src/lib/moved.js', `// live\n${body}\n`);
  put(root, 'src/archive/oldcopy.js', `// archived copy\n${body}\n`);
  const section = `### AC-10 · Decompose bigBody\nFiles: src/old.js\nSnippet:\n\`\`\`\n${body}\n\`\`\`\n`;
  const hit = relocateStaleAnchor(root, 'src/old.js', section);
  assert.ok(hit, 'the unique live file is found');
  assert.equal(hit.path, 'src/lib/moved.js');
});
