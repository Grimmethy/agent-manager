'use strict';

// The Kernel's required-plugins manifest and its check (roadmap: required plugins are separate repos but AM cannot run without them; a missing or out-of-range one must fail LOUDLY, never
// be skipped silently -- the same rule scripts/queue-watcher.sh applies to agent-manager-hub-tasks). Data-driven: config/required-plugins.json lists only the plugins that exist as separate
// repos today; the extraction tasks add the others (adhoc, draft, review, apply, merge, models).
//
//   { "requiredPlugins": [ { "name": "agent-manager-hub-tasks", "range": "^0.1.0", "entry": "register.js" } ] }
//
// name   the plugin's name in plugins.json (resolved by src/resolve-plugin-root.js, enabled entries only)
// range  a semver range the plugin's package.json "version" must satisfy (the releases are a pinned set). Supported: exact, =, >, >=, <, <=, ^, ~, x-ranges and *, comparators joined by
//        spaces (AND) or `||` (OR). Pre-release and build tags are ignored. Anything else is an INVALID_RANGE, never a silent pass.
// entry  a file the plugin root must contain (default register.js)
//
// check -> { ok, results: [{ name, range, status, found, root, message }] } with status ok | MISSING | NO_VERSION | OUT_OF_RANGE | INVALID_RANGE | NO_ENTRY.
// CLI: `node src/required-plugins.js [--config <file>] [--json]` prints the status, writes the loud failure to stderr and exits 3 when anything is unmet (2 when the config itself is unusable).

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONFIG = path.join(__dirname, '..', 'config', 'required-plugins.json');
const STATUSES = ['ok', 'MISSING', 'NO_VERSION', 'OUT_OF_RANGE', 'INVALID_RANGE', 'NO_ENTRY'];

class RequiredPluginError extends Error {
  constructor(message, results = []) { super(message); this.name = 'RequiredPluginError'; this.results = results; }
}

// ---- a small semver subset ---------------------------------------------------------------------------------------------------------------------------------------------------------

const NUM = '(0|[1-9]\\d*|[xX*])';
const PARTIAL = new RegExp(`^v?${NUM}(?:\\.${NUM}(?:\\.${NUM})?)?(?:[-+][0-9A-Za-z.+-]*)?$`);

