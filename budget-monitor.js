'use strict';

// Reads Claude Code's own local session transcripts (~/.claude/projects/**/*.jsonl) to
// decide whether a scheduled review-runner pass should actually spend Claude tokens
// right now. Rate limits are account-wide, not per-project, so this scans every
// project's transcripts, not just this repo's.
//
// Ground truth over guessing: Claude Code itself writes a real rate-limit-hit event
// into the transcript the moment a 5-hour/weekly cap is struck (`error: "rate_limit"`,
// with a human-readable reset time in the message text). That event is authoritative —
// far better than estimating an unknown token threshold. Rolling token sums are kept
// too, but only as supplementary trend telemetry, not the hard gate.

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR
  || path.join(os.homedir(), '.claude', 'projects');

function listJsonlFiles(dir) {
  let out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(listJsonlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

function readEntries(filePath, sinceMs) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
    if (Number.isNaN(ts) || ts < sinceMs) continue;
    out.push({ ...obj, _ts: ts });
  }
  return out;
}

// Converts a wall-clock time in a named IANA zone to a real UTC instant. Standard
// guess-and-correct trick (accurate outside DST-transition edge seconds, which is fine
// for a "should we run now" gate).
function zonedWallTimeToUtc(year, month, day, hour, minute, timeZone) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(guess).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second || 0);
  const offset = asUtc - guess.getTime();
  return new Date(guess.getTime() - offset);
}

function localDateParts(instantMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(instantMs)).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return { year: +parts.year, month: +parts.month, day: +parts.day };
}

// Parses "You've hit your session limit · resets 7:10pm (America/Denver)"-shaped text.
// Returns a real Date the reset lands on, using the event's own timestamp to pick the
// right calendar day (a reset time is always in the future relative to the hit).
function parseResetTime(text, eventTs) {
  const match = /resets?\s+(\d{1,2}):(\d{2})\s*([ap]m)\s*\(([^)]+)\)/i.exec(text || '');
  if (!match) return null;

  let hour = parseInt(match[1], 10) % 12;
  if (/pm/i.test(match[3])) hour += 12;
  const minute = parseInt(match[2], 10);
  const timeZone = match[4];

  const { year, month, day } = localDateParts(eventTs, timeZone);
  let resetsAt = zonedWallTimeToUtc(year, month, day, hour, minute, timeZone);
  if (resetsAt.getTime() <= eventTs) {
    resetsAt = zonedWallTimeToUtc(year, month, day + 1, hour, minute, timeZone);
  }
  return resetsAt;
}

function usageTokenCount(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0)
    + (usage.output_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
}

function isBudgetHealthy() {
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const files = listJsonlFiles(PROJECTS_DIR);
  let allEntries = [];
  for (const file of files) {
    allEntries = allEntries.concat(readEntries(file, sevenDaysAgo));
  }
  allEntries.sort((a, b) => a._ts - b._ts);

  let lastRateLimit = null;
  for (const entry of allEntries) {
    if (entry.error === 'rate_limit' || entry.apiErrorStatus === 429) {
      const text = entry.message?.content?.[0]?.text || '';
      const resetsAt = parseResetTime(text, entry._ts);
      lastRateLimit = { at: entry._ts, text, resetsAt };
    }
  }

  // Corroboration: if real usage happened after the last recorded rate-limit hit,
  // the cap must already have reset, regardless of how the reset-time text parsed.
  const usageAfterLimit = lastRateLimit
    ? allEntries.some((e) => e._ts > lastRateLimit.at && e.type === 'assistant' && !e.error && usageTokenCount(e.message?.usage) > 0)
    : false;

  let healthy = true;
  let reason = 'no recent rate-limit signal';
  if (lastRateLimit && !usageAfterLimit) {
    if (lastRateLimit.resetsAt && lastRateLimit.resetsAt.getTime() > now) {
      healthy = false;
      reason = `rate-limited until ${lastRateLimit.resetsAt.toISOString()} ("${lastRateLimit.text}")`;
    } else if (!lastRateLimit.resetsAt) {
      // Couldn't parse a reset time — be conservative until real usage is observed.
      healthy = false;
      reason = `unparsed rate-limit hit at ${new Date(lastRateLimit.at).toISOString()} ("${lastRateLimit.text}"), no confirmed usage since`;
    }
  }

  const fiveHoursAgo = now - 5 * 60 * 60 * 1000;
  const rolling5h = allEntries.filter((e) => e._ts >= fiveHoursAgo);
  const rolling7d = allEntries;

  const sumTokens = (entries) => entries.reduce((sum, e) => sum + usageTokenCount(e.message?.usage), 0);
  const countCalls = (entries) => entries.filter((e) => e.type === 'assistant' && usageTokenCount(e.message?.usage) > 0).length;

  return {
    healthy,
    reason,
    lastRateLimit: lastRateLimit ? { at: new Date(lastRateLimit.at).toISOString(), resetsAt: lastRateLimit.resetsAt?.toISOString() || null, text: lastRateLimit.text } : null,
    rolling5h: { tokens: sumTokens(rolling5h), calls: countCalls(rolling5h) },
    rolling7d: { tokens: sumTokens(rolling7d), calls: countCalls(rolling7d) },
  };
}

module.exports = { isBudgetHealthy, parseResetTime, usageTokenCount };

if (require.main === module) {
  console.log(JSON.stringify(isBudgetHealthy(), null, 2));
}
