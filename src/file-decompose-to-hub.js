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
// This watchdog-tick sweep turns each authored plan into a coordinator hub in
// queue/coordinating/ + one child adhoc task per move in queue/adhoc/ (each a small,
// bounded, independently-reviewable "move these named symbols verbatim" task the 27B can
// do), plus a final "wire it up" task that dependsOn every move. coordinator-sweep.js
// reconciles the hub (and its new stuck-detection surfaces a move that jams).
//
// Kill switch: AGENT_MANAGER_FILE_DECOMPOSE_TO_HUB=false. `--force` re-files (danger:
// duplicates children -- only after clearing a bad hub by hand).

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
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

// The bounded per-move instruction. `kind` picks the framing; the invariant across all of
// them: copy the NAMED symbols out verbatim, delete them from the source file, change
// NOTHING else, validate with a compile/parse check.
function moveRawText(request, move, index, total) {
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

function wiringRawText(request, moves) {
  const src = request.sourceFile;
  const lines = [
    `Final wiring for the ${request.id} decomposition of ${src}. All ${moves.length} move task(s) have merged -- the new files exist and their symbols are gone from ${src}. Now:`,
    '',
  ];
  const isPy = /\.py$/.test(src);
  const isTemplate = /\.html$/.test(src);
  for (const m of moves) {
    if (m.kind === 'flask-blueprint') {
      lines.push(`- ${src}: \`from ${slugify(path.basename(path.dirname(m.newFile)))}.${path.basename(m.newFile, '.py')} import ${m.blueprint}\` (match the real package path) and \`app.register_blueprint(${m.blueprint})\`, near the other blueprint registrations / right after \`app = Flask(...)\`.`);
    } else if (m.kind === 'script-extract') {
      lines.push(`- ${src}: add \`<script src="/static/js/${path.basename(m.newFile)}"></script>\` just before \`</script>\`'s closing area -- actually just before the final \`</body>\`/\`</script>\`, in an order where a file's dependencies load first (${path.basename(m.newFile)} after any core.js it calls).`);
    } else {
      lines.push(`- ${src}: \`require('./${path.relative(path.dirname(src), m.newFile).replace(/\\.js$/, '')}')\` (or import) and use the moved symbols from there.`);
    }
  }
  lines.push('',
    `Then: remove any now-unused imports from ${src}; ${isPy ? 'run `python3 -m py_compile` on it and every new file' : isTemplate ? 'extract the `<script>` block and run `node --check` on it' : 'run `node --check`'}; and do a quick smoke check that nothing that referenced a moved symbol from elsewhere in ${src} broke (grep ${src} for each moved symbol name -- there should be no bare call sites left, only the import).`,
    'Change NOTHING else.');
  return lines.join('\n');
}

function fileHub({ pipelineDir, requestFile, request, now }) {
  const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
  const coordDir = path.join(pipelineDir, 'queue', 'coordinating');
  fs.mkdirSync(adhocDir, { recursive: true });
  fs.mkdirSync(coordDir, { recursive: true });
  const nowIso = new Date(now).toISOString();
  const planSlug = slugify(request.id);
  const moves = request.moves;

  const children = [];
  const moveIds = [];
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
        rawText: moveRawText(request, move, i, moves.length),
        decomposedFrom: `file-decompose:${request.id}`,
        moveIndex: i,
        newFile: move.newFile,
      },
    };
    fs.writeFileSync(path.join(adhocDir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    children.push({ id, title: record.title, status: 'pending' });
  });

  // Final wiring task, gated on every move being merged.
  const wireId = `adhoc-decompose-${planSlug}-99-wiring`.slice(0, 120);
  fs.writeFileSync(path.join(adhocDir, `${wireId}.json`), `${JSON.stringify({
    id: wireId,
    domain: 'adhoc',
    source: 'manual',
    title: `Decompose ${request.sourceFile} — wire up the ${moves.length} new file(s)`,
    createdAt: nowIso,
    dependsOn: moveIds,
    promptContext: { rawText: wiringRawText(request, moves), decomposedFrom: `file-decompose:${request.id}` },
  }, null, 2)}\n`);
  children.push({ id: wireId, title: `wire up ${moves.length} new file(s)`, status: 'pending' });

  const hubId = `file-decompose-hub-${planSlug}`;
  fs.writeFileSync(path.join(coordDir, `${hubId}.json`), `${JSON.stringify({
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
    history: [{ stage: 'created', at: nowIso, detail: `file-decompose-to-hub: filed ${moves.length} move task(s) + 1 wiring task` }],
  }, null, 2)}\n`);

  request.hubFiledAt = nowIso;
  request.hubId = hubId;
  request.hubChildIds = children.map((c) => c.id);
  fs.writeFileSync(requestFile, `${JSON.stringify(request, null, 2)}\n`);
  return { hubId, childCount: children.length };
}

function sweep({ pipelineDir, force = false, now = Date.now() } = {}) {
  const summary = { checked: 0, filedHubs: 0, errors: 0, skipped: [] };
  if (process.env.AGENT_MANAGER_FILE_DECOMPOSE_TO_HUB === 'false') return summary;
  const requestsDir = path.join(pipelineDir, 'queue', 'file-decompose-requests');

  for (const { full, request } of readRequests(requestsDir)) {
    if (request.hubFiledAt && !force) { summary.skipped.push(`${request.id}: hub already filed`); continue; }
    if (request.moves.length === 0) { summary.skipped.push(`${request.id}: no moves`); continue; }
    summary.checked += 1;
    try {
      summary[request.id] = fileHub({ pipelineDir, requestFile: full, request, now });
      summary.filedHubs += 1;
    } catch (e) {
      console.error(`[file-decompose-to-hub] ${request.id}: ${e && e.message}`);
      summary.errors += 1;
    }
  }
  return summary;
}

module.exports = { sweep, moveRawText, wiringRawText };

if (require.main === module) {
  const force = process.argv.includes('--force');
  const { pipelineDir } = getConfig();
  const s = sweep({ pipelineDir, force });
  const parts = [`checked=${s.checked}`, `filedHubs=${s.filedHubs}`, `errors=${s.errors}`];
  if (s.skipped.length) parts.push(`skipped=[${s.skipped.join('; ')}]`);
  console.log(`file-decompose-to-hub: ${parts.join(' ')}`);
  process.exit(0);
}
