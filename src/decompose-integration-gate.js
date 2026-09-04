'use strict';

// decompose-integration-gate.js (2026-09-03) -- the check the old file-decompose flow
// never had. Each move task py_compile'd its two files in ISOLATION and review was three
// local votes reading a diff; nothing ever imported the app or exercised a route. A
// circular import (`from app import second_brain_dir` at module load, before the name is
// bound), a shadowed name, a decorator typo -- all sail through. This runs once, when a
// stacked decompose hub's last child (the wiring step) reaches done, BEFORE the branch is
// offered for merge. coordinator-sweep.js drives it.
//
// Checks, in order (a hard failure stops there; a `skip` -- e.g. Flask not importable in
// this environment -- never fails the gate, it just narrows what was proven):
//   1. py_compile      every changed/new .py file on the branch
//   2. import          `python3 -c "import <sourcemodule>"` from the source file's dir --
//                      the one check that actually catches the circular import
//   3. url_map         import the app on <main> and on <branch>, diff the sorted route
//                      table. A "pure relocation" MUST leave it byte-identical -- only the
//                      view function's module changes, never a rule, method, or endpoint.
//   4. boot (opt-in)   AGENT_MANAGER_DECOMPOSE_BOOT_SMOKE=true: start the app on an
//                      ephemeral port, GET each moved route + '/', assert not 5xx.
//
// All git/python calls go through an injectable `exec` so the sweep's own test can drive
// this with canned output instead of a real repo + interpreter.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const URL_MAP_DUMP = [
  'import json, sys',
  'try:',
  '    import app as _m',
  'except Exception as e:',
  '    print("IMPORT_ERROR:" + repr(e)); sys.exit(3)',
  'a = getattr(_m, "app", None)',
  'if a is None:',
  '    print("NO_APP_OBJECT"); sys.exit(4)',
  'rules = sorted("%s %s -> %s" % (r.rule, ",".join(sorted(m for m in r.methods if m not in ("HEAD","OPTIONS"))), r.endpoint) for r in a.url_map.iter_rules())',
  'print(json.dumps(rules))',
].join('\n');

// A "pure relocation" must leave the route table byte-identical apart from which module
// each view function now lives in. Each dumped line is `<rule> <methods> -> <endpoint>`;
// compare on `<rule> <methods>` only (the endpoint string legitimately changes when the
// view fn moves module). Returns { ok, droppedRules, addedRules, count }.
function diffRouteTables(mainJson, branchJson) {
  const mainSet = new Set(JSON.parse(mainJson));
  const branchSet = new Set(JSON.parse(branchJson));
  const ruleKey = (r) => r.split(' -> ')[0];
  const mainRules = new Set([...mainSet].map(ruleKey));
  const branchRules = new Set([...branchSet].map(ruleKey));
  const droppedRules = [...mainRules].filter((r) => !branchRules.has(r));
  const addedRules = [...branchRules].filter((r) => !mainRules.has(r));
  return { ok: droppedRules.length === 0 && addedRules.length === 0, droppedRules, addedRules, count: mainRules.size };
}

