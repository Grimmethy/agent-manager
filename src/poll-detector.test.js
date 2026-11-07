'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const cli = require('./poll-detector.js');

// In-process main() with captured output (fast; for cases that need no child process).
function inProcess(args, config) {
  let stdout = '';
  let stderr = '';
  const code = cli.main(args, { stdout: { write: (t) => { stdout += t; } }, stderr: { write: (t) => { stderr += t; } } }, config);
  return { code, stdout, stderr };
}

const CLI = path.join(__dirname, 'poll-detector.js');
const run = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });
const json = (r) => JSON.parse(r.stdout);

// A throwaway git repo with the given files tracked (git add, no commit needed: ls-files lists the index).
function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-cli-'));
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  assert.strictEqual(git('init', '-q').status, 0);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  assert.strictEqual(git('add', '-A').status, 0);
  return dir;
}
const cleanup = (...dirs) => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));

const SEEDED = { 'src/app.js': 'const a = 1;\nsetInterval(refresh, 5000);\n', 'src/ok.js': 'function once() { return 1; }\n' };

// A unified diff that adds `added` lines at line 2 of src/app.js.
const diffAdding = (added, file = 'src/app.js') => [
  `diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -1,2 +1,' + (2 + added.length) + ' @@', ' const a = 1;', ...added.map((l) => '+' + l), ' setInterval(refresh, 5000);',
].join('\n') + '\n';

test('scan --root finds a seeded setInterval (JSON), with path, line, kind, severity and counts', () => {
  const repo = makeRepo(SEEDED);
  try {
    const r = run(['scan', '--root', repo, '--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    const out = json(r);
    assert.deepStrictEqual(out.findings.map((f) => [f.path, f.line, f.kind, f.severity, f.known]), [['src/app.js', 2, 'set-interval', 'poll', false]]);
    assert.deepStrictEqual(out.counts, { poll: 1, info: 0, annotated: 0, known: 0 });
  } finally { cleanup(repo); }
});

test('scan --root without --json prints one line per finding and a total', () => {
  const repo = makeRepo(SEEDED);
  try {
    const r = run(['scan', '--root', repo]);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /src\/app\.js:2 {2}set-interval {2}\[poll\] {2}setInterval\(refresh, 5000\);/);
    assert.match(r.stdout, /1 finding\(s\)/);
  } finally { cleanup(repo); }
});

test('baseline then scan --baseline reports the seeded finding as known', () => {
  const repo = makeRepo(SEEDED);
  const out = path.join(repo, '..', path.basename(repo) + '-baseline.json');
  try {
    assert.strictEqual(run(['baseline', '--root', repo, '--out', out]).status, 0);
    const saved = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.strictEqual(saved.version, 1);
    assert.strictEqual(saved.repo, path.basename(repo));
    assert.deepStrictEqual(saved.findings.map((f) => [f.path, f.kind, f.language]), [['src/app.js', 'set-interval', 'js']]);
    assert.match(saved.findings[0].signature, /^[0-9a-f]{40}$/);
    const scanned = json(run(['scan', '--root', repo, '--baseline', out, '--json']));
    assert.deepStrictEqual(scanned.findings.map((f) => f.known), [true]);
    assert.strictEqual(scanned.counts.known, 1);
  } finally { cleanup(repo, out); }
});

test('baseline run twice gives identical bytes; entries are sorted by path, kind, signature; --repo overrides the name', () => {
  const repo = makeRepo({ 'z.js': 'setInterval(a, 1);', 'a.js': 'setInterval(b, 1);\nsetInterval(c, 2);', 'm.sh': 'while true; do\n  sleep 1\ndone' });
  const o1 = repo + '-1.json';
  const o2 = repo + '-2.json';
  try {
    assert.strictEqual(run(['baseline', '--root', repo, '--out', o1, '--repo', 'demo']).status, 0);
    assert.strictEqual(run(['baseline', '--root', repo, '--out', o2, '--repo', 'demo']).status, 0);
    assert.ok(fs.readFileSync(o1).equals(fs.readFileSync(o2)), 'baseline bytes differ between two runs');
    const saved = JSON.parse(fs.readFileSync(o1, 'utf8'));
    assert.strictEqual(saved.repo, 'demo');
    assert.deepStrictEqual(saved.findings.map((f) => f.path), ['a.js', 'a.js', 'm.sh', 'z.js']);
    const aSigs = saved.findings.filter((f) => f.path === 'a.js').map((f) => f.signature);
    assert.deepStrictEqual(aSigs, [...aSigs].sort());
    assert.ok(fs.readFileSync(o1, 'utf8').endsWith('\n'));
  } finally { cleanup(repo, o1, o2); }
});

test('baseline names the repo after the real directory even when --root is relative (".")', () => {
  const repo = makeRepo(SEEDED);
  const out = repo + '-rel.json';
  try {
    assert.strictEqual(run(['baseline', '--root', '.', '--out', out], { cwd: repo }).status, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).repo, path.basename(repo));
  } finally { cleanup(repo, out); }
});

test('the baseline holds only un-annotated findings', () => {
  const repo = makeRepo({ 'a.js': '// poll-ok: dashboard refresh, no event exists\nsetInterval(a, 1);\nsetInterval(b, 2);' });
  const out = repo + '-b.json';
  try {
    assert.strictEqual(run(['baseline', '--root', repo, '--out', out]).status, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).findings.length, 1);
    const scanned = json(run(['scan', '--root', repo, '--baseline', out, '--json']));
    assert.deepStrictEqual(scanned.counts, { poll: 2, info: 0, annotated: 1, known: 1 });
  } finally { cleanup(repo, out); }
});

test('a line move does not make a known finding new', () => {
  const repo = makeRepo(SEEDED);
  const out = repo + '-b.json';
  try {
    run(['baseline', '--root', repo, '--out', out]);
    fs.writeFileSync(path.join(repo, 'src/app.js'), '// a\n// b\n// c\nconst a = 1;\n\n\nsetInterval(refresh, 5000);\n');
    const scanned = json(run(['scan', '--root', repo, '--baseline', out, '--json']));
    assert.deepStrictEqual(scanned.findings.map((f) => [f.line, f.known]), [[7, true]]);
  } finally { cleanup(repo, out); }
});

test('scan --diff: a NEW setInterval is reported new and --fail-on-new exits 1; without the flag it exits 0', () => {
  const repo = makeRepo(SEEDED);
  const out = repo + '-b.json';
  const diff = repo + '-d.diff';
  try {
    run(['baseline', '--root', repo, '--out', out]);
    fs.writeFileSync(diff, diffAdding(['setInterval(poll2, 1000);']));
    const plain = run(['scan', '--diff', diff, '--baseline', out]);
    assert.strictEqual(plain.status, 0);
    assert.deepStrictEqual(json(plain).new.map((f) => [f.path, f.line, f.kind]), [['src/app.js', 2, 'set-interval']]);
    assert.deepStrictEqual(json(plain).known, []);
    assert.deepStrictEqual(json(plain).annotated, []);
    const failing = run(['scan', '--diff', diff, '--baseline', out, '--fail-on-new']);
    assert.strictEqual(failing.status, 1);
    assert.strictEqual(json(failing).new.length, 1);
  } finally { cleanup(repo, out, diff); }
});

test('scan --diff: the same diff with a `// poll-ok: reason` above the line is annotated and exits 0 with --fail-on-new', () => {
  const repo = makeRepo(SEEDED);
  const diff = repo + '-d.diff';
  try {
    fs.writeFileSync(diff, diffAdding(['// poll-ok: the dashboard has no event source for this', 'setInterval(poll2, 1000);']));
    const r = run(['scan', '--diff', diff, '--fail-on-new']);
    assert.strictEqual(r.status, 0, r.stdout);
    const out = json(r);
    assert.deepStrictEqual(out.new, []);
    assert.deepStrictEqual(out.annotated.map((f) => [f.line, f.reason]), [[3, 'the dashboard has no event source for this']]);
    fs.writeFileSync(diff, diffAdding(['// poll-ok:', 'setInterval(poll2, 1000);']));
    assert.strictEqual(run(['scan', '--diff', diff, '--fail-on-new']).status, 1);
  } finally { cleanup(repo, diff); }
});

