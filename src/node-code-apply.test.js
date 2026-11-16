'use strict';

// Tests for src/node-code-apply.js: fake deps for every branch, plus one end-to-end run on real temp repos.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { applyCode } = require('./node-code-apply.js');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const LATEST = { sha: SHA, bundle: 'repo-aaaaaaaa.bundle', branch: 'master' };

// Runs fn with a temp inbox directory holding latest.json (when content is given), then removes the directory.
function withInbox(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-inbox-'));
  try {
    if (content !== undefined) fs.writeFileSync(path.join(dir, 'latest.json'), content);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Fake deps: rev-parse answers the heads in order (the last one repeats); runStatus answers `status`. Every call is recorded.
function fakeDeps(heads, status = { status: 0, stdout: '' }) {
  const calls = { run: [], runStatus: [] };
  const queue = [...heads];
  return {
    calls,
    run(cmd, args) {
      calls.run.push([cmd, args]);
      const head = queue.length > 1 ? queue.shift() : queue[0];
      return `${head}\n`;
    },
    runStatus(cmd, args) {
      calls.runStatus.push([cmd, args]);
      return status;
    },
  };
}

test('current sha is a no-op: runStatus is never called', () => {
  withInbox(JSON.stringify(LATEST), (dir) => {
    const deps = fakeDeps([SHA]);
    assert.deepEqual(applyCode(dir, '/node', deps), { applied: false, reason: 'current', sha: SHA });
    assert.equal(deps.calls.runStatus.length, 0);
  });
});

test('exit 0 applies the bundle and checks HEAD against the sha', () => {
  withInbox(JSON.stringify(LATEST), (dir) => {
    const deps = fakeDeps([OTHER, SHA], { status: 0, stdout: `head=${SHA} dest=/node` });
    assert.deepEqual(applyCode(dir, '/node', deps), { applied: true, sha: SHA });
    assert.equal(deps.calls.runStatus.length, 1);
    const [cmd, args] = deps.calls.runStatus[0];
    assert.equal(cmd, path.join(SCRIPTS, 'import-repo-bundle.sh'));
    assert.deepEqual(args, [path.join(dir, LATEST.bundle), '/node', 'master']);
  });
});

test('exit 3 (dirty, other branch or diverged) returns the reason and changes nothing', () => {
  withInbox(JSON.stringify(LATEST), (dir) => {
    const deps = fakeDeps([OTHER], { status: 3, stdout: '' });
    assert.deepEqual(applyCode(dir, '/node', deps), { applied: false, reason: 'dirty-or-diverged' });
    assert.equal(deps.calls.runStatus.length, 1);
    assert.equal(deps.calls.run.length, 1);
  });
});

test('exit 2 (refused) throws', () => {
  withInbox(JSON.stringify(LATEST), (dir) => {
    const deps = fakeDeps([OTHER], { status: 2, stdout: 'refused' });
    assert.throws(() => applyCode(dir, '/node', deps), /applyCode: import-repo-bundle.sh exited 2: refused/);
  });
});

test('a timeout or signal (null status) throws', () => {
  withInbox(JSON.stringify(LATEST), (dir) => {
    const deps = fakeDeps([OTHER], { status: null, stdout: '' });
    assert.throws(() => applyCode(dir, '/node', deps), /exited null/);
  });
});

test('HEAD that does not match the sha after exit 0 throws', () => {
  withInbox(JSON.stringify(LATEST), (dir) => {
    const deps = fakeDeps([OTHER, OTHER], { status: 0, stdout: '' });
    assert.throws(() => applyCode(dir, '/node', deps), /HEAD is .* after the import/);
  });
});

test('a bundle name with a slash is refused before anything runs', () => {
  withInbox(JSON.stringify({ ...LATEST, bundle: 'sub/repo.bundle' }), (dir) => {
    const deps = fakeDeps([OTHER]);
    assert.throws(() => applyCode(dir, '/node', deps), /plain file name/);
    assert.equal(deps.calls.runStatus.length, 0);
  });
});

test('a bundle name with .. is refused before anything runs', () => {
  withInbox(JSON.stringify({ ...LATEST, bundle: 'repo..bundle' }), (dir) => {
    const deps = fakeDeps([OTHER]);
    assert.throws(() => applyCode(dir, '/node', deps), /plain file name/);
    assert.equal(deps.calls.runStatus.length, 0);
  });
});

test('a bundle name that is empty is refused before anything runs', () => {
  withInbox(JSON.stringify({ ...LATEST, bundle: '' }), (dir) => {
    const deps = fakeDeps([OTHER]);
    assert.throws(() => applyCode(dir, '/node', deps), /bundle must be a plain file name/);
    assert.equal(deps.calls.runStatus.length, 0);
  });
});

test('a latest.json whose JSON is a number or a string (not an object) is refused', () => {
  for (const content of ['42', '"text"']) {
    withInbox(content, (dir) => {
      const deps = fakeDeps([OTHER]);
      assert.throws(() => applyCode(dir, '/node', deps), /latest\.json is not an object/);
      assert.equal(deps.calls.runStatus.length, 0);
    });
  }
});

test('a missing latest.json is refused', () => {
  withInbox(undefined, (dir) => {
    assert.throws(() => applyCode(dir, '/node', fakeDeps([OTHER])), /missing or unparsable/);
  });
});

test('an unparsable latest.json is refused', () => {
  withInbox('{not json', (dir) => {
    assert.throws(() => applyCode(dir, '/node', fakeDeps([OTHER])), /missing or unparsable/);
  });
});

test('a latest.json that is not an object is refused', () => {
  withInbox('null', (dir) => {
    assert.throws(() => applyCode(dir, '/node', fakeDeps([OTHER])), /not an object/);
  });
});

test('a latest.json whose sha is not 40 lowercase hex is refused', () => {
  for (const sha of ['A'.repeat(40), 'a'.repeat(39), 'g'.repeat(40), 'a'.repeat(41)]) {
    withInbox(JSON.stringify({ ...LATEST, sha }), (dir) => {
      const deps = fakeDeps([OTHER]);
      assert.throws(() => applyCode(dir, '/node', deps), /sha must be 40 lowercase hex/);
      assert.equal(deps.calls.runStatus.length, 0);
    });
  }
});

function git(args, cwd) {
  return childProcess.execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function script(name, args) {
  return childProcess.execFileSync(path.join(SCRIPTS, name), args, { encoding: 'utf8' }).trim();
}

test('end to end: publish, import onto a clone, commit, publish again, apply', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-e2e-'));
  try {
    const source = path.join(root, 'source-repo');
    const inbox = path.join(root, 'inbox');
    const node = path.join(root, 'node');
    fs.mkdirSync(source);
    git(['init', '-q', '-b', 'master'], source);
    const commit = (msg) => {
      fs.writeFileSync(path.join(source, 'f.txt'), msg);
      git(['add', 'f.txt'], source);
      git(['-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '-q', '-m', msg], source);
      return git(['rev-parse', 'HEAD'], source);
    };
    // Publishes the branch into inbox with export-repo-bundle.sh and points latest.json at it; returns the bundle path.
    const publish = () => {
      const out = script('export-repo-bundle.sh', [source, inbox, 'master']);
      const m = /^bundle=([^ ]+) sha=([0-9a-f]{40}) branch=master$/.exec(out);
      assert.ok(m, out);
      fs.writeFileSync(path.join(inbox, 'latest.json'), JSON.stringify({ sha: m[2], bundle: path.basename(m[1]), branch: 'master' }));
      return m[1];
    };
    const first = commit('one');
    const bundle = publish();
    script('import-repo-bundle.sh', [bundle, node, 'master']);
    assert.equal(git(['rev-parse', 'HEAD'], node), first);
    assert.deepEqual(applyCode(inbox, node), { applied: false, reason: 'current', sha: first });
    const second = commit('two');
    publish();
    assert.deepEqual(applyCode(inbox, node), { applied: true, sha: second });
    assert.equal(git(['rev-parse', 'HEAD'], node), second);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
