'use strict';

// Owner notifier: the one place Agent Manager (and anything that runs next to it) calls to reach the owner's phone.
//
// Why it exists (2026-11-11, multi-node plan): the only phone path was python/dashboard/app.py's _fire_alert_webhook, which fires as a
// side-effect of a GET /api/alerts and so sends nothing unless something polls that route. This module is an explicit call instead: a
// caller that sees a condition sends it (a trigger, not a poll), and it decides whether the owner should hear about it.
//
// Levels (the owner's decision: urgent, a daily summary, and nothing for routine events):
//   urgent   -- a machine down, a pause stuck, a repair limit hit, a queue stalled. Sent at once, high priority.
//   summary  -- the one short daily message (see notify-summary.js).
//   routine  -- never sent (counted in the log only), so callers can report everything and let this decide.
//
// Protection against noise: the same `key` is not sent again inside its window (urgent 60 min, summary 20 h), and urgent messages are capped
// per hour, so a flapping condition produces one message, not hundreds. A failed send is NOT remembered, so the next trigger retries it.
//
// Target: any ntfy-compatible endpoint, a plain HTTP POST with the text as the body and Title / Priority / Tags headers (the same shape as
// _fire_alert_webhook), set with AGENT_MANAGER_NOTIFY_URL. The owner runs a self-hosted ntfy on the tailnet (docs/agents/notifier.md), so task
// titles never reach a third party. Unset URL = nothing is sent, and the log says so.
//
// State lives under <pipeline dir>/notify/: notify-state.json (last-sent times, written atomically) and notify-log.jsonl (one line per
// call: when, level, key, title, outcome; never the message body). Kill switch: AGENT_MANAGER_NOTIFY=false.
//
// notify() never throws: a notification problem must not break the loop that reported it. Two processes calling at the same instant can
// both send once (the state is read, then written); that costs a duplicate message, never a lost one.
//
// CLI: node src/notify.js --level urgent --key stale-node:grimm --title "grimm is not answering" [--text "last seen 12 min ago"]

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { writeJsonAtomicSync } = require('./atomic-write.js');

const URGENT = 'urgent';
const SUMMARY = 'summary';
const ROUTINE = 'routine';
const SENDABLE = { [URGENT]: { priority: 'urgent', tags: 'rotating_light' }, [SUMMARY]: { priority: 'default', tags: 'bar_chart' } };
const LOG_ROTATE_BYTES = 1024 * 1024;
const BODY_CAP = 1000;
const TITLE_CAP = 200;

function numberFrom(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function configFrom(env) {
  const pipelineDir = (env.AGENT_MANAGER_PIPELINE_DIR || '').trim();
  return {
    url: (env.AGENT_MANAGER_NOTIFY_URL || '').trim(),
    disabled: String(env.AGENT_MANAGER_NOTIFY || '').trim().toLowerCase() === 'false',
    urgentWindowMs: numberFrom(env.AGENT_MANAGER_NOTIFY_DEDUPE_MIN, 60) * 60 * 1000,
    summaryWindowMs: numberFrom(env.AGENT_MANAGER_NOTIFY_SUMMARY_WINDOW_HOURS, 20) * 60 * 60 * 1000,
    urgentPerHour: numberFrom(env.AGENT_MANAGER_NOTIFY_MAX_PER_HOUR, 6),
    stateDir: (env.AGENT_MANAGER_NOTIFY_DIR || '').trim() || (pipelineDir ? path.join(pipelineDir, 'notify') : ''),
    timeoutMs: numberFrom(env.AGENT_MANAGER_NOTIFY_TIMEOUT_MS, 5000),
  };
}

// HTTP header values must be single-line latin1: collapse whitespace and drop everything else.
function headerSafe(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').replace(/[^\x20-\x7e]/g, '').trim().slice(0, TITLE_CAP);
}

function defaultPost(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch (e) { reject(new Error('invalid AGENT_MANAGER_NOTIFY_URL')); return; }
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      lastSent: parsed && typeof parsed.lastSent === 'object' && parsed.lastSent ? parsed.lastSent : {},
      urgentSent: Array.isArray(parsed && parsed.urgentSent) ? parsed.urgentSent.filter(Number.isFinite) : [],
    };
  } catch (e) {
    return { lastSent: {}, urgentSent: [] };
  }
}

