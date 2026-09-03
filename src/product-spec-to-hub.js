'use strict';

// product_spec -> coordinator-hub bridge (2026-09-03, Grimmethy: "re-file them as
// product_specs" + "spec then hub").
//
// Brownfield product_spec produces spec DOCUMENTATION only: product_spec_outline
// grep-decomposes a request into `### AC-NNN` sections and seeds Docs/PRODUCT_SPEC.md as an
// ordered marker skeleton (product-spec-assembly.js); product_spec_section then fills each
// `<!-- section:AC-N -->` block. Nothing turned a finished section into an implementation
// task -- the spec just sat there.
//
// For a request file in queue/product-spec-requests/ that sets `buildHub: true`, once
// EVERY section of the spec is filled (no `_(pending)_` placeholder left), this
// watchdog-tick sweep files a coordinator hub in queue/coordinating/ plus one child adhoc
// task per section in queue/adhoc/, each grounded in that section's real spec prose.
// coordinator-sweep.js then reconciles the children and auto-completes the hub.
//
// No inter-section dependsOn edges: the apply stage builds each task in its own git
// worktree with a 3-way merge + retry, which handles the common shared-file case, and a
// rigid chain would let one blocked section halt the whole feature. Kill switch:
// AGENT_MANAGER_PRODUCT_SPEC_TO_HUB=false.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config.js');
const { SPEC_PENDING_PLACEHOLDER } = require('./product-spec-assembly.js');

// <!-- section:AC-3 -->\n## Title\n\n<body>\n<!-- /section:AC-3 -->
const SECTION_RE = /<!-- section:(AC-\d+) -->\r?\n## (.+?)\r?\n\r?\n([\s\S]*?)\r?\n<!-- \/section:\1 -->/g;

function parseSpecSections(specText) {
  const out = [];
  const s = String(specText || '');
  let m;
  SECTION_RE.lastIndex = 0;
  while ((m = SECTION_RE.exec(s))) {
    const body = m[3].trim();
    out.push({ id: m[1], title: m[2].trim(), body, filled: body !== '' && body !== SPEC_PENDING_PLACEHOLDER });
  }
  return out;
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 55) || 'section';
}

function readRequests(requestsDir) {
  let names;
  try { names = fs.readdirSync(requestsDir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    const full = path.join(requestsDir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (parsed && typeof parsed.id === 'string') out.push({ full, request: parsed });
    } catch { /* skip malformed */ }
  }
  return out;
}

function childRawText(request, sec) {
  return [
    `Implement this section of the "${request.title || request.id}" spec (${sec.id}, in ${request.specRelPath || 'Docs/PRODUCT_SPEC.md'}).`,
    '',
    `## ${sec.title}`,
    '',
    sec.body,
    '',
    'This is ONE independently-shippable piece. Ground every change in the real current code '
      + '(grep the paths the section names). Implement exactly this section -- do NOT re-plan the '
      + 'whole feature. If it genuinely still spans several files that each need real work, '
      + 'decompose into those specific pieces.',
  ].join('\n');
}

function fileHub({ pipelineDir, requestFile, request, sections, now }) {
  const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
  const coordDir = path.join(pipelineDir, 'queue', 'coordinating');
  fs.mkdirSync(adhocDir, { recursive: true });
  fs.mkdirSync(coordDir, { recursive: true });
  const nowIso = new Date(now).toISOString();

  const children = [];
  for (const sec of sections) {
    const id = `adhoc-spec-${slugify(request.id)}-${sec.id.toLowerCase()}-${slugify(sec.title)}`.slice(0, 120);
    const record = {
      id,
      domain: 'adhoc',
      source: 'manual',
      title: `${sec.id}: ${sec.title}`,
      createdAt: nowIso,
      promptContext: {
        rawText: childRawText(request, sec),
        decomposedFrom: `product-spec:${request.id}`,
        specSection: sec.id,
      },
    };
    fs.writeFileSync(path.join(adhocDir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    children.push({ id, title: record.title, status: 'pending' });
  }

  const hubId = `product-spec-hub-${slugify(request.id)}`;
  const hub = {
    id: hubId,
    domain: 'adhoc',
    source: 'manual',
    status: 'coordinating',
    adhocResolution: 'decompose',
    title: `Product spec build: ${request.title || request.id}`,
    createdAt: nowIso,
    promptContext: { rawText: `Coordinator for the ${children.length} sections of product spec "${request.id}".`, decomposedFrom: `product-spec:${request.id}` },
    subTasks: children,
    progress: { done: 0, total: children.length },
    history: [{ stage: 'created', at: nowIso, detail: `product-spec-to-hub: filed ${children.length} child task(s) from filled spec sections` }],
  };
  fs.writeFileSync(path.join(coordDir, `${hubId}.json`), `${JSON.stringify(hub, null, 2)}\n`);

  request.hubFiledAt = nowIso;
  request.hubId = hubId;
  request.hubChildIds = children.map((c) => c.id);
  fs.writeFileSync(requestFile, `${JSON.stringify(request, null, 2)}\n`);

  return { hubId, childCount: children.length };
}

function sweep({ pipelineDir, force = false, now = Date.now() } = {}) {
  const summary = { checked: 0, filedHubs: 0, waiting: [], errors: 0 };
  if (process.env.AGENT_MANAGER_PRODUCT_SPEC_TO_HUB === 'false') return summary;

  const { productSpecPath } = getConfig();
  const requestsDir = path.join(pipelineDir, 'queue', 'product-spec-requests');
  let specText = '';
  try { specText = fs.readFileSync(productSpecPath, 'utf8'); } catch { /* no spec doc yet */ }
  const sections = parseSpecSections(specText);

  for (const { full, request } of readRequests(requestsDir)) {
    if (!request.buildHub || request.hubFiledAt) continue;
    summary.checked += 1;

    if (sections.length === 0) { summary.waiting.push(`${request.id}: outline not written yet`); continue; }
    const filled = sections.filter((s) => s.filled);
    if (!force && filled.length < sections.length) {
      summary.waiting.push(`${request.id}: ${filled.length}/${sections.length} sections filled`);
      continue;
    }
    if (filled.length === 0) { summary.waiting.push(`${request.id}: no sections filled yet`); continue; }
    const toBuild = filled; // always build only the filled sections; --force just skips the "wait for all" gate
    try {
      const r = fileHub({ pipelineDir, requestFile: full, request: { ...request, specRelPath: path.relative(getConfig().repoRoot, productSpecPath) }, sections: toBuild, now });
      summary.filedHubs += 1;
      summary[request.id] = r;
    } catch (e) {
      console.error(`[product-spec-to-hub] ${request.id}: ${e && e.message}`);
      summary.errors += 1;
    }
  }
  return summary;
}

module.exports = { sweep, parseSpecSections, childRawText };

if (require.main === module) {
  const force = process.argv.includes('--force');
  const { pipelineDir } = getConfig();
  const s = sweep({ pipelineDir, force });
  const parts = [`checked=${s.checked}`, `filedHubs=${s.filedHubs}`, `errors=${s.errors}`];
  if (s.waiting.length) parts.push(`waiting=[${s.waiting.join('; ')}]`);
  console.log(`product-spec-to-hub: ${parts.join(' ')}`);
  process.exit(0);
}
