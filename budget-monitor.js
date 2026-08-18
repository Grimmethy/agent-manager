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

// Brain Dump #89 follow-up (2026-08-18): the CURRENT rate-limit window doesn't start "5
// hours before whenever someone happens to check" -- it starts at a specific boundary,
// the last real reset. A trailing-5h lookback and the actual window can disagree by
// almost a full window's width right after a fresh reset (showing 5h of STALE pre-reset
// usage as if it were "current"), which is exactly the kind of drift this account's own
// numbers shouldn't have. Anchors "since last limit" to that real boundary instead:
// - a past reset already happened (resetsAt <= now) -> the new window began there.
// - still mid-limit (resetsAt in the future, or unparsed) -> anchor to the hit itself;
//   whatever accumulates between a hit and its reset is what will trigger the NEXT hit.
// - no rate-limit history at all in the lookback window -> no real boundary to anchor
//   to yet; falls back to the old trailing-5h behavior as the closest available proxy
//   (flagged via usedFallback5h so callers/UI can say so rather than implying precision
//   that isn't there).
function currentWindowStartMs(lastRateLimit, now) {
  if (!lastRateLimit) return null;
  if (lastRateLimit.resetsAt && lastRateLimit.resetsAt.getTime() <= now) {
    return lastRateLimit.resetsAt.getTime();
  }
  return lastRateLimit.at;
}

// Brain Dump #89 (2026-08-18): a real "(used/total ##%)" figure needs a real total, and
// Claude Code under a subscription (CLAUDE_CODE_OAUTH_TOKEN -- see claude-client.js's own
// header) never exposes one; only the API's pay-per-token `/v1/messages` responses carry
// `usage`/`limit` fields, which is deliberately NOT what this deployment uses (a prior
// Brain Dump entry: "not the API, we don't want to get hit with usage bills"). This
// module's own header already treats a real rate-limit HIT as ground truth over guessing
// an unknown threshold -- this function extends that same philosophy instead of abandoning
// it: every real hit IS a genuine data point proving "this many tokens was enough to hit
// the cap," so a history of real hits lets an ACCOUNT-SPECIFIC ceiling be learned
// empirically, entirely from ground-truth events, with no invented number anywhere.
// Uses max (not median/mean) of observed per-hit window sums -- each sample is a real
// upper bound that was actually reached, so the largest one is the best current estimate
// of the true cap; a smaller sample just means that particular hit happened to land
// earlier in its window, not that the cap is lower.
function estimateBudgetCeiling(allEntries) {
  const windowMs = 5 * 60 * 60 * 1000;
  const samples = [];
  for (const entry of allEntries) {
    if (entry.error !== 'rate_limit' && entry.apiErrorStatus !== 429) continue;
    const windowStart = entry._ts - windowMs;
    const tokens = allEntries
      .filter((e) => e._ts > windowStart && e._ts <= entry._ts)
      .reduce((sum, e) => sum + usageTokenCount(e.message?.usage), 0);
    if (tokens > 0) samples.push({ at: new Date(entry._ts).toISOString(), tokens });
  }
  if (samples.length === 0) return { ceilingTokens: null, sampleCount: 0, samples: [] };
  const ceilingTokens = Math.max(...samples.map((s) => s.tokens));
  return { ceilingTokens, sampleCount: samples.length, samples };
}

// Burn-rate projection for "estimated time cap will be reached": tokens/hour over a
// SHORT recent window (60 min), not the full 5h rolling sum -- a short window reflects
// current pace, where a 5h average would be diluted by idle stretches earlier in the
// window and understate how soon a sustained burst would actually hit the ceiling.
function estimateTimeToCap(allEntries, ceilingTokens, usedTokens, now) {
  if (!ceilingTokens) return null;
  const remaining = ceilingTokens - usedTokens;
  if (remaining <= 0) return null; // already at/over the estimated ceiling
  const oneHourAgo = now - 60 * 60 * 1000;
  const recentTokens = allEntries
    .filter((e) => e._ts >= oneHourAgo && e._ts <= now)
    .reduce((sum, e) => sum + usageTokenCount(e.message?.usage), 0);
  if (recentTokens <= 0) return null; // not currently accumulating -- no rate to project from
  const tokensPerHour = recentTokens; // window IS one hour, so this is already the rate
  const hoursToCap = remaining / tokensPerHour;
  return new Date(now + hoursToCap * 60 * 60 * 1000).toISOString();
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

  const windowStartMs = currentWindowStartMs(lastRateLimit, now);
  const usedFallback5h = windowStartMs == null;
  const sinceLastLimitStart = usedFallback5h ? now - 5 * 60 * 60 * 1000 : windowStartMs;
  const sinceLastLimitEntries = allEntries.filter((e) => e._ts >= sinceLastLimitStart);
  const rolling7d = allEntries;

  const sumTokens = (entries) => entries.reduce((sum, e) => sum + usageTokenCount(e.message?.usage), 0);
  const countCalls = (entries) => entries.filter((e) => e.type === 'assistant' && usageTokenCount(e.message?.usage) > 0).length;

  const sinceLastLimitTokens = sumTokens(sinceLastLimitEntries);
  const ceiling = estimateBudgetCeiling(allEntries);
  // null (not { usedPercent: 0, ... }) when sampleCount is 0 -- "no estimate yet" must
  // stay visibly distinct from "0% used", the same "unknown is not the same as safe"
  // rule check_budget_healthy's own caller-side fallback already follows elsewhere in
  // this pipeline (agent-manager-common.sh).
  const estimate = ceiling.ceilingTokens ? {
    ceilingTokens: ceiling.ceilingTokens,
    usedTokens: sinceLastLimitTokens,
    usedPercent: Math.min(100, Math.round((sinceLastLimitTokens / ceiling.ceilingTokens) * 100)),
    sampleCount: ceiling.sampleCount,
    basis: 'empirical: max observed 5h-window token total across past real rate-limit hits -- not a real quota number, Claude Code under a subscription does not expose one',
    estimatedCapAt: estimateTimeToCap(allEntries, ceiling.ceilingTokens, sinceLastLimitTokens, now),
  } : null;

  return {
    healthy,
    reason,
    lastRateLimit: lastRateLimit ? { at: new Date(lastRateLimit.at).toISOString(), resetsAt: lastRateLimit.resetsAt?.toISOString() || null, text: lastRateLimit.text } : null,
    sinceLastLimit: {
      tokens: sinceLastLimitTokens,
      calls: countCalls(sinceLastLimitEntries),
      windowStart: new Date(sinceLastLimitStart).toISOString(),
      usedFallback5h,
    },
    rolling7d: { tokens: sumTokens(rolling7d), calls: countCalls(rolling7d) },
    estimate,
  };
}

module.exports = { isBudgetHealthy, parseResetTime, usageTokenCount, estimateBudgetCeiling, estimateTimeToCap, currentWindowStartMs };

if (require.main === module) {
  console.log(JSON.stringify(isBudgetHealthy(), null, 2));
}