function appendLog(dir, entry) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'notify-log.jsonl');
    try {
      if (fs.statSync(file).size > LOG_ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
    } catch (e) { /* no log yet */ }
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch (e) { /* logging must never break the caller */ }
}

async function notify(message, options = {}) {
  const env = options.env || process.env;
  const now = options.now ? options.now() : Date.now();
  const post = options.post || defaultPost;
  const cfg = configFrom(env);
  const msg = message && typeof message === 'object' ? message : {};
  const level = typeof msg.level === 'string' ? msg.level : '';
  const key = String(msg.key || msg.title || '').slice(0, 200);
  const title = headerSafe(msg.title) || 'Agent Manager';
  const log = (outcome, extra) => appendLog(cfg.stateDir, { at: new Date(now).toISOString(), level, key, title, outcome, ...extra });
  try {
    if (cfg.disabled) return { sent: false, reason: 'disabled' };
    if (level === ROUTINE) { log('routine'); return { sent: false, reason: 'routine' }; }
    const spec = SENDABLE[level];
    if (!spec) { log('unknown-level'); return { sent: false, reason: 'unknown-level' }; }
    if (!cfg.url) { log('no-url'); return { sent: false, reason: 'no-url' }; }
    if (!cfg.stateDir) { return { sent: false, reason: 'no-state-dir' }; }

    const stateFile = path.join(cfg.stateDir, 'notify-state.json');
    const state = readState(stateFile);
    const window = level === URGENT ? cfg.urgentWindowMs : cfg.summaryWindowMs;
    const last = Number(state.lastSent[`${level}:${key}`]);
    if (Number.isFinite(last) && now - last < window) { log('duplicate'); return { sent: false, reason: 'duplicate' }; }
    const recentUrgent = state.urgentSent.filter((t) => now - t < 60 * 60 * 1000);
    if (level === URGENT && recentUrgent.length >= cfg.urgentPerHour) { log('rate-limited'); return { sent: false, reason: 'rate-limited' }; }

    const body = String(msg.text == null ? '' : msg.text).slice(0, BODY_CAP) || title;
    try {
      await post(cfg.url, { Title: title, Priority: spec.priority, Tags: spec.tags }, body, cfg.timeoutMs);
    } catch (e) {
      log('error', { error: String(e && e.message || e).slice(0, 200) });
      return { sent: false, reason: 'error', error: String(e && e.message || e) };
    }
    state.lastSent[`${level}:${key}`] = now;
    // Forget keys long past their window so the file cannot grow without bound.
    for (const k of Object.keys(state.lastSent)) {
      if (now - Number(state.lastSent[k]) > 48 * 60 * 60 * 1000) delete state.lastSent[k];
    }
    state.urgentSent = level === URGENT ? [...recentUrgent, now] : recentUrgent;
    try {
      fs.mkdirSync(cfg.stateDir, { recursive: true });
      writeJsonAtomicSync(stateFile, state);
    } catch (e) { /* sent but not remembered: at worst one duplicate later */ }
    log('sent');
    return { sent: true, reason: 'sent' };
  } catch (e) {
    return { sent: false, reason: 'error', error: String(e && e.message || e) };
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    out[a.slice(2)] = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : '';
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.level || !(args.title || args.key)) {
    process.stderr.write('usage: node src/notify.js --level urgent|summary|routine --key <stable key> --title <text> [--text <body>]\n');
    return 2;
  }
  const result = await notify({ level: args.level, key: args.key, title: args.title, text: args.text });
  process.stdout.write(JSON.stringify(result) + '\n');
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { notify, configFrom, headerSafe, parseArgs, main, URGENT, SUMMARY, ROUTINE };
