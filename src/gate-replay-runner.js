'use strict';

// Sandbox-side half of the gate replay (src/gate-replay.js). Copied into the scratch worktree by the host and run there under bwrap, because it loads and
// executes a gate function from a diff that has not been reviewed yet. Deliberately dependency-free (fs + path only) so the copy needs nothing else.
//
//   node runner.js <input.json> <output.json>
//
// input:  { file, fn, basePath|null, items: [{ id, merged, args }], polarity: 'flag-truthy'|'pass-flag'|..., worktreeDir }
// output: { after: Side, before: Side|null } where Side = { n, flagged: [{ id, merged, detail }], errors, loadError }
// The gate is called once per item with item.args. Whatever it returns is normalised by classify() into flagged / not flagged; a throw counts as an error, never as a flag.

const fs = require('fs');
const path = require('path');

const NAME_FLAG_RE = /^(is|has|should|looks?|detect|find|contains|violates?|needs?)/i;
const NAME_PASS_RE = /(ok|valid|compliant|allowed|passes|safe|clean)$/i;

// Returns { flagged: boolean|null, detail }. null = cannot tell (an ambiguous boolean).
function classify(result, fnName) {
  if (result === null || result === undefined) return { flagged: false, detail: '' };
  if (Array.isArray(result)) return { flagged: result.length > 0, detail: result.length ? JSON.stringify(result[0]).slice(0, 160) : '' };
  if (typeof result === 'object') {
    if (typeof result.pass === 'boolean') return { flagged: !result.pass, detail: JSON.stringify(result.violations || result.problems || result.reason || '').slice(0, 160) };
    if (typeof result.ok === 'boolean') return { flagged: !result.ok, detail: JSON.stringify(result.reason || result.problems || '').slice(0, 160) };
    for (const k of ['flagged', 'truncated', 'blocked', 'rejected', 'failed', 'invalid', 'violation', 'degenerate']) {
      if (typeof result[k] === 'boolean') return { flagged: result[k], detail: JSON.stringify(result.reason || result.detail || '').slice(0, 160) };
    }
    for (const k of ['violations', 'problems', 'flags', 'findings']) {
      if (Array.isArray(result[k])) return { flagged: result[k].length > 0, detail: result[k].length ? JSON.stringify(result[k][0]).slice(0, 160) : '' };
    }
    return { flagged: true, detail: JSON.stringify(result).slice(0, 160) };
  }
  if (typeof result === 'boolean') {
    if (NAME_PASS_RE.test(fnName)) return { flagged: !result, detail: '' };
    if (NAME_FLAG_RE.test(fnName)) return { flagged: result, detail: '' };
    return { flagged: null, detail: 'boolean result with an ambiguous function name' };
  }
  return { flagged: !!result, detail: String(result).slice(0, 160) };
}

function runSide(modulePath, fnName, items, worktreeDir) {
  const side = { n: 0, flagged: [], errors: 0, ambiguous: 0, loadError: null };
  let fn;
  try {
    const mod = require(modulePath);
    fn = mod[fnName];
    if (typeof fn !== 'function') { side.loadError = `${fnName} is not exported by ${path.basename(modulePath)}`; return side; }
  } catch (e) { side.loadError = `could not load ${path.basename(modulePath)}: ${String(e && e.message).slice(0, 200)}`; return side; }
  for (const item of items) {
    side.n += 1;
    try {
      const args = (item.args || []).map((a) => (a === '__WORKTREE__' ? worktreeDir : a));
      const r = classify(fn(...args), fnName);
      if (r.flagged === null) side.ambiguous += 1;
      else if (r.flagged) side.flagged.push({ id: item.id, merged: !!item.merged, detail: r.detail });
    } catch (e) { side.errors += 1; }
  }
  return side;
}

function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const worktreeDir = input.worktreeDir || process.cwd();
  const out = {
    after: runSide(path.resolve(worktreeDir, input.file), input.fn, input.items, worktreeDir),
    before: input.basePath ? runSide(path.resolve(worktreeDir, input.basePath), input.fn, input.items, worktreeDir) : null,
  };
  fs.writeFileSync(outputPath, JSON.stringify(out));
}

if (require.main === module) main();
module.exports = { classify };
