'use strict';

// decompose-flask-blueprint.js (2026-09-09, [[hub-task-integration]] / concept-hub-task-integration-549f09).
//
// The deterministic path for a `kind: flask-blueprint` move -- the third one, after
// decompose-one-pass.js (browser <script>) and decompose-node-module.js (CJS). Until now
// the blueprint MOVE was left entirely to the local 27B agentic pass, which on a large
// app.py burns its whole turn budget orienting and runs out before the edits: the
// 2026-09-09 app.py blueprint hub took ~4 attempts per child and the brain-dump child
// (7 routes across two non-contiguous line ranges, 13 shared helpers) failed all 6 and
// escalated to a human. Only the register_blueprint WIRING was ever deterministic
// (wire-decomposed-blueprints.js).
//
// The move itself is 100% mechanical: pull each @app.route view out verbatim, rewrite
// only its decorator to @<bp>.route, give it a lazy `from app import <names it reads>`
// first body line, assemble the module, delete the spans from the source, splice the
// `from routes.<x> import <bp>` + `app.register_blueprint(<bp>)` lines. scripts/
// decompose-blueprint-extract.py does the AST work (Node has no Python parser); this
// module drives it and shapes the result into the same Group-B change set
// buildNodeModuleOnePassChanges produces, then hard-gates it with a real `py_compile`.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { importPathFor } = require('./wire-decomposed-blueprints.js');

const PY_EXTRACT = path.join(__dirname, '..', 'scripts', 'decompose-blueprint-extract.py');

function blueprintSlug(bpVar) {
  return String(bpVar || 'bp').replace(/_/g, '-');
}

