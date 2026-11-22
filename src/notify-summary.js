'use strict';

// The one daily summary message for the owner's phone (see notify.js for the levels and the target).
//
// buildSummary() counts what a person wants to know at a glance, straight from the queue directories (one readdir per state, no file is
// parsed): tasks finished in the last 24 hours (queue/done files whose modification time is that recent), and what is waiting on a human
// (blocked, needs-clarification, awaiting-confirm) or on the pipeline (pending, coordinating hubs). runDaily() sends it through notify() at
// most once per local day and not before AGENT_MANAGER_NOTIFY_SUMMARY_HOUR (default 8, local time), and only remembers the day when the
// send worked, so a failed send is tried again on the next call.
//
// It is meant to be called by a timer (a systemd user timer example is in docs/agents/notifier.md; it is shipped, not enabled) or by any
// loop that already ticks; calling it more often is harmless because of the once-a-day rule.
//
// CLI: node src/notify-summary.js        (uses AGENT_MANAGER_PIPELINE_DIR; prints the outcome as JSON)

const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync } = require('./atomic-write.js');
const { notify, SUMMARY } = require('./notify.js');

const DAY_MS = 24 * 60 * 60 * 1000;

function countFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;
  } catch (e) {
    return 0;
  }
}

function countRecent(dir, now, windowMs) {
  let n = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return 0; }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    try {
      if (now - fs.statSync(path.join(dir, f)).mtimeMs <= windowMs) n += 1;
    } catch (e) { /* removed while counting */ }
  }
  return n;
}

function buildSummary({ queueDir, now }) {
  const counts = {
    finishedLast24h: countRecent(path.join(queueDir, 'done'), now, DAY_MS),
    blocked: countFiles(path.join(queueDir, 'blocked')),
    needsClarification: countFiles(path.join(queueDir, 'needs-clarification')),
    awaitingConfirm: countFiles(path.join(queueDir, 'awaiting-confirm')),
    pending: countFiles(path.join(queueDir, 'pending')),
    hubs: countFiles(path.join(queueDir, 'coordinating')),
  };
  const waiting = counts.blocked + counts.needsClarification + counts.awaitingConfirm;
  const title = waiting === 0 ? `Daily summary: ${counts.finishedLast24h} finished, nothing waiting on you` : `Daily summary: ${counts.finishedLast24h} finished, ${waiting} waiting on you`;
  const text = [
    `Finished in the last 24 hours: ${counts.finishedLast24h}`,
    `Waiting on a person: ${waiting} (blocked ${counts.blocked}, needs clarification ${counts.needsClarification}, awaiting confirm ${counts.awaitingConfirm})`,
    `In the pipeline: ${counts.pending} pending, ${counts.hubs} hubs coordinating`,
  ].join('\n');
  return { title, text, counts };
}

function localDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function summaryHour(env) {
  const raw = env.AGENT_MANAGER_NOTIFY_SUMMARY_HOUR;
  if (raw === undefined || String(raw).trim() === '') return 8;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : 8;
}

async function runDaily(options = {}) {
  const env = options.env || process.env;
  const now = options.now ? options.now() : Date.now();
  const pipelineDir = (env.AGENT_MANAGER_PIPELINE_DIR || '').trim();
  const queueDir = options.queueDir || (pipelineDir ? path.join(pipelineDir, 'queue') : '');
  const stateDir = (env.AGENT_MANAGER_NOTIFY_DIR || '').trim() || (pipelineDir ? path.join(pipelineDir, 'notify') : '');
  if (!queueDir || !stateDir) return { sent: false, reason: 'no-pipeline-dir' };
  if (new Date(now).getHours() < summaryHour(env)) return { sent: false, reason: 'too-early' };

  const today = localDate(now);
  const stateFile = path.join(stateDir, 'notify-summary-state.json');
  let lastDate = '';
  try { lastDate = String(JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastSentDate || ''); } catch (e) { /* first run */ }
  if (lastDate === today) return { sent: false, reason: 'already-sent-today' };

  const { title, text } = buildSummary({ queueDir, now });
  const result = await notify({ level: SUMMARY, key: `summary:${today}`, title, text }, { env, now: () => now, post: options.post });
  if (result.sent) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      writeJsonAtomicSync(stateFile, { lastSentDate: today });
    } catch (e) { /* sent but not remembered: notify()'s own 20 h window still stops a second one */ }
  }
  return result;
}

if (require.main === module) {
  runDaily().then((r) => { process.stdout.write(JSON.stringify(r) + '\n'); });
}

module.exports = { buildSummary, runDaily, localDate, summaryHour };
