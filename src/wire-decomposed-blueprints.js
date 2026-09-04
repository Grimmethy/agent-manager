'use strict';

// wire-decomposed-blueprints.js (2026-09-04) -- the deterministic replacement for the LLM
// "wiring" child task in the file-decompose flow.
//
// The move tasks already produce correct Blueprint modules on the shared branch
// (`X_bp = Blueprint(...)`, every `@app.route` rewritten to `@X_bp.route`, imports + the
// `from app import ...` back-imports added, the symbols deleted from the source file). The
// ONLY thing left is registration: a handful of `from <pkg>.<mod> import <bp>` +
// `app.register_blueprint(<bp>)` lines spliced into the bottom of the source file, right
// before `if __name__ == "__main__":`.
//
// The wiring CHILD TASK can't do this: it runs read-only on the local 27B against a plain
// checkout where the branch's `routes/` package doesn't exist, so its prompt's premise is
// invisible to it and it routes to `decompose`, which shatters it into move-tasks that
// duplicate work already on the branch (confirmed live: decompose-app-py-01). This does
// the splice deterministically instead. decompose-integration-gate.js still runs afterward
// and proves the result actually imports + keeps its url_map.
//
// coordinator-sweep.js drives this, once, on the transition to all-move-children-done,
// BEFORE the integration gate. Only for `kind: 'flask-blueprint'` moves; anything else
// still gets an LLM wiring child.
//
// All git calls go through an injectable `exec` (same shape as
// decompose-integration-gate.js's realExec) so the sweep's own test can drive this with a
// fake.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const MARKER = '# --- Decomposed route blueprints (file-decompose) ---';
const MAIN_GUARD_RE = /^if __name__ == ['"]__main__['"]:/m;
const COMMIT_TRAILERS = [
  'Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>',
  'Claude-Session: https://claude.ai/code/session_01SdhBvELxXYiNSQU7ycwwnP',
].join('\n');

function realExec(file, args, opts = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8', timeout: opts.timeout || 60_000, cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

// `python/dashboard/routes/hardware.py` relative to source dir `python/dashboard` ->
// import path `routes.hardware`. Nested dirs (`routes/admin/hardware.py`) ->
// `routes.admin.hardware`.
function importPathFor(sourceFile, newFile) {
  const rel = path.relative(path.dirname(sourceFile), newFile).replace(/\.py$/, '');
  return rel.split(path.sep).filter(Boolean).join('.');
}

// Build the one contiguous registration block. Trailing blank lines keep the `if __name__`
// guard visually separated once spliced in.
function buildBlock(moves, sourceFile) {
  const imports = [];
  const registers = [];
  for (const m of moves) {
    const mod = importPathFor(sourceFile, m.newFile);
    imports.push(`from ${mod} import ${m.blueprint}  # noqa: E402`);
    registers.push(`app.register_blueprint(${m.blueprint})`);
  }
  return `${MARKER}\n${imports.join('\n')}\n\n${registers.join('\n')}\n\n\n`;
}

// Splice the block in immediately before `if __name__ == "__main__":`; if that guard is
// absent, append at EOF (bottom placement is always safe for the `from app import ...`
// back-imports the moved modules carry). Returns the new file text, or null if the marker
// is already present (idempotent no-op).
function spliceBlock(text, block) {
  if (text.includes(MARKER)) return null;
  const m = text.match(MAIN_GUARD_RE);
  if (!m) {
    const sep = text.endsWith('\n') ? '\n' : '\n\n';
    return `${text}${sep}${block}`;
  }
  return `${text.slice(0, m.index)}${block}${text.slice(m.index)}`;
}

/**
 * @param {object} opts
 * @param {string} opts.repoRoot   the real repo (a throwaway worktree is added off it)
 * @param {string} opts.branch     the shared `agent/decompose-<slug>` branch
 * @param {string} opts.sourceFile repo-relative path of the decomposed file
 * @param {Array<{newFile,blueprint,kind}>} opts.moves  the flask-blueprint moves to register
 * @param {function} [opts.exec]   injectable (file,args,opts)=>string
 * @returns {{ok:boolean, registered:number, sha?:string, detail?:string, skipped?:boolean}}
 *   Never throws past its own cleanup -- a failure is `{ ok:false, detail }`, which the
 *   coordinator turns into a blockedReason (not an errored gate).
 */
function wireDecomposedBlueprints({ repoRoot, branch, sourceFile, moves, exec = realExec } = {}) {
  const bp = (moves || []).filter((m) => m && m.kind === 'flask-blueprint' && m.blueprint && m.newFile);
  if (!repoRoot || !branch || !sourceFile) {
    return { ok: false, registered: 0, detail: 'wireDecomposedBlueprints: missing repoRoot/branch/sourceFile' };
  }
  if (!bp.length) return { ok: true, registered: 0, skipped: true, detail: 'no flask-blueprint moves to wire' };

  const wtBase = fs.mkdtempSync(path.join(os.tmpdir(), 'decompose-wire-'));
  const wt = path.join(wtBase, 'branch');
  let added = false;
  const git = (args, opts) => exec('git', args, { cwd: repoRoot, ...opts });

  try {
    git(['worktree', 'add', wt, branch]);
    added = true;

    const abs = path.join(wt, sourceFile);
    if (!fs.existsSync(abs)) {
      return { ok: false, registered: 0, detail: `${sourceFile} not found on ${branch}` };
    }
    const before = fs.readFileSync(abs, 'utf8');
    const next = spliceBlock(before, buildBlock(bp, sourceFile));
    if (next === null) {
      return { ok: true, registered: 0, skipped: true, detail: `wiring block already present on ${branch}` };
    }
    fs.writeFileSync(abs, next);

    // Ensure each new module's package dir is importable.
    const addPaths = [sourceFile];
    for (const m of bp) {
      const initAbs = path.join(wt, path.dirname(m.newFile), '__init__.py');
      if (!fs.existsSync(initAbs)) {
        fs.mkdirSync(path.dirname(initAbs), { recursive: true });
        fs.writeFileSync(initAbs, '');
        addPaths.push(path.join(path.dirname(m.newFile), '__init__.py'));
      }
    }

    const msgFile = path.join(wtBase, 'msg.txt');
    fs.writeFileSync(msgFile,
      `Decompose ${sourceFile} — register ${bp.length} blueprint(s)\n\n`
      + `Deterministic wiring for the file-decompose stacked branch: splice the\n`
      + `\`from ... import <bp>\` + \`app.register_blueprint(<bp>)\` block in before the\n`
      + `\`if __name__ == "__main__":\` guard. Move tasks produced the blueprint modules;\n`
      + `this only registers them.\n\n${COMMIT_TRAILERS}\n`);

    git(['add', '--', ...addPaths], { cwd: wt });
    git(['commit', '-F', msgFile], { cwd: wt });
    git(['push', 'origin', branch], { cwd: wt });
    const sha = String(git(['rev-parse', 'HEAD'], { cwd: wt }) || '').trim();
    return { ok: true, registered: bp.length, sha };
  } catch (e) {
    return { ok: false, registered: 0, detail: (e && e.message ? e.message : String(e)).slice(0, 600) };
  } finally {
    if (added) { try { git(['worktree', 'remove', '--force', wt]); } catch { /* best-effort */ } }
    try { fs.rmSync(wtBase, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

module.exports = { wireDecomposedBlueprints, importPathFor, buildBlock, spliceBlock, MARKER };