test('scan --diff: a finding whose signature is in the baseline is known, not new; without a baseline everything unannotated is new', () => {
  const repo = makeRepo(SEEDED);
  const out = repo + '-b.json';
  const diff = repo + '-d.diff';
  try {
    run(['baseline', '--root', repo, '--out', out]);
    fs.writeFileSync(diff, diffAdding(['setInterval(refresh, 5000);']));
    const withBaseline = json(run(['scan', '--diff', diff, '--baseline', out, '--fail-on-new']));
    assert.deepStrictEqual([withBaseline.new.length, withBaseline.known.length], [0, 1]);
    assert.strictEqual(run(['scan', '--diff', diff, '--baseline', out, '--fail-on-new']).status, 0);
    assert.strictEqual(json(run(['scan', '--diff', diff])).new.length, 1);
  } finally { cleanup(repo, out, diff); }
});

test('scan --diff: only ADDED lines count (context and removed lines are ignored), test files are skipped, an info finding never fails the gate', () => {
  const repo = makeRepo(SEEDED);
  const diff = repo + '-d.diff';
  try {
    fs.writeFileSync(diff, diffAdding(['const b = 2;']));                       // the context line setInterval(refresh, 5000) is not added
    assert.deepStrictEqual(json(run(['scan', '--diff', diff])).new, []);
    fs.writeFileSync(diff, diffAdding(['setInterval(x, 1);'], 'src/app.test.js'));
    assert.deepStrictEqual(json(run(['scan', '--diff', diff])).new, []);
    const info = ['diff --git a/plugins.json b/plugins.json', '--- a/plugins.json', '+++ b/plugins.json', '@@ -1,2 +1,3 @@', ' {', '+  "intervalMs": 5000,', '   "x": 1'].join('\n') + '\n';
    fs.writeFileSync(diff, info);
    const r = run(['scan', '--diff', diff, '--fail-on-new']);
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(json(r).new.map((f) => [f.kind, f.severity]), [['config-interval', 'info']]);
  } finally { cleanup(repo, diff); }
});