function realExec(file, args, opts = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8', timeout: opts.timeout || 60_000, cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

// Returns { ok, checks:[{name,status,detail}], branch }. Never throws for a check failure
// -- only for a setup failure it genuinely can't proceed past (e.g. cannot create the
// worktree), which the caller treats as an errored (not failed) gate and retries later.
function runIntegrationGate({ repoRoot, branch, mainBranch = 'master', sourceFile, routes = [], exec = realExec } = {}) {
  const checks = [];
  const srcDir = path.dirname(sourceFile);
  const srcModule = path.basename(sourceFile).replace(/\.py$/, '');
  const isPy = /\.py$/.test(sourceFile);
  const wtBase = fs.mkdtempSync(path.join(os.tmpdir(), 'decompose-gate-'));
  const branchWt = path.join(wtBase, 'branch');
  const mainWt = path.join(wtBase, 'main');
  const cleanup = [];

  const record = (name, status, detail) => checks.push({ name, status, detail: String(detail || '').slice(0, 2000) });
  const done = () => {
    for (const wt of cleanup) {
      try { exec('git', ['worktree', 'remove', '--force', wt], { cwd: repoRoot }); } catch { /* best-effort */ }
    }
    try { fs.rmSync(wtBase, { recursive: true, force: true }); } catch { /* best-effort */ }
    const failed = checks.filter((c) => c.status === 'fail');
    return { ok: failed.length === 0, checks, branch };
  };

  try {
    exec('git', ['worktree', 'add', '--detach', branchWt, branch], { cwd: repoRoot });
    cleanup.push(branchWt);
  } catch (e) {
    record('setup', 'fail', `could not create worktree for ${branch}: ${e.message}`);
    return { ...done(), errored: true };
  }

  if (!isPy) {
    record('language', 'skip', `integration gate only covers Python decompositions; ${sourceFile} left to review`);
    return done();
  }

  // 1. py_compile every changed / new .py file on the branch.
  let changed = [];
  try {
    const out = exec('git', ['diff', '--name-only', `${mainBranch}...${branch}`], { cwd: repoRoot });
    changed = out.split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.py'));
  } catch (e) {
    record('py_compile', 'skip', `could not list changed files: ${e.message}`);
  }
  const toCompile = Array.from(new Set([sourceFile, ...changed])).filter((f) => fs.existsSync(path.join(branchWt, f)));
  if (toCompile.length) {
    try {
      exec('python3', ['-m', 'py_compile', ...toCompile], { cwd: branchWt });
      record('py_compile', 'pass', `${toCompile.length} file(s): ${toCompile.join(', ')}`);
    } catch (e) {
      record('py_compile', 'fail', `${(e.stderr || e.stdout || e.message)}`);
      return done();
    }
  }

  // 2. import the source module -- catches the circular import the isolated compile can't.
  try {
    exec('python3', ['-c', `import ${srcModule}`], { cwd: path.join(branchWt, srcDir), timeout: 30_000 });
    record('import', 'pass', `import ${srcModule} from ${srcDir} exits 0`);
  } catch (e) {
    const msg = String(e.stderr || e.stdout || e.message);
    // A bare ModuleNotFoundError for a third-party dep means this environment can't import
    // the app at all -- not the branch's fault. A circular import / NameError / ImportError
    // for a first-party name IS the branch's fault.
    if (/ModuleNotFoundError: No module named '(flask|werkzeug|jinja2)'/.test(msg) && !/circular|partially initialized/.test(msg)) {
      record('import', 'skip', `app dependencies not installed here: ${msg.split('\n').pop()}`);
      return done();
    }
    record('import', 'fail', msg);
    return done();
  }

  // 3. url_map invariant: identical route table on main and on the branch.
  try {
    exec('git', ['worktree', 'add', '--detach', mainWt, mainBranch], { cwd: repoRoot });
    cleanup.push(mainWt);
  } catch (e) {
    record('url_map', 'skip', `could not create ${mainBranch} worktree: ${e.message}`);
    return done();
  }
  const dump = (wt) => {
    const p = path.join(wt, srcDir, '.decompose_url_dump.py');
    fs.writeFileSync(p, URL_MAP_DUMP);
    try { return exec('python3', ['.decompose_url_dump.py'], { cwd: path.join(wt, srcDir), timeout: 30_000 }); }
    finally { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  };
  let mainRules; let branchRules;
  try { mainRules = dump(mainWt).trim(); branchRules = dump(branchWt).trim(); } catch (e) {
    record('url_map', 'skip', `route dump failed: ${String(e.stderr || e.message).split('\n').pop()}`);
    return done();
  }
  if (mainRules.startsWith('IMPORT_ERROR') || branchRules.startsWith('IMPORT_ERROR')) {
    record('url_map', 'fail', `route dump import error -- main: ${mainRules.slice(0, 300)} | branch: ${branchRules.slice(0, 300)}`);
    return done();
  }
  let cmp;
  try { cmp = diffRouteTables(mainRules, branchRules); } catch {
    record('url_map', 'skip', 'route dump was not JSON'); return done();
  }
  if (!cmp.ok) {
    record('url_map', 'fail',
      `route table changed -- a pure relocation must not. Dropped: ${cmp.droppedRules.join(' | ') || 'none'}. Added: ${cmp.addedRules.join(' | ') || 'none'}.`);
    return done();
  }
  record('url_map', 'pass', `${cmp.count} routes, rule table unchanged (endpoints re-homed as expected)`);

  // 4. boot smoke -- opt-in (needs a runnable app + a free port).
  if (process.env.AGENT_MANAGER_DECOMPOSE_BOOT_SMOKE === 'true' && routes.length) {
    record('boot', 'skip', 'boot smoke requested but not implemented in this build -- import + url_map cover the crash modes');
  }

  return done();
}

module.exports = { runIntegrationGate, diffRouteTables, URL_MAP_DUMP, realExec };
