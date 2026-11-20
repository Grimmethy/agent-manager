'use strict';

// Snapshot-then-summarize compaction for done-task worklogs (queue/worklogs/<taskId>.json).
// Beads internal/compact pattern: snapshot the original, summarize each tool tier with a small
// model, record original vs proposed size, and record every ineligible task with a reason.
// Dry-run by default: unless AGENT_MANAGER_DONE_COMPACT_APPLY=1 (or options.apply === true) the
// only files written are _compact/report.json and _compact/skips.jsonl. Apply mode copies each
// original to _compact/snapshots/<taskId>.json BEFORE replacing the worklog.
// The summarizer is injectable. The default goes through src/local-client.js callOnce(), so the
// model call stays on the shared client path (MODEL RELOAD CHECK).

const fs = require('fs');
const path = require('path');

const COMPACT_DIRNAME = '_compact';
const DEFAULT_MIN_AGE_DAYS = 30;
const TOOL_TEXT_CAP = 4000;
const FINAL_MESSAGE_CAP = 500;
const SUMMARY_NUM_PREDICT = 300;
const DAY_MS = 24 * 60 * 60 * 1000;

function applyEnabled(apply) {
  if (typeof apply === 'boolean') return apply;
  return process.env.AGENT_MANAGER_DONE_COMPACT_APPLY === '1';
}

function transcriptText(tier) {
  const lines = (tier.calls || []).map((c) => {
    const args = c.args ? JSON.stringify(c.args) : '';
    const preview = c.resultPreview ? String(c.resultPreview).slice(0, 300) : '';
    return `- ${c.tool || 'unknown'} ${args} -> ${preview}${c.error ? ' [error]' : ''}`;
  });
  return lines.join('\n').slice(0, TOOL_TEXT_CAP);
}

function buildPrompt(tier) {
  return [
    'Summarize this one tool-call tier of an automated task run in 2-3 plain sentences.',
    'Say what was looked at or changed and whether it succeeded. Do not invent details.',
    '',
    `Tier: ${tier.tier || 'unknown'}`,
    transcriptText(tier),
  ].join('\n');
}

function defaultSummarize(prompt) {
  // Loaded lazily so tests and dry-run tooling never pull in the model client.
  const { callOnce } = require('./local-client.js');
  return callOnce({ prompt, think: false, numPredict: SUMMARY_NUM_PREDICT, source: 'done-compact', allowSideFindings: false })
    .then((r) => (r && r.response) || '');
}

// Builds the compacted document. Raw args and result previews are dropped; each tier keeps its
// metadata, a per-call shape (tool name, byte size, error flag), a model summary, and a capped
// final message.
async function compactDoc(doc, { summarize, now }) {
  const tiers = [];
  for (const tier of doc.tiers) {
    const calls = Array.isArray(tier.calls) ? tier.calls : [];
    const summary = calls.length ? String((await summarize(buildPrompt(tier))) || '').trim() : '';
    tiers.push({
      tier: tier.tier || 'unknown',
      at: tier.at || null,
      turnsUsed: tier.turnsUsed != null ? tier.turnsUsed : null,
      callCount: tier.callCount != null ? tier.callCount : calls.length,
      calls: calls.map((c) => ({
        n: c.n,
        tool: c.tool || 'unknown',
        resultBytes: c.resultBytes != null ? c.resultBytes : null,
        ...(c.error ? { error: true } : {}),
      })),
      summary,
      ...(typeof tier.finalMessage === 'string' && tier.finalMessage.trim()
        ? { finalMessage: tier.finalMessage.slice(0, FINAL_MESSAGE_CAP) }
        : {}),
    });
  }
  return { taskId: doc.taskId, compacted: true, compactedAt: new Date(now).toISOString(), tiers };
}

/**
 * Runs one compaction pass over worklogDir. Ineligible files are recorded in skips.jsonl with a
 * reason; eligible files are summarized. Returns the report (also written to _compact/report.json).
 */
async function runCompaction({ worklogDir, doneDir, now = Date.now(), minAgeDays = DEFAULT_MIN_AGE_DAYS, summarize = defaultSummarize, apply } = {}) {
  const applying = applyEnabled(apply);
  const compactDir = path.join(worklogDir, COMPACT_DIRNAME);
  const snapshotDir = path.join(compactDir, 'snapshots');
  const doneTop = doneDir || path.join(worklogDir, '..', 'done');
  const minAgeMs = minAgeDays * DAY_MS;

  const skips = [];
  const skipReasons = {};
  const errors = [];
  const pending = [];
  let scanned = 0;

  const names = fs.readdirSync(worklogDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort();

  for (const name of names) {
    scanned++;
    const taskId = name.slice(0, -'.json'.length);
    const src = path.join(worklogDir, name);
    const skip = (reason, detail) => {
      skipReasons[reason] = (skipReasons[reason] || 0) + 1;
      skips.push({ taskId, reason, ...(detail ? { detail } : {}) });
    };

    let raw;
    let doc;
    let mtimeMs;
    try {
      raw = fs.readFileSync(src, 'utf8');
      mtimeMs = fs.statSync(src).mtimeMs;
      doc = JSON.parse(raw);
    } catch (e) {
      skip('unreadable', e.message);
      continue;
    }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.tiers)) { skip('unreadable', 'no tiers array'); continue; }
    if (doc.compacted) { skip('already-compacted'); continue; }
    if (!doc.tiers.some((t) => Array.isArray(t.calls) && t.calls.length > 0)) { skip('no-tool-calls'); continue; }
    if (!fs.existsSync(path.join(doneTop, name))) { skip('not-done'); continue; }
    if (now - mtimeMs < minAgeMs) { skip('too-recent'); continue; }

    let compacted;
    try {
      compacted = await compactDoc(doc, { summarize, now });
    } catch (e) {
      skip('summarize-failed', e.message);
      continue;
    }
    pending.push({ taskId, name, src, raw, proposed: JSON.stringify(compacted, null, 2) });
  }

  const files = pending.map((p) => ({
    taskId: p.taskId,
    originalBytes: Buffer.byteLength(p.raw),
    proposedBytes: Buffer.byteLength(p.proposed),
  }));

  fs.mkdirSync(compactDir, { recursive: true });
  let written = 0;
  if (applying && pending.length) fs.mkdirSync(snapshotDir, { recursive: true });
  if (applying) {
    for (const p of pending) {
      try {
        fs.writeFileSync(path.join(snapshotDir, p.name), p.raw); // snapshot the original first
        fs.writeFileSync(p.src, p.proposed);
        written++;
      } catch (e) {
        errors.push(`apply(${p.taskId}): ${e.message}`);
      }
    }
  }

  const skipLines = skips.map((s) => JSON.stringify(s));
  fs.writeFileSync(path.join(compactDir, 'skips.jsonl'), skipLines.length ? `${skipLines.join('\n')}\n` : '');

  const sum = (key) => files.reduce((acc, f) => acc + f[key], 0);
  const report = {
    runAt: new Date(now).toISOString(),
    applied: applying,
    summary: {
      scanned,
      eligible: pending.length,
      written,
      skipped: skips.length,
      originalBytes: sum('originalBytes'),
      proposedBytes: sum('proposedBytes'),
    },
    skipReasons,
    files,
    errors,
  };
  fs.writeFileSync(path.join(compactDir, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

module.exports = { runCompaction, compactDoc, buildPrompt, defaultSummarize, COMPACT_DIRNAME };