function parseVersion(text) {
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.+-]*)?$/.exec(String(text || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const compare = (a, b) => { for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; };
const isWild = (s) => s === undefined || /^[xX*]$/.test(s);

// A partial version ("1", "1.2", "1.x", "1.2.3") -> { parts: [n...] up to the first wildcard } or null when it is not one.
function parsePartial(text) {
  const m = PARTIAL.exec(String(text || '').trim());
  if (!m) return null;
  const parts = [];
  for (const s of [m[1], m[2], m[3]]) { if (isWild(s)) break; parts.push(Number(s)); }
  return { parts };
}

const pad = (parts) => [parts[0] || 0, parts[1] || 0, parts[2] || 0];

// One comparator token -> a list of [op, version] bounds that must all hold, or null when invalid.
function bounds(token) {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(token);
  if (!m) return null;
  const op = m[1] || '';
  const partial = parsePartial(m[2]);
  if (!partial) return null;
  const { parts } = partial;
  if (parts.length === 0) return op === '' || op === '=' || op === '^' || op === '~' || op === '>=' ? [['>=', [0, 0, 0]]] : null;   // "*" and "x"
  const lo = pad(parts);
  if (op === '>' ) return [['>=', parts.length === 3 ? [lo[0], lo[1], lo[2] + 1] : parts.length === 2 ? [lo[0], lo[1] + 1, 0] : [lo[0] + 1, 0, 0]]];
  if (op === '>=') return [['>=', lo]];
  if (op === '<') return [['<', lo]];
  if (op === '<=') return [['<', parts.length === 3 ? [lo[0], lo[1], lo[2] + 1] : parts.length === 2 ? [lo[0], lo[1] + 1, 0] : [lo[0] + 1, 0, 0]]];
  if (op === '^') {
    const hi = lo[0] > 0 || parts.length === 1 ? [lo[0] + 1, 0, 0] : lo[1] > 0 || parts.length === 2 ? [0, lo[1] + 1, 0] : [0, 0, lo[2] + 1];
    return [['>=', lo], ['<', hi]];
  }
  if (op === '~') return [['>=', lo], ['<', parts.length === 1 ? [lo[0] + 1, 0, 0] : [lo[0], lo[1] + 1, 0]]];
  // exact, "=" or an x-range: 1.2.3 is exactly that; 1.2 or 1.2.x is [1.2.0, 1.3.0); 1 or 1.x is [1.0.0, 2.0.0)
  if (parts.length === 3) return [['>=', lo], ['<', [lo[0], lo[1], lo[2] + 1]]];
  if (parts.length === 2) return [['>=', lo], ['<', [lo[0], lo[1] + 1, 0]]];
  return [['>=', lo], ['<', [lo[0] + 1, 0, 0]]];
}

// A range -> an array of alternatives, each an array of bounds; null when any part is invalid.
function parseRange(range) {
  const text = String(range === undefined || range === null ? '' : range).trim();
  if (!text) return null;
  const alts = [];
  for (const alt of text.split('||')) {
    const tokens = alt.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    const all = [];
    for (const t of tokens) { const b = bounds(t); if (!b) return null; all.push(...b); }
    alts.push(all);
  }
  return alts;
}

const validRange = (range) => parseRange(range) !== null;

function satisfies(version, range) {
  const v = parseVersion(version);
  const alts = parseRange(range);
  if (!v || !alts) return false;
  return alts.some((all) => all.every(([op, bound]) => (op === '>=' ? compare(v, bound) >= 0 : compare(v, bound) < 0)));
}

// ---- the manifest and the check ----------------------------------------------------------------------------------------------------------------------------------------------------

// The required entries of a config file; throws RequiredPluginError (loudly) on an unusable file or entry.
function loadRequired(file = DEFAULT_CONFIG, fsImpl = fs) {
  let data;
  try { data = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch (e) { throw new RequiredPluginError(`the required-plugins config ${file} cannot be read: ${e.message}`); }
  const list = data && data.requiredPlugins;
  if (!Array.isArray(list)) throw new RequiredPluginError(`the required-plugins config ${file} has no requiredPlugins array`);
  const seen = new Set();
  return list.map((e, i) => {
    if (!e || typeof e.name !== 'string' || !e.name.trim() || typeof e.range !== 'string' || !e.range.trim()) throw new RequiredPluginError(`requiredPlugins[${i}] in ${file} needs a name and a range`);
    if (seen.has(e.name)) throw new RequiredPluginError(`requiredPlugins in ${file} lists ${e.name} twice`);
    seen.add(e.name);
    return { name: e.name.trim(), range: e.range.trim(), entry: typeof e.entry === 'string' && e.entry.trim() ? e.entry.trim() : 'register.js' };
  });
}

function defaultReadVersion(root, fsImpl = fs) {
  try { const v = JSON.parse(fsImpl.readFileSync(path.join(root, 'package.json'), 'utf8')).version; return typeof v === 'string' ? v : null; } catch { return null; }
}

function checkOne(req, { resolveRoot, readVersion, exists }) {
  const base = { name: req.name, range: req.range, found: null, root: null };
  const make = (status, message) => ({ ...base, status, message });
  if (!validRange(req.range)) return make('INVALID_RANGE', `${req.name}: the range "${req.range}" is not a supported semver range`);
  const root = resolveRoot(req.name);
  if (!root) return make('MISSING', `${req.name}: not found or not enabled in plugins.json (needs ${req.range})`);
  base.root = root;
  const found = readVersion(root);
  base.found = found;
  if (!found || !parseVersion(found)) return make('NO_VERSION', `${req.name}: ${root}/package.json has no usable version (needs ${req.range})`);
  if (!satisfies(found, req.range)) return make('OUT_OF_RANGE', `${req.name}: version ${found} is outside ${req.range} (installed at ${root})`);
  if (!exists(path.join(root, req.entry))) return make('NO_ENTRY', `${req.name}: ${root} has no ${req.entry}`);
  return make('ok', `${req.name} ${found} satisfies ${req.range}`);
}

// check({ required, resolveRoot, readVersion, exists }) -> { ok, results }; every dependency is injectable. Never throws for a plugin problem: the result says what is wrong.
function checkRequiredPlugins({ required, resolveRoot, readVersion = defaultReadVersion, exists = (p) => fs.existsSync(p) } = {}) {
  const list = required || loadRequired();
  const resolve = resolveRoot || ((name) => require('./resolve-plugin-root.js').resolvePluginRoot(name));
  const results = list.map((req) => checkOne(req, { resolveRoot: resolve, readVersion, exists }));
  return { ok: results.every((r) => r.status === 'ok'), results };
}

// The loud, readable failure text for the unmet entries (empty string when all are met).
function failureText(results) {
  const bad = results.filter((r) => r.status !== 'ok');
  if (bad.length === 0) return '';
  return [`[required-plugins] ERROR: ${bad.length} required plugin(s) unmet -- Agent Manager cannot run without them:`, ...bad.map((r) => `  - [${r.status}] ${r.message}`),
    'Install or enable the plugin (plugins.json) at a version inside the range, or change config/required-plugins.json deliberately.'].join('\n');
}

// Throws RequiredPluginError with failureText when anything is unmet; returns the check otherwise.
function assertRequiredPlugins(opts) {
  const res = checkRequiredPlugins(opts);
  if (!res.ok) throw new RequiredPluginError(failureText(res.results), res.results);
  return res;
}

function main(argv, { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`), fsImpl = fs, resolveRoot } = {}) {
  const at = argv.indexOf('--config');
  const file = at >= 0 && argv[at + 1] ? argv[at + 1] : DEFAULT_CONFIG;
  let required;
  try { required = loadRequired(file, fsImpl); } catch (e) { err(`[required-plugins] ERROR: ${e.message}`); return 2; }
  const res = checkRequiredPlugins({ required, resolveRoot });
  if (argv.includes('--json')) out(JSON.stringify(res)); else for (const r of res.results) out(`${r.status === 'ok' ? 'ok     ' : r.status.padEnd(7)} ${r.message}`);
  if (!res.ok) { err(failureText(res.results)); return 3; }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { RequiredPluginError, STATUSES, DEFAULT_CONFIG, parseVersion, parseRange, validRange, satisfies, loadRequired, checkRequiredPlugins, assertRequiredPlugins, failureText, main };
