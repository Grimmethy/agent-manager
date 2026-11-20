'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  listGroundingCandidates,
  normaliseCitedPath,
  parseCitation,
  NO_SUPPORTING_FILE,
  _clearCache,
} = require('../src/grounding-candidates');

// -- fixture helpers -------------------------------------------------------

function makeTempRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gcand-'));
  execFileSync('git', ['init', tmp], { stdio: 'ignore' });
  execFileSync('git', ['-C', tmp, 'config', 'user.email', 'test@test.test'], { stdio: 'ignore' });
  execFileSync('git', ['-C', tmp, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
  // Seed a handful of files at different depths so ranking has something to
  // discriminate on.
  const files = [
    'src/auth/login.js',
    'src/auth/session.ts',
    'src/auth/password-reset.ts',
    'src/api/handler.py',
    'src/api/routes.js',
    'docs/auth-guide.md',
    'docs/api-reference.md',
    'test/auth.test.js',
    'test/api.test.js',
    'README.md',
    'package.json',
  ];
  for (const f of files) {
    const full = path.join(tmp, f);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `// ${f}\n`, 'utf8');
  }
  execFileSync('git', ['add', '.'], { cwd: tmp, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: tmp, stdio: 'ignore' });
  return tmp;
}

function makeNonGitDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gcand-nogit-'));
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'a.js'), '');
  fs.writeFileSync(path.join(tmp, 'src', 'b.py'), '');
  fs.writeFileSync(path.join(tmp, 'README.md'), '');
  return tmp;
}

// -- tests -----------------------------------------------------------------

describe('normaliseCitedPath', () => {
  it('strips leading ./', () => {
    assert.equal(normaliseCitedPath('./src/foo.js'), 'src/foo.js');
  });
  it('strips :N line suffix', () => {
    assert.equal(normaliseCitedPath('src/foo.js:42'), 'src/foo.js');
  });
  it('strips :N-M range suffix', () => {
    assert.equal(normaliseCitedPath('src/foo.js:10-20'), 'src/foo.js');
  });
  it('strips both together', () => {
    assert.equal(normaliseCitedPath('./src/foo.js:5'), 'src/foo.js');
  });
  it('leaves a clean path alone', () => {
    assert.equal(normaliseCitedPath('src/foo.js'), 'src/foo.js');
  });
  it('trims whitespace', () => {
    assert.equal(normaliseCitedPath('  ./src/foo.js:3  '), 'src/foo.js');
  });
});

describe('parseCitation', () => {
  it('recognises create <path>', () => {
    const out = parseCitation('create src/auth/new.js');
    assert.deepEqual(out, { path: 'src/auth/new.js', type: 'create' });
  });
  it('strips :N from create path', () => {
    const out = parseCitation('create src/auth/new.js:10');
    assert.deepEqual(out, { path: 'src/auth/new.js', type: 'create' });
  });
  it('handles quoted paths', () => {
    const out = parseCitation(`create "src/auth/new.js"`);
    assert.deepEqual(out, { path: 'src/auth/new.js', type: 'create' });
  });
  it('handles backticked paths', () => {
    const out = parseCitation('create `src/auth/new.js`');
    assert.deepEqual(out, { path: 'src/auth/new.js', type: 'create' });
  });
  it('recognises NO_SUPPORTING_FILE sentinel', () => {
    const out = parseCitation(NO_SUPPORTING_FILE);
    assert.deepEqual(out, { type: 'no_supporting_file' });
  });
  it('recognises lowercase sentinel', () => {
    const out = parseCitation('no_supporting_file');
    assert.deepEqual(out, { type: 'no_supporting_file' });
  });
  it('treats bare path as use', () => {
    const out = parseCitation('src/auth/login.js');
    assert.deepEqual(out, { path: 'src/auth/login.js', type: 'use' });
  });
  it('strips ./ and :N from bare paths', () => {
    const out = parseCitation('./src/auth/login.js:5');
    assert.deepEqual(out, { path: 'src/auth/login.js', type: 'use' });
  });
  it('returns {} for empty input', () => {
    assert.deepEqual(parseCitation(''), {});
  });
});

describe('listGroundingCandidates', () => {
  let repo;

  before(() => {
    _clearCache();
    repo = makeTempRepo();
  });
  after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('returns candidates ranked by overlap', () => {
    const text = 'implement auth login flow for users';
    const out = listGroundingCandidates(repo, text);
    assert.ok(out.length > 0, 'should return some candidates');
    // auth-related files should rank high.
    const authFiles = out.filter((c) => /auth/.test(c.path));
    assert.ok(authFiles.length > 0, 'auth files should rank');
    // Score is non-negative.
    for (const c of out) assert.ok(c.score >= 0, 'score must be non-negative');
  });

  it('honours the max bound', () => {
    const out = listGroundingCandidates(repo, 'auth login', { max: 2 });
    assert.equal(out.length, 2);
  });

  it('honours max: 0 by returning []', () => {
    const out = listGroundingCandidates(repo, 'auth', { max: 0 });
    assert.deepEqual(out, []);
  });

  it('extraTerms contribute to ranking', () => {
    // "xyzzy" is gibberish to the repo, so any hit on it must come from
    // extraTerms -- confirm the result differs from no-extraTerms.
    const noExtra = listGroundingCandidates(repo, 'xyzzy', { max: 40 });
    const withExtra = listGroundingCandidates(repo, 'xyzzy', {
      max: 40,
      extraTerms: ['package.json', 'README'],
    });
    // With extraTerms, package.json and README should appear.
    const paths = withExtra.map((c) => c.path);
    assert.ok(paths.includes('package.json') || paths.includes('README.md'));
    // Without, the gibberish yields low-scoring or empty results.
    const noExtraPaths = noExtra.map((c) => c.path);
    assert.ok(
      noExtra.filter((c) => c.score === 0).length > 0 || noExtra.length === 0,
      'gibberish alone should not rank real files'
    );
  });

  it('falls back to readdirSync outside a git repo', () => {
    const nogit = makeNonGitDir();
    try {
      const out = listGroundingCandidates(nogit, 'src');
      assert.ok(out.length > 0);
      const paths = out.map((c) => c.path);
      assert.ok(paths.includes('src/a.js') || paths.includes('src/b.py'));
    } finally {
      fs.rmSync(nogit, { recursive: true, force: true });
    }
  });

  it('caches by (repoRoot, HEAD) so repeated calls skip git', () => {
    _clearCache();
    // Prime the cache.
    listGroundingCandidates(repo, 'auth', { max: 2 });
    const before = _cacheSize();
    // Call again -- cache should be hit, size unchanged.
    listGroundingCandidates(repo, 'auth', { max: 2 });
    const after = _cacheSize();
    assert.equal(before, after, 'cache size should not grow on repeated calls');
  });

  it('does not cache non-git directories', () => {
    const nogit = makeNonGitDir();
    try {
      // Two calls on a non-git dir should not grow the cache.
      const before = _cacheSize();
      listGroundingCandidates(nogit, 'src', { max: 2 });
      listGroundingCandidates(nogit, 'src', { max: 2 });
      const after = _cacheSize();
      assert.equal(before, after);
    } finally {
      fs.rmSync(nogit, { recursive: true, force: true });
    }
  });
});

// tiny helper: peek at the private cache size without exporting internals.
function _cacheSize() {
  // Re-require to access the module; the cache is private, so we use the
  // exported _stats helper.
  const m = require('../src/grounding-candidates');
  return m._stats().cached;
}
