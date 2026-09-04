'use strict';

// file-decompose -> coordinator-hub bridge (2026-09-03, Grimmethy: "we need to work on
// file decomposition ... History shows all we have to do is break it down into smaller
// tasks rather than giving it the whole chunk at once").
//
// agent-manager-hygiene's file-length-scan.js flags files over 500 lines but files nothing
// -- deciding WHERE the module boundaries go is a judgement call the local 27B can't make
// (it's the jsg0 failure mode at larger scale). So a human authors a decomposition plan
// per oversized file into queue/file-decompose-requests/<slug>.json:
//
//   { "id": "decompose-app-py",
//     "sourceFile": "python/dashboard/app.py",
//     "moves": [
//       { "newFile": "python/dashboard/routes/plugins.py", "kind": "flask-blueprint",
//         "blueprint": "plugins_bp", "urlPrefix": "",
//         "symbols": ["api_plugins_marketplace", "api_plugins_install", "_read_plugin_catalog"],
//         "notes": "..." },
//       ...
//     ] }
//
// STACKED MODEL (2026-09-03, Grimmethy: "we need the system to be able to handle this
// breakdown without crashing itself"). A file decomposition is ONE atomic refactor, not N
// independent changes -- the earlier design filed N `agent/<id>` branches joined by a
// cross-branch `dependsOn` DAG, and `isDependencySatisfied()` only clears a dep once it is
// merged to main. The apply loop runs skip-push and never merges, so the wiring task -- and
// with it the whole job -- was gated forever (confirmed live: decompose-app-py-01, wiring
// child never once claimed). So instead:
//   * every move + the wiring step commits onto ONE shared branch, `agent/decompose-<slug>`
//   * "step N may start" == "step N-1 committed to that branch" == "prev child reached
//     queue/done/" -- a local check, no merge (isDependencySatisfied honours `stacked`)
//   * children are `atomic` -- the pre-split / agentic "this is too big" escape is disabled
//     for them (they ARE the output of decomposition; re-decomposing loops)
//   * before the branch is offered for merge, decompose-integration-gate.js actually
//     imports the app and diffs its url_map against main -- a py_compile-in-isolation pass
//     never caught the circular import `from app import second_brain_dir` introduces
// Set AGENT_MANAGER_DECOMPOSE_STACKED=false to fall back to the old per-move-branch model.
//
// Preflight: the plan author only ASSERTS "nothing else calls these" / "self-contained".
// validatePlan() checks it (scripts/decompose-plan-check.py, Python AST) -- a missing
// symbol or a stray external call site is a hard stop (hub filed blocked, no children); a
// shared module-level dep (the `from app import X` hazard) is recorded so the wiring
// prompt tells the model to defer every register_blueprint to the bottom of the file.
//
// Kill switch: AGENT_MANAGER_FILE_DECOMPOSE_TO_HUB=false. `--force` re-files (danger:
// duplicates children -- only after clearing a bad hub by hand).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getConfig } = require('./config.js');

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
}

function stackedEnabled() {
  return process.env.AGENT_MANAGER_DECOMPOSE_STACKED !== 'false';
}

