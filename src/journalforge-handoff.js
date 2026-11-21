'use strict';
// JournalForge keep-and-resurface handoff (journal loop). A brain-dump entry the classifier
// filed as a Journal note with actionable:false is also POSTed to JournalForge's local
// API so it can be kept, resurfaced and given an outcome. The vault note is always filed
// first by the caller; nothing here can fail or block the sort.
//
// The sort is synchronous, so the POST runs in a short-lived child process with a hard
// timeout (spawnSync). The entry text and URL travel over stdin only: never argv, never a
// log line. Only the entry id and the outcome reason are logged.
const { spawnSync } = require('child_process');
const { logPipelineEvent } = require('./pipeline-history.js');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const CHILD_TIMEOUT_MS = 3000; // hard ceiling for the whole child run
const REQUEST_TIMEOUT_MS = 2000; // socket timeout inside the child

// Runs in the child. Reads {url, payload} from stdin, makes exactly one POST, prints one
// JSON line {ok, reason} on stdout, and exits. Single attempt.
const CHILD_SCRIPT = `
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const http = require('http');
  const job = JSON.parse(raw);
  const u = new URL('/api/entries', job.url);
  const body = JSON.stringify(job.payload);
  const finish = (out) => { process.stdout.write(JSON.stringify(out)); process.exit(0); };
  const req = http.request({
    hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => {
    res.resume();
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    finish({ ok, reason: ok ? 'handed-off' : 'http-' + res.statusCode });
  });
  req.setTimeout(${REQUEST_TIMEOUT_MS}, () => { finish({ ok: false, reason: 'timeout' }); });
  req.on('error', (e) => { finish({ ok: false, reason: e.code === 'ECONNREFUSED' ? 'refused' : 'error' }); });
  req.end(body);
});
`;

// Journal-type = the classifier filed the note under the vault's Journal folder.
function isJournalType(result) {
  return String((result && result.secondBrainPath) || '').startsWith('Journal/');
}

// Returns a skip reason, or null when the entry may be handed over.
function eligibilityReason(entry, result) {
  if (result.actionable !== false) return 'not-eligible-actionable-not-false';
  if (entry.suppressed === true) return 'suppressed';
  if (entry.raisedBy) return 'machine-raised';
  if (entry.keptIn) return 'already-kept';
  return null;
}

function isLoopbackUrl(url) {
  try { return LOOPBACK_HOSTS.has(new URL(url).hostname); } catch { return false; }
}

// One child-process POST. Never throws; every failure becomes a reason string.
function postToJournalForge(url, payload) {
  const r = spawnSync(process.execPath, ['-e', CHILD_SCRIPT], {
    input: JSON.stringify({ url, payload }),
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
  });
  if (r.error) return { ok: false, reason: r.error.code === 'ETIMEDOUT' ? 'timeout' : 'error' };
  try {
    const out = JSON.parse(String(r.stdout || '').trim().split('\n').pop());
    return { ok: out.ok === true, reason: String(out.reason || 'error') };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

// Hands a journal-type, non-actionable entry to JournalForge. Mutates entry.keptIn/keptAt
// on success (the caller persists brain-dump.json). Returns { handed, reason }; reason is
// null for entries that are simply not journal-type (nothing to record).
function handOffJournalEntry({ entry, result, capturedAt, pipelineDir }) {
  if (!entry || !result || !isJournalType(result)) return { handed: false, reason: null };
  const outcome = (() => {
    const skip = eligibilityReason(entry, result);
    if (skip) return { ok: false, reason: skip };
    const url = require('./config.js').getJournalForgeUrl();
    if (!url) return { ok: false, reason: 'handoff-disabled' };
    if (!isLoopbackUrl(url)) return { ok: false, reason: 'non-loopback-url' };
    return postToJournalForge(url, {
      text: entry.rawText,
      source: 'brain-dump:' + entry.id,
      capturedAt,
      path: result.secondBrainPath,
    });
  })();
  if (outcome.ok) {
    entry.keptIn = 'journalforge';
    entry.keptAt = new Date().toISOString();
  }
  // Logged by entry id and outcome only -- never the entry text.
  try {
    logPipelineEvent(pipelineDir, 'journalforge-handoff', {
      entryId: entry.id, serial: entry.serial ?? null, outcome: outcome.reason,
    });
  } catch { /* best-effort log */ }
  return { handed: outcome.ok, reason: outcome.reason };
}

module.exports = { handOffJournalEntry, isJournalType, eligibilityReason, isLoopbackUrl };
