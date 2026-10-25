#!/usr/bin/env node
'use strict';

// Compare the shared instances dir that every GPU-touching process resolves (see src/instances-dir-consistency.js for why). Read-only: it reads
// /proc/<pid>/environ and the pid files, writes nothing. Prints ONE JSON line {ok, mismatches, checked} and exits 0 when everything agrees, 1 when not.
//
//   node scripts/check-instances-dir.js [--include-dashboard]
//
// Compared: the lane and reviewer daemons named by ~/.local/state/agent-manager/pids/{worker-*,review-runner*}.pid, and every running
// `src/local-tool-client.js` (a chat turn's node child). The dashboard process itself is NOT compared by default: its own os.environ is stale by
// design (python/dashboard/app.py _active_project_setting -- the env FILE wins there), so it would report a permanent false mismatch; what matters
// is what its children hold, and the chat child is pinned (HUB0197-01). --include-dashboard adds it for debugging (found by its command line,
// because dashboard.pid can go stale). Unreadable /proc entries are skipped.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { findInstancesDirMismatches, parseEnviron } = require('../src/instances-dir-consistency.js');

const PIDS_DIR = path.join(process.env.HOME || os.homedir(), '.local/state/agent-manager/pids');

function readEnv(pid) {
  try { return parseEnviron(fs.readFileSync(`/proc/${pid}/environ`, 'latin1')); } catch { return null; }
}

function pidFileEntries() {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(PIDS_DIR); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith('.pid')) continue;
    const label = name.slice(0, -'.pid'.length);
    if (!(label.startsWith('worker-') || label.startsWith('review-runner'))) continue;
    const pid = Number(String(fs.readFileSync(path.join(PIDS_DIR, name), 'utf8')).trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const env = readEnv(pid);
    if (env) out.push({ label, pid, env });
  }
  return out;
}

// Every running process with an argv token that ENDS WITH `needle` (a script path), as entries labelled `${prefix}-${pid}`. Matching a token, not a substring
// of the whole command line, keeps a shell whose -c text merely mentions the script (this one, a grep) from matching itself.
function procEntries(needle, prefix) {
  const out = [];
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return out; }
  for (const p of pids) {
    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${p}/cmdline`, 'latin1'); } catch { continue; }
    if (!cmd.split('\0').some((arg) => arg.endsWith(needle))) continue;
    const env = readEnv(p);
    if (env) out.push({ label: `${prefix}-${p}`, pid: Number(p), env });
  }
  return out;
}

const chatChildEntries = () => procEntries('src/local-tool-client.js', 'chat-child');
const dashboardEntries = () => procEntries('python/dashboard/app.py', 'dashboard');

function main() {
  const entries = [...pidFileEntries(), ...chatChildEntries(), ...(process.argv.includes('--include-dashboard') ? dashboardEntries() : [])];
  const realpath = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const mismatches = findInstancesDirMismatches(entries, { realpath });
  const ok = mismatches.length === 0;
  process.stdout.write(`${JSON.stringify({ ok, mismatches, checked: entries.map((e) => e.label) })}\n`);
  process.exit(ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { pidFileEntries, chatChildEntries, dashboardEntries };