function readRequests(requestsDir) {
  let names;
  try { names = fs.readdirSync(requestsDir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    const full = path.join(requestsDir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (parsed && typeof parsed.id === 'string' && parsed.sourceFile && Array.isArray(parsed.moves)) {
        out.push({ full, request: parsed });
      }
    } catch { /* skip malformed */ }
  }
  return out;
}

// --- Preflight -------------------------------------------------------------------------

// Runs scripts/decompose-plan-check.py for one .py move. Returns null when the check can't
// run (no python, non-.py source, script missing) -- the caller then proceeds advisory-only
// rather than blocking a decomposition on a missing dev tool.
function staticCheckMove(repoRoot, sourceFile, symbols) {
  if (!/\.py$/.test(sourceFile)) return null;
  const script = path.join(__dirname, '..', 'scripts', 'decompose-plan-check.py');
  if (!fs.existsSync(script)) return null;
  const abs = path.join(repoRoot, sourceFile);
  if (!fs.existsSync(abs)) return null; // can't check here (e.g. a bare pipelineDir) -- advisory only
  try {
    const out = execFileSync('python3', [script, abs, ...symbols], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const parsed = JSON.parse(out);
    if (parsed && parsed.error) return null;
    return parsed;
  } catch {
    return null; // python missing / parse failure -> advisory only
  }
}

// { ok, hardProblems:[str], moveMeta:[{ sharedDeps:[], neededImports:[] }] }
// hardProblems block the whole plan (hub filed blocked, no children). Shared deps do not
// block -- they are threaded into the move + wiring prompts.
function validatePlan(repoRoot, request) {
  const hardProblems = [];
  const moveMeta = [];
  const allMovedSymbols = new Set();
  for (const m of request.moves) for (const s of (m.symbols || [])) allMovedSymbols.add(s);

  for (const move of request.moves) {
    const symbols = move.symbols || [];
    const meta = { sharedDeps: [], neededImports: [] };
    if (symbols.length === 0) {
      hardProblems.push(`${move.newFile}: move has no symbols`);
      moveMeta.push(meta);
      continue;
    }
    const check = staticCheckMove(repoRoot, request.sourceFile, symbols);
    if (check) {
      if (check.missing && check.missing.length) {
        hardProblems.push(`${move.newFile}: ${check.missing.join(', ')} not defined at module scope in ${request.sourceFile}`);
      }
      const strays = Object.entries(check.externalRefs || {});
      if (strays.length) {
        hardProblems.push(`${move.newFile}: ${strays.map(([s, lines]) => `${s} is still referenced elsewhere in ${request.sourceFile} (line(s) ${lines.slice(0, 6).join(', ')})`).join('; ')} -- not a self-contained move`);
      }
      // `app` is expected for a flask-blueprint move (every @app.route becomes
      // @<bp>.route); anything else that resolves to an app.py module-level name and is
      // not itself being moved becomes a cross-module import.
      meta.sharedDeps = (check.sharedDeps || []).filter((d) => {
        if (d === 'app' && move.kind === 'flask-blueprint') return false;
        return !allMovedSymbols.has(d);
      });
      meta.neededImports = check.neededImports || [];
    }
    moveMeta.push(meta);
  }
  return { ok: hardProblems.length === 0, hardProblems, moveMeta };
}

// --- Prompt text ----------------------------------------------------------------------

// The bounded per-move instruction. `kind` picks the framing; the invariant across all of
// them: copy the NAMED symbols out verbatim, delete them from the source file, change
// NOTHING else, validate with a compile/parse check.
function moveRawText(request, move, index, total, meta = {}) {
  const src = request.sourceFile;
  const dst = move.newFile;
  const syms = (move.symbols || []).map((s) => `\`${s}\``).join(', ');
  const compile = /\.py$/.test(dst) ? 'python3 -m py_compile' : (/\.js$/.test(dst) ? 'node --check' : 'the file\'s own syntax check');

  const common = [
    `Decomposition move ${index + 1} of ${total} for ${src} (plan: ${request.id}).`,
    '',
    `Create ${dst}. Move these symbols OUT of ${src} into it, VERBATIM: ${syms}.`,
    '',
    'Procedure, one symbol at a time:',
    `1. grep ${src} for the symbol's definition; read its full body (a def/function through its last line -- use read_file with the line range).`,
    `2. Append it unchanged to ${dst}.`,
    `3. Delete it from ${src}. A verbatim edit_file "find" over a 30-80 line body is fine; if that is unwieldy, use run_bash \`sed -i 'A,Bd' ${src}\` on the exact line range you just read (re-grep the line numbers right before, they drift as you delete).`,
    `4. Do NOT modify, reformat, or "improve" any code -- this is a pure move. Do NOT touch any symbol not in the list above.`,
    '',
    `Add to the TOP of ${dst} only the imports its moved code actually references (copy the relevant \`import\`/\`require\` lines from ${src}; do not remove them from ${src} yet -- the wiring task handles dead imports).`,
    meta.neededImports && meta.neededImports.length
      ? `The moved code references these names -- make sure ${dst} imports each: ${meta.neededImports.map((n) => `\`${n}\``).join(', ')}.`
      : '',
    meta.sharedDeps && meta.sharedDeps.length
      ? `It also reads these names defined in ${src} that are NOT being moved: ${meta.sharedDeps.map((n) => `\`${n}\``).join(', ')}. Import them from the source module (e.g. \`from ${moduleNameFor(src)} import ${meta.sharedDeps.join(', ')}\`). Do NOT copy their definitions. The wiring step knows about this and will register the blueprint at the bottom of ${src} so the import resolves.`
      : '',
    '',
    `Validate before finishing: run \`${compile}\` on BOTH ${src} and ${dst}. If ${src} no longer parses, you deleted too much -- fix it.`,
    move.notes ? `\nPlan notes: ${move.notes}` : '',
  ];

  if (move.kind === 'flask-blueprint') {
    common.splice(3, 0,
      `${dst} is a Flask Blueprint. At its top: \`from flask import Blueprint\` + \`${move.blueprint || 'bp'} = Blueprint(${JSON.stringify(slugify(move.blueprint || 'bp'))}, __name__${move.urlPrefix ? `, url_prefix=${JSON.stringify(move.urlPrefix)}` : ''})\`. Change each moved \`@app.route(...)\` to \`@${move.blueprint || 'bp'}.route(...)\` (keep the path and methods identical). Leave \`app.register_blueprint(...)\` for the wiring task.`,
      '');
  } else if (move.kind === 'script-extract') {
    common.splice(3, 0,
      `${dst} is a plain browser script (no module system -- it is loaded by a \`<script src>\` tag the wiring task adds). Move the named top-level function declarations out of the single inline \`<script>\` block in ${src} (a Jinja template) into ${dst} unchanged. They keep sharing globals with the rest of the page, so no import/export -- just the function bodies. Delete each from the template's \`<script>\`.`,
      '');
  }

  return common.filter((l) => l !== '').join('\n');
}

function moduleNameFor(src) {
  return path.basename(src).replace(/\.py$/, '');
}

function wiringRawText(request, moves, moveMetas = []) {
  const src = request.sourceFile;
  const anySharedDep = moveMetas.some((m) => m && m.sharedDeps && m.sharedDeps.length);
  const lines = [
    `Final wiring for the ${request.id} decomposition of ${src}. Every move step has committed to this branch -- the new files exist and their symbols are gone from ${src}. Now register them:`,
    '',
  ];
  const isPy = /\.py$/.test(src);
  const isTemplate = /\.html$/.test(src);
  for (const m of moves) {
    if (m.kind === 'flask-blueprint') {
      lines.push(`- \`from ${slugify(path.basename(path.dirname(m.newFile)))}.${path.basename(m.newFile, '.py')} import ${m.blueprint}\` (match the real package path) then \`app.register_blueprint(${m.blueprint})\`.`);
    } else if (m.kind === 'script-extract') {
      lines.push(`- ${src}: add \`<script src="/static/js/${path.basename(m.newFile)}"></script>\` just before the final \`</body>\`, after any core.js it depends on.`);
    } else {
      lines.push(`- ${src}: \`require('./${path.relative(path.dirname(src), m.newFile).replace(/\\.js$/, '')}')\` (or import) and use the moved symbols from there.`);
    }
  }
  if (isPy) {
    lines.push('');
    if (anySharedDep) {
      lines.push(
        `PLACEMENT (required): one or more of the new modules imports back from \`${moduleNameFor(src)}\` (${moveMetas.flatMap((m) => (m && m.sharedDeps) || []).filter((v, i, a) => a.indexOf(v) === i).join(', ')}). Put ALL the \`from ... import <bp>\` lines and ALL the \`app.register_blueprint(...)\` calls in ONE block at the very BOTTOM of ${src}, after every module-level definition (right before \`if __name__ == "__main__":\` if present). Do NOT put them right after \`app = Flask(...)\` -- the back-import is unresolved that early and \`import ${moduleNameFor(src)}\` will raise ImportError.`);
    } else {
      lines.push(`PLACEMENT: put the import + \`register_blueprint\` calls together, either right after \`app = Flask(...)\` or in a block at the bottom of ${src}. If any \`${moduleNameFor(src)}.something\` used by a new module is defined later in the file than \`app = Flask(...)\`, use the bottom.`);
    }
  }
  lines.push('',
    `Then: remove any now-unused imports from ${src}; ${isPy ? `run \`python3 -m py_compile\` on ${src} and every new file, then \`cd ${path.dirname(src)} && python3 -c "import ${moduleNameFor(src)}"\` -- it MUST exit 0 (this is what catches a bad blueprint import)` : isTemplate ? 'extract the `<script>` block and run `node --check` on it' : 'run `node --check`'}; and grep ${src} for each moved symbol name -- there must be no bare call sites left, only the import.`,
    'Change NOTHING else.');
  return lines.join('\n');
}

// --- Hub filing ----------------------------------------------------------------------

function fileBlockedHub({ pipelineDir, requestFile, request, now, hardProblems }) {
  const coordDir = path.join(pipelineDir, 'queue', 'coordinating');
  fs.mkdirSync(coordDir, { recursive: true });
  const nowIso = new Date(now).toISOString();
  const planSlug = slugify(request.id);
  const hubId = `file-decompose-hub-${planSlug}`;
  const hub = {
    id: hubId,
    domain: 'adhoc',
    source: 'manual',
    status: 'coordinating',
    adhocResolution: 'decompose',
    title: `Decompose ${request.sourceFile} -- plan needs revision`,
    createdAt: nowIso,
    promptContext: { rawText: `Coordinator for the ${request.id} decomposition of ${request.sourceFile}.`, decomposedFrom: `file-decompose:${request.id}` },
    subTasks: [],
    progress: { done: 0, total: 0 },
    planValidation: { ok: false, problems: hardProblems, checkedAt: nowIso },
    coordinatorBlocked: { signature: `plan-invalid:${hardProblems.join(' | ')}`.slice(0, 300), since: nowIso, children: [], escalated: false },
    blockedReason: `decompose plan is not applyable as written: ${hardProblems.join('; ')}`.slice(0, 400),
    history: [{ stage: 'created', at: nowIso, detail: `file-decompose-to-hub: plan failed preflight -- ${hardProblems.length} problem(s), no children filed` }],
  };
  fs.writeFileSync(path.join(coordDir, `${hubId}.json`), `${JSON.stringify(hub, null, 2)}\n`);
  request.hubFiledAt = nowIso;
  request.hubId = hubId;
  request.hubChildIds = [];
  request.planRejected = hardProblems;
  fs.writeFileSync(requestFile, `${JSON.stringify(request, null, 2)}\n`);
  return { hubId, childCount: 0, blocked: true, problems: hardProblems };
}

function fileHub({ pipelineDir, repoRoot, requestFile, request, now }) {
  const validation = stackedEnabled() ? validatePlan(repoRoot, request) : { ok: true, hardProblems: [], moveMeta: request.moves.map(() => ({})) };
  if (!validation.ok) {
    return fileBlockedHub({ pipelineDir, requestFile, request, now, hardProblems: validation.hardProblems });
  }

  const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
  const coordDir = path.join(pipelineDir, 'queue', 'coordinating');
  fs.mkdirSync(adhocDir, { recursive: true });
  fs.mkdirSync(coordDir, { recursive: true });
  const nowIso = new Date(now).toISOString();
  const planSlug = slugify(request.id);
  const moves = request.moves;
  const stacked = stackedEnabled();
  const branch = `agent/decompose-${planSlug}`;

  // Deterministic wiring (wire-decomposed-blueprints.js): for flask-blueprint moves the
  // coordinator splices the `register_blueprint` block itself once every move child is
  // done -- no LLM wiring child. Anything else (script-extract, plain require) still gets
  // an LLM wiring child, scoped to just those moves. Kill switch: DECOMPOSE_DET_WIRING.
  const bpMoves = moves.filter((m) => m.kind === 'flask-blueprint');
  const otherMoves = moves.filter((m) => m.kind !== 'flask-blueprint');
  const useDetWiring = stacked && bpMoves.length > 0
    && process.env.AGENT_MANAGER_DECOMPOSE_DET_WIRING !== 'false';
  const fileWiringChild = !useDetWiring || otherMoves.length > 0;
  const wiringChildMoves = useDetWiring ? otherMoves : moves;
  const wiringChildCount = fileWiringChild ? 1 : 0;

  const children = [];
  const moveIds = [];
  let prevId = null;
  moves.forEach((move, i) => {
    const id = `adhoc-decompose-${planSlug}-${String(i + 1).padStart(2, '0')}-${slugify(path.basename(move.newFile))}`.slice(0, 120);
    moveIds.push(id);
    const record = {
      id,
      domain: 'adhoc',
      source: 'manual',
      title: `Decompose ${request.sourceFile} → ${move.newFile}`,
      createdAt: nowIso,
      promptContext: {
        rawText: moveRawText(request, move, i, moves.length, validation.moveMeta[i]),
        decomposedFrom: `file-decompose:${request.id}`,
        moveIndex: i,
        newFile: move.newFile,
      },
    };
    if (stacked) {
      record.atomic = true;
      record.noDecompose = true;
      record.stacked = { branch, seq: i + 1, total: moves.length + wiringChildCount };
      if (prevId) record.dependsOn = [prevId];
    }
    fs.writeFileSync(path.join(adhocDir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    children.push({ id, title: record.title, status: 'pending' });
    prevId = id;
  });

  // Final wiring task. In stacked mode it depends only on the last move (the chain is
  // sequential); in legacy mode it waits on every move being merged. Skipped entirely when
  // every move is a flask-blueprint the coordinator wires deterministically.
  if (fileWiringChild) {
    const wireId = `adhoc-decompose-${planSlug}-99-wiring`.slice(0, 120);
    const wiringMetas = wiringChildMoves.map((m) => validation.moveMeta[moves.indexOf(m)]);
    const wiringRecord = {
      id: wireId,
      domain: 'adhoc',
      source: 'manual',
      title: `Decompose ${request.sourceFile} — wire up ${wiringChildMoves.length} new file(s)`,
      createdAt: nowIso,
      dependsOn: stacked ? [prevId] : moveIds,
      promptContext: { rawText: wiringRawText(request, wiringChildMoves, wiringMetas), decomposedFrom: `file-decompose:${request.id}` },
    };
    if (stacked) {
      wiringRecord.atomic = true;
      wiringRecord.noDecompose = true;
      wiringRecord.stacked = { branch, seq: moves.length + 1, total: moves.length + wiringChildCount };
    }
    fs.writeFileSync(path.join(adhocDir, `${wireId}.json`), `${JSON.stringify(wiringRecord, null, 2)}\n`);
    children.push({ id: wireId, title: `wire up ${wiringChildMoves.length} new file(s)`, status: 'pending' });
  }

  const hubId = `file-decompose-hub-${planSlug}`;
  const hub = {
    id: hubId,
    domain: 'adhoc',
    source: 'manual',
    status: 'coordinating',
    adhocResolution: 'decompose',
    title: `Decompose ${request.sourceFile} (${moves.length} module(s))`,
    createdAt: nowIso,
    promptContext: { rawText: `Coordinator for the ${request.id} decomposition of ${request.sourceFile}.`, decomposedFrom: `file-decompose:${request.id}` },
    subTasks: children,
    progress: { done: 0, total: children.length },
    planValidation: { ok: true, sharedDeps: validation.moveMeta.map((m) => m.sharedDeps || []), checkedAt: nowIso },
    history: [{ stage: 'created', at: nowIso, detail: `file-decompose-to-hub: filed ${moves.length} move task(s)${useDetWiring ? ` + deterministic wiring for ${bpMoves.length} blueprint(s)` : ''}${fileWiringChild ? ` + 1 LLM wiring task${useDetWiring ? ` for ${otherMoves.length} non-blueprint move(s)` : ''}` : ''}${stacked ? ` (stacked on ${branch})` : ''}` }],
  };
  if (stacked) {
    hub.mode = 'stacked';
    hub.branch = branch;
    hub.sourceFile = request.sourceFile;
    hub.integrationGate = { status: 'pending' };
  }
  if (useDetWiring) {
    hub.wiringPending = true;
    hub.wiringMoves = bpMoves.map((m) => ({ newFile: m.newFile, blueprint: m.blueprint, kind: m.kind }));
  }
  fs.writeFileSync(path.join(coordDir, `${hubId}.json`), `${JSON.stringify(hub, null, 2)}\n`);

  request.hubFiledAt = nowIso;
  request.hubId = hubId;
  request.hubChildIds = children.map((c) => c.id);
  if (stacked) request.branch = branch;
  fs.writeFileSync(requestFile, `${JSON.stringify(request, null, 2)}\n`);
  return { hubId, childCount: children.length, stacked, branch: stacked ? branch : undefined };
}

function sweep({ pipelineDir, repoRoot, force = false, now = Date.now() } = {}) {
  const summary = { checked: 0, filedHubs: 0, blockedHubs: 0, errors: 0, skipped: [] };
  if (process.env.AGENT_MANAGER_FILE_DECOMPOSE_TO_HUB === 'false') return summary;
  const requestsDir = path.join(pipelineDir, 'queue', 'file-decompose-requests');
  let resolvedRepoRoot = repoRoot;
  if (!resolvedRepoRoot) {
    try { ({ repoRoot: resolvedRepoRoot } = getConfig()); } catch (err) { console.error(`[file-decompose-to-hub] sweep: getConfig() failed; falling back to pipelineDir as repoRoot: ${err.message}`, err.stack); resolvedRepoRoot = pipelineDir; }
  }

  for (const { full, request } of readRequests(requestsDir)) {
    if (request.hubFiledAt && !force) { summary.skipped.push(`${request.id}: hub already filed`); continue; }
    if (request.moves.length === 0) { summary.skipped.push(`${request.id}: no moves`); continue; }
    summary.checked += 1;
    try {
      const res = fileHub({ pipelineDir, repoRoot: resolvedRepoRoot, requestFile: full, request, now });
      summary[request.id] = res;
      if (res.blocked) summary.blockedHubs += 1;
      else summary.filedHubs += 1;
    } catch (e) {
      console.error(`[file-decompose-to-hub] ${request.id}: ${e && e.message}`);
      summary.errors += 1;
    }
  }
  return summary;
}

module.exports = { sweep, moveRawText, wiringRawText, validatePlan, staticCheckMove };

if (require.main === module) {
  const force = process.argv.includes('--force');
  const { pipelineDir, repoRoot } = getConfig();
  const s = sweep({ pipelineDir, repoRoot, force });
  const parts = [`checked=${s.checked}`, `filedHubs=${s.filedHubs}`, `blockedHubs=${s.blockedHubs}`, `errors=${s.errors}`];
  if (s.skipped.length) parts.push(`skipped=[${s.skipped.join('; ')}]`);
  console.log(`file-decompose-to-hub: ${parts.join(' ')}`);
  process.exit(0);
}