// One move: run the Python extractor against `sourceText`, return the new module content
// + the reduced source, or a problem list.
function extractOne(sourceText, sourceFile, newFile, blueprintVar, symbols) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-extract-'));
  const srcPath = path.join(tmp, 'src.py');
  try {
    fs.writeFileSync(srcPath, sourceText);
    let out;
    try {
      out = execFileSync('python3', [PY_EXTRACT, srcPath, blueprintVar, blueprintSlug(blueprintVar), ...symbols], {
        encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      const stdout = (e && e.stdout) || '';
      try { return JSON.parse(stdout); } catch { /* fall through */ }
      return { ok: false, problems: [`decompose-blueprint-extract.py failed: ${String((e && e.stderr) || (e && e.message) || e).slice(0, 300)}`] };
    }
    let parsed;
    try { parsed = JSON.parse(out); } catch {
      return { ok: false, problems: [`decompose-blueprint-extract.py produced non-JSON output: ${out.slice(0, 200)}`] };
    }
    // The script only ever sees the temp copy's path -- rewrite it back to the real name
    // so a blocked-hub blockedReason reads cleanly.
    if (Array.isArray(parsed.problems)) {
      const tmpRe = new RegExp(srcPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      parsed.problems = parsed.problems.map((p) => String(p).replace(tmpRe, sourceFile));
    }
    return parsed;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/**
 * @returns {{ok:true, newContent:string, reduced:string, sharedDeps:object,
 *            changes:Array}|{ok:false, reason:string, problems?:string[]}}
 */
function buildBlueprintExtraction(sourceText, sourceFile, newFile, blueprintVar, symbols) {
  if (!/\.py$/.test(sourceFile || '')) return { ok: false, reason: 'source is not a .py file' };
  if (!/\.py$/.test(newFile || '')) return { ok: false, reason: 'target is not a .py file' };
  if (!blueprintVar) return { ok: false, reason: 'no blueprint variable name' };
  if (!Array.isArray(symbols) || !symbols.length) return { ok: false, reason: 'no route symbols to move' };

  const r = extractOne(sourceText, sourceFile, newFile, blueprintVar, symbols);
  if (!r || !r.ok) {
    return { ok: false, reason: (r && r.problems && r.problems.join('; ')) || 'extraction failed', problems: (r && r.problems) || [] };
  }
  return {
    ok: true,
    newContent: r.newFileContent,
    reduced: r.reducedSource,
    sharedDeps: r.sharedDeps || {},
    changes: [
      { mode: 'create', file: newFile, content: r.newFileContent },
      { mode: 'edit', file: sourceFile, find: sourceText, replace: r.reducedSource },
    ],
  };
}

// Splice `from <mod> import <bp>` + `app.register_blueprint(<bp>)` for every move. Anchors
// after the LAST existing `app.register_blueprint(` line (so a repeat cut stacks cleanly);
// falls back to right before `if __name__ == "__main__":`, then to EOF.
function spliceRegistrations(reduced, sourceFile, moves) {
  const imports = moves.map((m) => `from ${importPathFor(sourceFile, m.newFile)} import ${m.blueprint}  # noqa: E402`);
  const registers = moves.map((m) => `app.register_blueprint(${m.blueprint})`);
  const lines = reduced.split('\n');

  let lastReg = -1;
  let lastBpImport = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^app\.register_blueprint\(/.test(lines[i])) lastReg = i;
    if (/^(?:from \S+ import \w+_bp\b|import \S+)\s*(?:#.*)?$/.test(lines[i]) && /\b\w+_bp\b/.test(lines[i])) lastBpImport = i;
  }
  if (lastReg !== -1) {
    // Two independent insertion points -- new imports right after the last `from routes.*
    // import <bp>` line (fallback: right before the register cluster), new register calls
    // right after the last `app.register_blueprint(...)`. Splice the higher index first.
    const impAt = lastBpImport !== -1 ? lastBpImport + 1 : lastReg;
    const out = lines.slice();
    out.splice(lastReg + 1, 0, ...registers);
    out.splice(impAt, 0, ...imports);
    return out.join('\n');
  }

  const block = ['', '# --- Decomposed route blueprints (file-decompose) ---', ...imports, '', ...registers, '', ''];
  const guardIdx = lines.findIndex((l) => /^if __name__ == ['"]__main__['"]:/.test(l));
  if (guardIdx !== -1) return lines.slice(0, guardIdx).concat(block, lines.slice(guardIdx)).join('\n');
  return `${reduced.replace(/\s*$/, '')}\n${block.join('\n')}\n`;
}

/**
 * The whole all-blueprint plan as one deterministic Group-B change set: N new route
 * modules + the reduced source (spans removed AND register_blueprint wired), chained.
 *
 * @param {Array<{newFile:string, blueprint:string, symbols:string[]}>} moves
 * @returns {{ok:true, changes:Array}|{ok:false, reason:string, problems?:string[]}}
 */
function buildBlueprintOnePassChanges(sourceText, sourceFile, moves) {
  if (!/\.py$/.test(sourceFile || '')) return { ok: false, reason: 'source is not a .py file' };
  if (!Array.isArray(moves) || moves.length < 1) return { ok: false, reason: 'need at least one blueprint move' };

  const creates = [];
  let cur = sourceText;
  for (const move of moves) {
    if (!move || !move.newFile || !move.blueprint || !Array.isArray(move.symbols) || !move.symbols.length) {
      return { ok: false, reason: `blueprint move for ${move && move.newFile} is missing newFile / blueprint / symbols` };
    }
    const one = buildBlueprintExtraction(cur, sourceFile, move.newFile, move.blueprint, move.symbols);
    if (!one.ok) return { ok: false, reason: `${move.newFile}: ${one.reason}`, problems: one.problems };
    creates.push({ mode: 'create', file: move.newFile, content: one.newContent });
    cur = one.reduced;
  }
  cur = spliceRegistrations(cur, sourceFile, moves);
  const changes = [...creates, { mode: 'edit', file: sourceFile, find: sourceText, replace: cur }];

  const compileErr = firstPyCompileError(changes);
  if (compileErr) return { ok: false, reason: `produced file does not pass \`python3 -m py_compile\` -- ${compileErr}` };

  return { ok: true, changes };
}

// Real `python3 -m py_compile` on every produced .py file -- independent of the AST
// extractor and of this module's own splice logic (2026-09-09 incident: a builder that
// self-verifies can rubber-stamp its own bug).
function firstPyCompileError(changes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-pycheck-'));
  try {
    for (const ch of changes) {
      const body = ch.mode === 'create' ? ch.content : ch.replace;
      if (typeof body !== 'string' || !/\.py$/.test(ch.file)) continue;
      const fp = path.join(dir, `${path.basename(ch.file, '.py')}__check__.py`);
      fs.writeFileSync(fp, body);
      try {
        execFileSync('python3', ['-m', 'py_compile', fp], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 20_000 });
      } catch (e) {
        const line = String((e && e.stderr) || (e && e.message) || e).split('\n').find((l) => /Error|error:/.test(l)) || 'compile failed';
        return `${ch.file}: ${line.trim().slice(0, 200)}`;
      }
    }
    return null;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// Eligible for the deterministic one-pass path? Caller passes file-decompose-to-hub.js's
// validatePlan() result. Mirrors planIsFullyMechanicalHtml / ...NodeModule.
function planIsFullyMechanicalBlueprint(request, validation) {
  if (process.env.AGENT_MANAGER_DECOMPOSE_BLUEPRINT === 'false') return false;
  if (!request || !/\.py$/.test(request.sourceFile || '')) return false;
  const moves = request.moves || [];
  if (moves.length < 1) return false;
  if (!moves.every((m) => m.kind === 'flask-blueprint' && m.blueprint)) return false;
  const meta = (validation && validation.moveMeta) || [];
  return moves.every((_, i) => meta[i] && meta[i].blueprintApplyOk === true);
}

module.exports = {
  buildBlueprintExtraction,
  buildBlueprintOnePassChanges,
  planIsFullyMechanicalBlueprint,
  spliceRegistrations,
  firstPyCompileError,
  blueprintSlug,
};
