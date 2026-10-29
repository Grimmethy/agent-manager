'use strict';

// Chat's two Unmerged Branches verdict tools (2026-10-28, Grimmethy: the chat ran
// /verify-unmerged-branches on 7 branches but could not record the verdicts -- read-only
// sandbox, nothing allowlisted, no dashboard access -- so Claude Code's post_verdicts.py
// was the only way to turn a card green/yellow/red).
//
// Both tools are thin HTTP clients of the dashboard routes that already own the rules:
//   list_unverified_branches -> GET  /api/git/unmerged-branches?projects=all
//   record_branch_verdict    -> POST /api/git/branches/<branch>/verdict?project=<repoRoot>
// The route (python/dashboard/routes/branch_verdicts.py) is the real gate -- the branch
// must be listed, the claimed sha must equal the head, a held-hub branch is stored as
// pending. This module only validates the arguments, resolves a sha prefix against the
// listing row, and relays the route's answer. It never merges, discards or edits code, and
// deliberately does NOT go through propose_command (exact-argv allowlist + owner confirm
// per command does not fit a verdict call that differs for every branch).
//
// Every exported function resolves to { ok: true, ... } or { ok: false, error, ... } and
// never throws for an expected failure: the chat hands the result straight back to the
// model, which needs a relayable message, not a stack trace.

const http = require('http');

const VERDICTS = ['merge', 'needs-work', 'discard'];
const MAX_REASONS = 10;
const MAX_REASON_CHARS = 600;
const DEFAULT_LIST_LIMIT = 40;
const REQUEST_TIMEOUT_MS = 60000;

// Loopback host and the dashboard's own port setting (same variable and default as python/dashboard/app.py).
const DASHBOARD_HOST = 'localhost';
function dashboardPort(env = process.env) {
  return Number(env.AGENT_MANAGER_DASHBOARD_PORT) || 7420;
}

