'use strict';

// Guard for a class of miss found 2026-09-26: HUB0022 deleted python/build_graph.py after re-pointing every Python `import`, but two
// callers ran it BY PATH -- scripts/queue-watcher.sh (the daily graph rebuild) and src/task-sources.js (deep_dive onboarding) -- and
// nothing noticed, because an `import` grep cannot see a subprocess path. A file a script or module launches must exist.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function nonTestJsFiles() {
  return fs.readdirSync(__dirname).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).map((f) => path.join(__dirname, f));
}

test('every python script src/*.js launches via path.join(__dirname, "..", "python", "<x>.py") exists', () => {
  const missing = [];
  let seen = 0;
  for (const file of nonTestJsFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/path\.join\(__dirname,\s*'\.\.',\s*'python',\s*'([\w.-]+\.py)'\)/g)) {
      seen++;
      if (!fs.existsSync(path.join(ROOT, 'python', m[1]))) missing.push(`${path.basename(file)} -> python/${m[1]}`);
    }
  }
  assert.ok(seen > 0, 'the pattern should match at least the deep_dive graph build (else this guard has gone blind)');
  assert.deepEqual(missing, []);
});

test('every python script scripts/*.sh runs via "${SCRIPT_DIR}/../python/<x>.py" exists', () => {
  const dir = path.join(ROOT, 'scripts');
  const missing = [];
  let seen = 0;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.sh'))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (line.trim().startsWith('#')) continue;
      for (const m of line.matchAll(/\$\{SCRIPT_DIR\}\/\.\.\/python\/([\w.-]+\.py)/g)) {
        seen++;
        if (!fs.existsSync(path.join(ROOT, 'python', m[1]))) missing.push(`${f} -> python/${m[1]}`);
      }
    }
  }
  assert.ok(seen > 0, 'the pattern should match at least the daily graph rebuild in queue-watcher.sh');
  assert.deepEqual(missing, []);
});
