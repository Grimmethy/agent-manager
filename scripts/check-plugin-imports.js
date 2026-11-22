#!/usr/bin/env node
'use strict';

// Plugin import boundary: plugins may import from the agent-manager checkout only what
// docs/PLUGIN_API.md documents (the "public surface"). This script scans the plugin repos
// named in plugins.json for `require('agent-manager/src/<module>')` and reports every
// module that is neither public nor on the frozen allowlist in
// scripts/plugin-import-boundary.json. The allowlist is keyed "plugin:file:module" and may
// only shrink: `--shrink` drops entries that no longer occur, only `--init` adds entries.
//
// Usage: node scripts/check-plugin-imports.js [--init | --shrink]

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_PLUGINS_JSON = path.join(REPO_ROOT, 'plugins.json');
const DEFAULT_BOUNDARY_JSON = path.join(__dirname, 'plugin-import-boundary.json');
const DEFAULT_API_DOC = path.join(REPO_ROOT, 'docs', 'PLUGIN_API.md');
const CORE_REQUIRE = /require\(\s*['"]agent-manager\/src\/([^'"]+)['"]\s*\)/g;

// Module paths (relative to src/) imported by one plugin source text.
function extractCoreImports(src) {
  return [...src.matchAll(CORE_REQUIRE)].map((m) => m[1]);
}

function walkJs(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  return entries.flatMap((e) => {
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === '.git' ? [] : walkJs(path.join(dir, e.name));
    return e.name.endsWith('.js') ? [path.join(dir, e.name)] : [];
  });
}

// Every "plugin:file:module" key for non-public imports found in one plugin directory.
function scanPlugin(pluginDir, publicModules) {
  const pluginName = path.basename(pluginDir);
  const keys = [];
  for (const file of walkJs(pluginDir)) {
    const rel = path.relative(pluginDir, file);
    for (const mod of new Set(extractCoreImports(fs.readFileSync(file, 'utf8')))) {
      if (!publicModules.includes(mod)) keys.push(`${pluginName}:${rel}:${mod}`);
    }
  }
  return keys;
}

// Plugin repo directories from a plugins.json (a bare list, or {plugins: [...]}); entries
// without a registerPath are skipped.
function pluginDirs(pluginsConfig) {
  const list = Array.isArray(pluginsConfig) ? pluginsConfig : (pluginsConfig.plugins || []);
  return list.filter((p) => p && p.registerPath).map((p) => path.dirname(p.registerPath));
}

// Public modules = every src module (src/<m>, src/sdk/<m>, src/lib/<m>) that the API doc
// names, plus everything under src/sdk. Returned relative to src/, sorted.
function derivePublicModules(docText, srcDir) {
  const named = new Set();
  for (const m of docText.matchAll(/(?:src\/)?((?:sdk\/|lib\/)?[A-Za-z0-9_-]+\.js)\b/g)) {
    if (fs.existsSync(path.join(srcDir, m[1]))) named.add(m[1]);
  }
  const sdkDir = path.join(srcDir, 'sdk');
  if (fs.existsSync(sdkDir)) {
    for (const f of fs.readdirSync(sdkDir)) if (f.endsWith('.js') && !f.endsWith('.test.js')) named.add(`sdk/${f}`);
  }
  return [...named].sort();
}

// Scan every plugin; returns { current: [keys], missing: [dirs] }.
function scanAll(pluginsConfig, publicModules) {
  const current = [];
  const missing = [];
  for (const dir of pluginDirs(pluginsConfig)) {
    if (!fs.existsSync(dir)) { missing.push(dir); continue; }
    current.push(...scanPlugin(dir, publicModules));
  }
  return { current: current.sort(), missing };
}

// Compare a scan with the frozen allowlist: new violations fail, stale entries are reported.
function compare(current, allowlist) {
  const allowed = new Set(allowlist);
  const seen = new Set(current);
  return {
    violations: current.filter((k) => !allowed.has(k)),
    stale: allowlist.filter((k) => !seen.has(k)),
  };
}

function loadJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function checkPluginImports(opts = {}) {
  const pluginsJson = opts.pluginsJson || DEFAULT_PLUGINS_JSON;
  const boundaryJson = opts.boundaryJson || DEFAULT_BOUNDARY_JSON;
  let pluginsConfig;
  try { pluginsConfig = loadJson(pluginsJson); } catch (e) {
    return { skipped: `cannot read ${pluginsJson}: ${e.message}`, violations: [], stale: [], missing: [], scanned: 0 };
  }
  const boundary = loadJson(boundaryJson);
  const { current, missing } = scanAll(pluginsConfig, boundary.publicModules || []);
  if (missing.length) {
    return { skipped: `plugin repo(s) not present: ${missing.join(', ')}`, violations: [], stale: [], missing, scanned: current.length };
  }
  const { violations, stale } = compare(current, boundary.allowlist || []);
  return { skipped: null, violations, stale, missing, scanned: current.length };
}

function main(argv) {
  const init = argv.includes('--init');
  const shrink = argv.includes('--shrink');
  if (init || shrink) {
    const boundary = fs.existsSync(DEFAULT_BOUNDARY_JSON) ? loadJson(DEFAULT_BOUNDARY_JSON) : {};
    const publicModules = init
      ? derivePublicModules(fs.readFileSync(DEFAULT_API_DOC, 'utf8'), path.join(REPO_ROOT, 'src'))
      : boundary.publicModules;
    const { current, missing } = scanAll(loadJson(DEFAULT_PLUGINS_JSON), publicModules);
    if (missing.length) { console.error(`refusing to rewrite: missing ${missing.join(', ')}`); return 2; }
    const allowlist = init ? current : (boundary.allowlist || []).filter((k) => current.includes(k));
    fs.writeFileSync(DEFAULT_BOUNDARY_JSON, `${JSON.stringify({ publicModules, allowlist }, null, 2)}\n`);
    console.log(`wrote ${DEFAULT_BOUNDARY_JSON}: ${publicModules.length} public modules, ${allowlist.length} allowlisted imports`);
    return 0;
  }
  const r = checkPluginImports();
  if (r.skipped) { console.log(`SKIPPED: ${r.skipped}`); return 0; }
  if (r.stale.length) console.log(`stale allowlist entries (run --shrink):\n  ${r.stale.join('\n  ')}`);
  if (r.violations.length) { console.error(`Boundary violations:\n  ${r.violations.join('\n  ')}`); return 1; }
  console.log(`OK: ${r.scanned} non-public imports, all on the frozen allowlist`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { extractCoreImports, scanPlugin, pluginDirs, derivePublicModules, scanAll, compare, checkPluginImports };