// Default transport: resolves { status, json } (json null when the body is not JSON, e.g. an
// HTML 404 page). Rejects only on a connection failure or timeout. Tests inject `opts.request`.
function httpRequest(method, pathAndQuery, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: DASHBOARD_HOST,
      port: dashboardPort(),
      path: pathAndQuery,
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timed out after ${REQUEST_TIMEOUT_MS / 1000}s`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function fetchRows(request) {
  let res;
  try {
    res = await request('GET', '/api/git/unmerged-branches?projects=all');
  } catch (e) {
    return { error: `the dashboard did not answer the branch listing (${e.message})` };
  }
  if (res.status !== 200 || !Array.isArray(res.json)) return { error: `the branch listing failed (HTTP ${res.status})` };
  return { rows: res.json };
}

const projectMatches = (row, wanted) => {
  const p = row.project || {};
  return p.label === wanted || p.repoRoot === wanted;
};

async function listUnverifiedBranchesTool({ project, limit } = {}, opts = {}) {
  const request = opts.request || httpRequest;
  const { rows, error } = await fetchRows(request);
  if (error) return { ok: false, error };
  let pool = rows;
  if (typeof project === 'string' && project.trim()) {
    pool = rows.filter((r) => projectMatches(r, project.trim()));
    if (!pool.length && !rows.some((r) => projectMatches(r, project.trim()))) {
      const known = [...new Set(rows.map((r) => r.project && r.project.label).filter(Boolean))];
      return { ok: false, error: `no unmerged branches listed for project "${project}"; projects with branches: ${known.join(', ') || '(none)'}` };
    }
  }
  const needing = pool.filter((r) => !r.verdict || r.stale);
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : DEFAULT_LIST_LIMIT;
  const branches = needing.slice(0, cap).map((r) => ({
    project: r.project && r.project.label,
    branch: r.branch,
    headSha: r.headSha,
    subject: r.subject,
    hub: r.hub ? { id: r.hub.id, hubId: r.hub.id, progress: r.hub.progress } : null,
    ahead: r.ahead,
    behind: r.behind,
    willConflict: !!r.willConflict,
    currentVerdict: r.verdict || null,
    stale: !!r.stale,
  }));
  return { ok: true, needingVerdict: needing.length, shown: branches.length, listed: pool.length, branches };
}

function validateArgs({ branch, sha, verdict, reasons }) {
  if (typeof branch !== 'string' || !branch.trim()) return 'record_branch_verdict requires a non-empty "branch"';
  if (typeof sha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(sha.trim())) return 'record_branch_verdict requires "sha": the branch head sha (7-40 hex chars) from list_unverified_branches';
  if (!VERDICTS.includes(verdict)) {
    return `verdict must be exactly one of ${VERDICTS.join(' / ')} (got ${JSON.stringify(verdict)}; HOLD and unverified are not stored states -- use needs-work for a branch that is not ready, and leave a branch you did not verify unrecorded)`;
  }
  if (!Array.isArray(reasons) || !reasons.length || !reasons.every((r) => typeof r === 'string' && r.trim())) {
    return 'record_branch_verdict requires "reasons": a non-empty list of specific evidence strings (what you ran or read, and what it showed)';
  }
  if (reasons.length > MAX_REASONS) return `at most ${MAX_REASONS} reasons`;
  if (reasons.some((r) => r.length > MAX_REASON_CHARS)) return `each reason must be at most ${MAX_REASON_CHARS} characters`;
  return null;
}

async function recordBranchVerdictTool(args = {}, opts = {}) {
  const invalid = validateArgs(args);
  if (invalid) return { ok: false, error: invalid };
  const request = opts.request || httpRequest;
  const branch = args.branch.trim();
  const sha = args.sha.trim().toLowerCase();
  const { rows, error } = await fetchRows(request);
  if (error) return { ok: false, error };

  const wanted = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : null;
  const matches = rows.filter((r) => r.branch === branch && (!wanted || projectMatches(r, wanted)));
  if (!matches.length) {
    return { ok: false, error: `"${branch}"${wanted ? ` in project "${wanted}"` : ''} is not a currently listed unmerged branch; call list_unverified_branches for the current ones` };
  }
  if (matches.length > 1) {
    return { ok: false, error: `"${branch}" is listed in more than one project (${matches.map((r) => r.project && r.project.label).join(', ')}); pass "project"` };
  }
  const row = matches[0];
  const head = String(row.headSha || '').toLowerCase();
  if (!head || !head.startsWith(sha)) {
    return { ok: false, error: `the branch head is ${head.slice(0, 9) || 'unknown'}, not ${sha}: it moved or you read an older listing; re-verify the current head before recording`, headSha: row.headSha };
  }

  const repoRoot = row.project && row.project.repoRoot;
  const route = `/api/git/branches/${branch.split('/').map(encodeURIComponent).join('/')}/verdict${repoRoot ? `?project=${encodeURIComponent(repoRoot)}` : ''}`;
  let res;
  try {
    res = await request('POST', route, { verdict: args.verdict, reasons: args.reasons.map((r) => r.trim()), source: 'chat', sha: row.headSha });
  } catch (e) {
    return { ok: false, error: `the dashboard did not answer the verdict request (${e.message}); nothing was recorded` };
  }
  const json = res.json;
  if (res.status === 200 && json && json.succeeded) {
    return {
      ok: true, project: row.project && row.project.label, branch, headSha: json.headSha || row.headSha, verdict: json.verdict || args.verdict,
      written: json.written, pending: !!json.pending,
      message: json.pending
        ? 'Stored as a pending verdict: the branch is not on the listing yet and the verdict applies once it is.'
        : 'Recorded; the branch card now shows this verdict.',
    };
  }
  const why = (json && (json.reason || json.error)) || `HTTP ${res.status}`;
  return { ok: false, status: res.status, error: `the dashboard refused the verdict: ${why}`, ...(json && json.headSha ? { headSha: json.headSha } : {}) };
}

module.exports = { listUnverifiedBranchesTool, recordBranchVerdictTool, VERDICTS };