test('scan --root covers every language: an extensionless bash script, python, a systemd timer, and skips node_modules and untracked files', () => {
  const repo = makeRepo({
    'bin/forever': '#!/bin/bash\nwhile true; do\n  sleep 5\ndone\n',
    'svc/job.py': 'import time\nwhile True:\n    time.sleep(60)\n',
    'deploy/x.timer': '[Timer]\nOnCalendar=daily\n',
    'node_modules/dep/index.js': 'setInterval(a, 1);\n',
    'README.md': 'setInterval(a, 1);\n',
  });
  fs.writeFileSync(path.join(repo, 'untracked.js'), 'setInterval(a, 1);\n');
  try {
    const out = json(run(['scan', '--root', repo, '--json']));
    assert.deepStrictEqual(out.findings.map((f) => `${f.path}:${f.kind}`).sort(), ['bin/forever:sleep-loop', 'deploy/x.timer:timer-unit', 'svc/job.py:sleep-loop']);
  } finally { cleanup(repo); }
});

test('calibrate prints a report over the pooled projects only, skips a missing root, filters with --repos, and honours --sample and --json', () => {
  const alpha = makeRepo({ 'a.js': 'setInterval(a, 1);\nsetInterval(b, 2);\nsetInterval(c, 3);' });
  const beta = makeRepo({ 'b.js': 'setInterval(z, 9);' });
  const notPooled = makeRepo({ 'n.js': 'setInterval(n, 1);' });
  const projects = path.join(os.tmpdir(), `projects-${path.basename(alpha)}.json`);
  fs.writeFileSync(projects, JSON.stringify([
    { repoRoot: alpha, label: 'alpha', pool: true }, { repoRoot: beta, label: 'beta', pool: true },
    { repoRoot: notPooled, label: 'plain' }, { repoRoot: '/nonexistent/gone', label: 'gone', pool: true },
  ]));
  try {
    const text = run(['calibrate', '--projects', projects, '--sample', '2']);
    assert.strictEqual(text.status, 0, text.stderr);
    assert.match(text.stdout, /2 repo\(s\), 2 file\(s\) scanned; skipped \(root missing\): gone/);
    assert.match(text.stdout, /alpha\s+poll\s+3/);
    assert.match(text.stdout, /beta\s+poll\s+1/);
    assert.doesNotMatch(text.stdout, /plain/);
    assert.match(text.stdout, /Sample for js \(2 of 4\)/);
    assert.match(text.stdout, /PROVISIONAL gate rule/);
    assert.match(text.stderr, /\[1\/3\] alpha/);
    const only = json(run(['calibrate', '--projects', projects, '--repos', 'beta', '--json']));
    assert.deepStrictEqual(Object.keys(only.perRepo), ['beta']);
    assert.strictEqual(only.perLanguage.js.poll, 1);
    const reportFile = projects + '.out.json';
    assert.strictEqual(run(['calibrate', '--projects', projects, '--repos', 'alpha', '--out', reportFile]).status, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(reportFile, 'utf8')).perRepo.alpha.poll, 3);
    fs.rmSync(reportFile);
  } finally { cleanup(alpha, beta, notPooled, projects); }
});

