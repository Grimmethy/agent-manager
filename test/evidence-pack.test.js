'use strict';

// HUB0274-01: src/evidence-pack.js runs git without a shell, inside the repo being checked, and separates cited paths from cited identifiers.
// Every test builds its own temp git repo; nothing touches the live repo or queue.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildEvidencePack, extractPaths, extractIdentifiers } = require('../src/evidence-pack.js');

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// -> { repo, sha } a temp repo with two commits: src/foo.js (with two identifiers) then docs/note.md.
function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-pack-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'foo.js'), 'function computeTotal() {}\nconst abcd$ = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'add foo with computeTotal');
  fs.mkdirSync(path.join(repo, 'docs'));
  fs.writeFileSync(path.join(repo, 'docs', 'note.md'), '# note\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'add the note');
  return { repo, sha: git(repo, 'rev-parse', 'HEAD') };
}

test('a cited existing path reports exists true and its commit subject', () => {
  const { repo, sha } = makeRepo();
  const pack = buildEvidencePack({ rawText: 'see `src/foo.js` please' }, sha, 3000, { repoRoot: repo });
  assert.equal(pack.citedPaths.length, 1);
  assert.equal(pack.citedPaths[0].path, 'src/foo.js');
  assert.equal(pack.citedPaths[0].exists, true);
  assert.match(pack.citedPaths[0].commits.join('\n'), /add foo with computeTotal/);
});

test('a cited missing path reports exists false and no commits', () => {
  const { repo, sha } = makeRepo();
  const pack = buildEvidencePack({ rawText: 'see `src/gone.js`' }, sha, 3000, { repoRoot: repo });
  assert.equal(pack.citedPaths[0].exists, false);
  assert.deepEqual(pack.citedPaths[0].commits, []);
});

test('a path with a :line suffix is looked up without the suffix', () => {
  const { repo, sha } = makeRepo();
  const pack = buildEvidencePack({ rawText: 'at `src/foo.js:12-20`' }, sha, 3000, { repoRoot: repo });
  assert.equal(pack.citedPaths[0].path, 'src/foo.js');
  assert.equal(pack.citedPaths[0].exists, true);
});

test('a cited identifier that exists in a file gives a grep hit, a missing one gives none', () => {
  const { repo, sha } = makeRepo();
  const pack = buildEvidencePack({ rawText: 'calls `computeTotal()` and `neverDefined`' }, sha, 3000, { repoRoot: repo });
  const byName = Object.fromEntries(pack.citedIdentifiers.map((c) => [c.identifier, c.hits]));
  assert.ok(byName.computeTotal.length >= 1);
  assert.match(byName.computeTotal[0], /src\/foo\.js:1:/);
  assert.deepEqual(byName.neverDefined, []);
});

test('regex characters in an identifier are matched literally (git grep -F)', () => {
  const { repo, sha } = makeRepo();
  const pack = buildEvidencePack({ rawText: 'uses `abcd$` somewhere' }, sha, 3000, { repoRoot: repo });
  assert.equal(pack.citedIdentifiers[0].identifier, 'abcd$');
  assert.ok(pack.citedIdentifiers[0].hits.length >= 1, 'a literal match of abcd$ in src/foo.js (as a regex the trailing $ would be an end-of-line anchor)');
});

test('a path is not also looked up as an identifier, and tokens that are neither are ignored', () => {
  assert.deepEqual(extractPaths('`src/foo.js` `computeTotal` `$(touch X)` `a b`'), ['src/foo.js']);
  assert.deepEqual(extractIdentifiers('`src/foo.js` `computeTotal()` `$(touch X)` `a b` `abc`'), ['computeTotal']);
});

test('at most four paths and four identifiers are kept, deduplicated', () => {
  const text = [1, 2, 3, 4, 5, 6].map((n) => `\`src/f${n}.js\``).join(' ') + ' `src/f1.js` ' + ['alphaOne', 'alphaTwo', 'alphaThree', 'alphaFour', 'alphaFive'].map((n) => `\`${n}\``).join(' ');
  assert.equal(extractPaths(text).length, 4);
  assert.equal(extractIdentifiers(text).length, 4);
});

test('entry text with shell syntax in backticks creates no file and runs nothing', () => {
  const { repo, sha } = makeRepo();
  const marker = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-pack-marker-'));
  const m1 = path.join(marker, 'PWNED');
  const m2 = path.join(marker, 'PWNED2');
  const text = `cites \`$(touch ${m1})\` and \`"; touch ${m2}; "\` and \`src/foo.js\``;
  const pack = buildEvidencePack({ rawText: text }, sha, 3000, { repoRoot: repo });
  assert.equal(fs.existsSync(m1), false);
  assert.equal(fs.existsSync(m2), false);
  assert.equal(pack.citedIdentifiers.length, 0);
  assert.equal(pack.citedPaths.length, 1);
});

test('a master sha that looks like a git option is refused instead of passed to git', () => {
  const { repo } = makeRepo();
  const pack = buildEvidencePack({ rawText: 'see `src/foo.js` and `computeTotal`' }, '--output=PWNED', 3000, { repoRoot: repo });
  assert.equal(pack.citedPaths[0].exists, false);
  assert.deepEqual(pack.citedIdentifiers[0].hits, []);
  assert.equal(fs.existsSync(path.join(repo, 'PWNED')), false);
});

test('the pack JSON stays within the cap for an oversized entry', () => {
  const { repo, sha } = makeRepo();
  const pack = buildEvidencePack({ rawText: 'x'.repeat(5000) }, sha, 3000, { repoRoot: repo });
  assert.ok(JSON.stringify(pack).length <= 3000);
});

test('a repoRoot that is not a git repo gives empty results and does not throw', () => {
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-pack-norepo-'));
  const pack = buildEvidencePack({ rawText: 'see `src/foo.js` and `computeTotal`', capturedAt: '2026-10-01T00:00:00Z' }, 'abc1234', 3000, { repoRoot: notRepo });
  assert.equal(pack.citedPaths[0].exists, false);
  assert.deepEqual(pack.citedPaths[0].commits, []);
  assert.deepEqual(pack.citedIdentifiers[0].hits, []);
  assert.deepEqual(pack.recentCommits, []);
});

test('commits since capturedAt that touched the cited files are listed', () => {
  const { repo, sha } = makeRepo();
  const pack = buildEvidencePack({ rawText: 'see `docs/note.md`', capturedAt: '2000-01-01T00:00:00Z' }, sha, 3000, { repoRoot: repo });
  assert.match(pack.recentCommits.join('\n'), /add the note/);
  const bad = buildEvidencePack({ rawText: 'see `docs/note.md`', capturedAt: 'not a date' }, sha, 3000, { repoRoot: repo });
  assert.deepEqual(bad.recentCommits, []);
});
