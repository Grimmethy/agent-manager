'use strict';

// The chat's owner-approved write commands, proposal side (owner decisions 2026-10-25; design: docs/write-command-allowlist-design.md in the
// agent-manager-chat-plugin repo, section 6). The chat may only PROPOSE a command: propose_command checks the exact command against the one central allowlist file and,
// when it is on it, records a proposal for the owner to confirm in the chat pane. Nothing runs here. The runner in core (python/dashboard/chat_command_runner.py)
// re-validates the same file before it ever executes anything, so the two parsers below and there must agree on what a valid entry is.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 900;
const KILL_SWITCH_NAME = '.chat-write-tools-disabled';

function allowlistPath() {
  return process.env.AGENT_MANAGER_CHAT_COMMAND_ALLOWLIST_PATH
    || path.join(os.homedir(), '.local', 'state', 'agent-manager-chat-plugin', 'command-allowlist.json');
}

function realOrResolved(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(String(p)); }
}

// The valid entries of the allowlist file as [{ repo (realpath), argv, env, timeoutSeconds }]. A missing, unreadable or malformed file is an empty allowlist;
// a malformed entry is skipped, never partly honoured.
function loadAllowlist(file) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file || allowlistPath(), 'utf8')); } catch { return []; }
  const commands = data && typeof data === 'object' && !Array.isArray(data) ? data.commands : null;
  if (!Array.isArray(commands)) return [];
  const out = [];
  for (const e of commands) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const env = e.env === undefined ? {} : e.env;
    const timeout = e.timeoutSeconds === undefined ? DEFAULT_TIMEOUT_S : e.timeoutSeconds;
    if (typeof e.repo !== 'string' || !path.isAbsolute(e.repo)) continue;
    if (!Array.isArray(e.argv) || !e.argv.length || !e.argv.every((a) => typeof a === 'string' && a)) continue;
    if (!env || typeof env !== 'object' || Array.isArray(env) || !Object.values(env).every((v) => typeof v === 'string')) continue;
    if (!Number.isInteger(timeout) || timeout <= 0) continue;
    out.push({ repo: realOrResolved(e.repo), argv: [...e.argv], env: { ...env }, timeoutSeconds: Math.min(timeout, MAX_TIMEOUT_S) });
  }
  return out;
}

// The entry whose repo realpath and argv are exactly the given ones, else null. No prefix, glob or partial match.
function findEntry(entries, repo, argv) {
  if (typeof repo !== 'string' || !repo || !Array.isArray(argv)) return null;
  const real = realOrResolved(repo);
  return entries.find((e) => e.repo === real && e.argv.length === argv.length && e.argv.every((a, i) => a === argv[i])) || null;
}

// What the tool returns for a proposal. Accepted: { ok: true, proposalId, status: 'awaiting-confirmation', proposal: { proposalId, repo, argv, why }, message }.
// Refused: { ok: false, error } -- naming why, and for an unlisted command which commands ARE allowed for that repo (never their env).
function proposeCommand({ repo, argv, why } = {}, { pipelineDir, allowlistFile } = {}) {
  if (typeof repo !== 'string' || !repo.trim()) return { ok: false, error: 'repo is required (an absolute repo path from list_projects or list_roots)' };
  if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === 'string' && a)) return { ok: false, error: 'argv must be a non-empty list of strings (the exact command, one string per word)' };
  if (typeof why !== 'string' || !why.trim()) return { ok: false, error: 'why is required: one sentence telling the owner what this command is for' };
  if (pipelineDir && fs.existsSync(path.join(pipelineDir, 'queue', KILL_SWITCH_NAME))) {
    return { ok: false, error: 'owner-approved commands are switched off right now (the chat write kill switch is present)' };
  }
  const entries = loadAllowlist(allowlistFile);
  const entry = findEntry(entries, repo, argv);
  if (!entry) {
    const real = realOrResolved(repo);
    const forRepo = entries.filter((e) => e.repo === real).map((e) => e.argv);
    return {
      ok: false,
      error: 'this exact command is not on the owner\'s allowlist for that repo, so it cannot be proposed. '
        + (forRepo.length ? `Commands allowed for it: ${JSON.stringify(forRepo)}.` : 'No command is allowed for that repo.')
        + ' The owner adds exact commands to the allowlist file; do not try variations.',
    };
  }
  const proposalId = `cmd-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const proposal = { proposalId, repo: entry.repo, argv: entry.argv, why: why.trim() };
  return {
    ok: true,
    proposalId,
    status: 'awaiting-confirmation',
    proposal,
    message: 'Proposal recorded. NOTHING has run. The owner must press Confirm on it in the chat pane; tell them what it will do and wait. Do not claim it ran.',
  };
}

// The accepted proposals of a turn, from its toolCallLog, in call order: [{ proposalId, repo, argv, why }].
function proposalsFromToolLog(toolCallLog) {
  if (!Array.isArray(toolCallLog)) return [];
  return toolCallLog
    .filter((c) => c && c.tool === 'propose_command' && c.result && c.result.ok === true && c.result.proposal)
    .map((c) => c.result.proposal);
}

module.exports = { allowlistPath, loadAllowlist, findEntry, proposeCommand, proposalsFromToolLog, DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S, KILL_SWITCH_NAME };