test('usage errors exit 2 and print the usage; nothing is written', () => {
  const repo = makeRepo(SEEDED);
  const out = repo + '-never.json';
  try {
    const cases = [
      [],
      ['frobnicate'],
      ['scan'],
      ['scan', '--root', repo, '--diff', 'x.diff'],
      ['scan', '--root'],
      ['scan', '--root', repo, '--wat'],
      ['scan', '--root', repo, 'stray'],
      ['scan', '--root', repo, '--fail-on-new'],
      ['scan', '--root', '/nonexistent/dir'],
      ['scan', '--diff', '/nonexistent/x.diff'],
      ['scan', '--root', repo, '--baseline', '/nonexistent/b.json'],
      ['baseline', '--root', repo],
      ['baseline', '--out', out],
      ['calibrate', '--sample', 'many'],
      ['calibrate', '--sample', '-3'],
      ['calibrate', '--projects', '/nonexistent/projects.json'],
    ];
    for (const args of cases) {
      const r = run(args);
      assert.strictEqual(r.status, 2, `${JSON.stringify(args)} exited ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /usage: poll-detector\.js scan/);
    }
    assert.ok(!fs.existsSync(out));
  } finally { cleanup(repo); }
});

test('a baseline file that is not a version 1 baseline is a usage error; a root that is a directory but not a git repo is too', () => {
  const repo = makeRepo(SEEDED);
  const bad = repo + '-bad.json';
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-plain-'));
  try {
    fs.writeFileSync(bad, JSON.stringify({ version: 2, findings: [] }));
    assert.strictEqual(run(['scan', '--root', repo, '--baseline', bad]).status, 2);
    fs.writeFileSync(bad, 'not json');
    assert.strictEqual(run(['scan', '--root', repo, '--baseline', bad]).status, 2);
    const notGit = run(['scan', '--root', plain]);
    assert.ok([1, 2].includes(notGit.status), `exit ${notGit.status}`);
  } finally { cleanup(repo, bad, plain); }
});

test('parseArgs: flags, values, and the errors', () => {
  assert.deepStrictEqual(cli.parseArgs(['scan', '--root', 'r', '--json']), { command: 'scan', opt: { root: 'r', json: true } });
  assert.throws(() => cli.parseArgs(['scan', '--root', '--json']), cli.UsageError);
  assert.throws(() => cli.parseArgs(['scan', 'x']), cli.UsageError);
});

test('classify: annotated first, then known by signature, else new', () => {
  const f = (signature, annotated) => ({ signature, annotated, severity: 'poll' });
  const out = cli.classify([f('a', true), f('b', false), f('c', false)], new Set(['a', 'b']));
  assert.deepStrictEqual([out.annotated.length, out.known.length, out.new.length], [1, 1, 1]);
  assert.strictEqual(cli.classify([f('a', false)], null).new.length, 1);
});

test('big and binary files are not scanned', () => {
  const repo = makeRepo({ 'big.js': 'setInterval(a, 1);\n' + '// padding\n'.repeat(120000), 'bin.js': 'setInterval(b, 1);\n\u0000\n', 'ok.js': 'setInterval(c, 1);\n' });
  try {
    assert.ok(fs.statSync(path.join(repo, 'big.js')).size > 1024 * 1024);
    assert.deepStrictEqual(json(run(['scan', '--root', repo, '--json'])).findings.map((f) => f.path), ['ok.js']);
  } finally { cleanup(repo); }
});

test('buildBaseline orders entries by path, then kind, then signature, and keeps one entry per identical (path, kind, signature)', () => {
  const f = (path_, kind, signature, extra = {}) => ({ path: path_, kind, signature, language: 'js', annotated: false, ...extra });
  const text = cli.buildBaseline([f('b.js', 'a', '1'), f('a.js', 'z', '1'), f('a.js', 'b', '9'), f('a.js', 'b', '2'), f('a.js', 'b', '2'), f('c.js', 'a', '5', { annotated: true })], 'demo');
  const saved = JSON.parse(text);
  assert.deepStrictEqual(saved.findings.map((e) => `${e.path}|${e.kind}|${e.signature}`), ['a.js|b|2', 'a.js|b|9', 'a.js|z|1', 'b.js|a|1']);
  assert.ok(text.endsWith('}\n'));
});

test('scan --root text output tags known and annotated findings; JSON counts count info findings; an annotated finding is never "known"', () => {
  const repo = makeRepo({ 'a.js': 'setInterval(a, 1);\n', 'plugins.json': '{\n  "intervalMs": 5000\n}\n' });
  const out = repo + '-b.json';
  try {
    run(['baseline', '--root', repo, '--out', out]);
    const text = run(['scan', '--root', repo, '--baseline', out]).stdout;
    assert.match(text, /a\.js:1 {2}set-interval {2}\[poll, known\]/);
    assert.match(text, /plugins\.json:2 {2}config-interval {2}\[info, known\]/);
    fs.writeFileSync(path.join(repo, 'a.js'), '// poll-ok: dashboard timer has no event source\nsetInterval(a, 1);\n');
    const after = run(['scan', '--root', repo, '--baseline', out]).stdout;
    assert.match(after, /a\.js:2 {2}set-interval {2}\[poll, annotated\]/);
    const counts = json(run(['scan', '--root', repo, '--baseline', out, '--json'])).counts;
    assert.deepStrictEqual(counts, { poll: 1, info: 1, annotated: 1, known: 1 });
  } finally { cleanup(repo, out); }
});

test('an unexpected error (an unwritable --out) exits 1, not 2', () => {
  const repo = makeRepo(SEEDED);
  try {
    const r = run(['baseline', '--root', repo, '--out', '/nonexistent/dir/baseline.json']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /^poll-detector: /);
    assert.doesNotMatch(r.stderr, /usage:/);
  } finally { cleanup(repo); }
});

test('usage error messages name the problem', () => {
  const repo = makeRepo(SEEDED);
  const diff = repo + '-d.diff';
  fs.writeFileSync(diff, diffAdding(['const b = 2;']));
  try {
    const stderrOf = (args) => run(args).stderr;
    assert.match(stderrOf([]), /a command is required/);
    assert.match(stderrOf(['frobnicate']), /unknown command: frobnicate/);
    assert.match(stderrOf(['scan', '--root', repo, 'stray']), /unexpected argument: stray/);
    assert.match(stderrOf(['scan', '--root', repo, '--wat']), /unknown option: --wat/);
    assert.match(stderrOf(['scan', '--root']), /--root needs a value/);
    assert.match(stderrOf(['scan', '--root', '--json']), /--root needs a value/);
    assert.match(stderrOf(['scan']), /scan needs exactly one of --root and --diff/);
    assert.match(stderrOf(['scan', '--root', repo, '--diff', diff]), /scan needs exactly one of --root and --diff/);
    assert.match(stderrOf(['scan', '--root', repo, '--fail-on-new']), /--fail-on-new belongs to scan --diff/);
    assert.match(stderrOf(['scan', '--root', '/nonexistent/dir']), /cannot list tracked files/);
    assert.match(stderrOf(['baseline', '--root', repo]), /baseline needs --root and --out/);
  } finally { cleanup(repo, diff); }
});

test('calibrate options: --sample must be a whole number 0 or more (checked on its own), --projects accepts a list or { projects: [...] }, a file with no list is an error, the default path is used when --projects is absent', () => {
  const repo = makeRepo({ 'a.js': 'setInterval(a, 1);\n' });
  const list = path.join(os.tmpdir(), `plist-${path.basename(repo)}.json`);
  const wrapped = path.join(os.tmpdir(), `pwrap-${path.basename(repo)}.json`);
  const bad = path.join(os.tmpdir(), `pbad-${path.basename(repo)}.json`);
  fs.writeFileSync(list, JSON.stringify([{ repoRoot: repo, label: 'r', pool: true }]));
  fs.writeFileSync(wrapped, JSON.stringify({ projects: [{ repoRoot: repo, label: 'r', pool: true }] }));
  try {
    for (const bad_ of ['-3', '2.5', 'many', '']) {
      const r = run(['calibrate', '--projects', list, '--sample', bad_]);
      assert.strictEqual(r.status, 2, `--sample ${JSON.stringify(bad_)} exited ${r.status}`);
      assert.match(r.stderr, /--sample must be a whole number/);
    }
    assert.strictEqual(run(['calibrate', '--projects', list, '--sample', '0', '--json']).status, 0);
    assert.deepStrictEqual(json(run(['calibrate', '--projects', list, '--sample', '0', '--json'])).samples.js, []);
    assert.strictEqual(json(run(['calibrate', '--projects', wrapped, '--json'])).perRepo.r.poll, 1);
    for (const content of ['{}', '"x"', '42', '{"projects": 5}']) {
      fs.writeFileSync(bad, content);
      const r = run(['calibrate', '--projects', bad]);
      assert.strictEqual(r.status, 2, content);
      assert.match(r.stderr, /holds no project list/);
    }
    // --projects absent: the default is config.defaultProjects, else <repo root>/projects.json next to src/
    const viaConfig = inProcess(['calibrate', '--json'], { defaultProjects: list });
    assert.strictEqual(viaConfig.code, 0, viaConfig.stderr);
    assert.strictEqual(JSON.parse(viaConfig.stdout).perRepo.r.poll, 1);
    const real = inProcess(['calibrate', '--repos', '__no_such_repo__', '--json']);
    const defaultPath = path.join(__dirname, '..', 'projects.json');
    if (fs.existsSync(defaultPath)) assert.strictEqual(real.code, 0, real.stderr);
    else { assert.strictEqual(real.code, 2); assert.ok(real.stderr.includes(defaultPath), real.stderr); }
  } finally { cleanup(repo, list, wrapped, bad); }
});
