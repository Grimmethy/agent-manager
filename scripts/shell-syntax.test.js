'use strict';

// Every shell script in scripts/ must parse. A script that does not parse fails only when something starts it, and the lane launcher starts
// scripts/local-worker.sh for every lane, so one bad character in a comment kept ALL lanes from starting after a restart (2026-11-14: an
// apostrophe in a comment inside a single-quoted node -e block of scripts/local-worker.sh). `bash -n` reads a script without running it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPTS_DIR = __dirname;

function syntaxProblem(file) {
  const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
  return r.status === 0 ? null : `${path.basename(file)}: ${String(r.stderr || '').trim().split('\n')[0] || `bash -n exited ${r.status}`}`;
}

test('the checker reports a script that does not parse', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-syntax-'));
  try {
    const bad = path.join(dir, 'bad.sh');
    fs.writeFileSync(bad, "node -e 'const a = 1; // the task's name\n  const b = (2);'\n");
    assert.match(syntaxProblem(bad), /^bad\.sh: /);
    const good = path.join(dir, 'good.sh');
    fs.writeFileSync(good, "echo 'fine'\n");
    assert.equal(syntaxProblem(good), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every scripts/*.sh file parses with bash -n', () => {
  const files = fs.readdirSync(SCRIPTS_DIR).filter((f) => f.endsWith('.sh')).sort().map((f) => path.join(SCRIPTS_DIR, f));
  assert.ok(files.length > 5, `expected the repo's shell scripts, found ${files.length}`);
  const problems = files.map(syntaxProblem).filter(Boolean);
  assert.deepEqual(problems, []);
});
