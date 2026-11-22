'use strict';

// Cluster cause proposal for blocked-task clusters (HUB0825 subtask 0).
//
// clusterFingerprint(cluster) gives a stable identity for a cluster: a SHA-256 over the
// whitespace-normalized signature plus the task count.
//
// proposeClusterFix(cluster, opts) asks the local model once for one shared cause and one
// fix task. The model call goes ONLY through src/local-client.js (callOnce). No model name,
// context size, or keep-alive is passed: those are pinned centrally by the client. The
// result is validated and returned to the caller. Nothing is queued or written here.

const crypto = require('node:crypto');
const { callOnce } = require('./local-client.js');

const MAX_PROMPT_CHARS = 6000;
const MAX_REASONS_IN_PROMPT = 10;
const MAX_ATTEMPTS = 2;

function normalizeSignature(signature) {
  if (typeof signature !== 'string') {
    throw new TypeError('cluster.signature must be a string');
  }
  return signature.trim().replace(/\s+/g, ' ');
}

function clusterFingerprint(cluster) {
  if (!cluster || typeof cluster !== 'object') {
    throw new TypeError('cluster must be an object');
  }
  const normalized = normalizeSignature(cluster.signature);
  if (!Number.isInteger(cluster.count)) {
    throw new TypeError('cluster.count must be an integer');
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([normalized, cluster.count]))
    .digest('hex');
}

function buildPrompt(cluster) {
  const reasons = (Array.isArray(cluster.reasons) ? cluster.reasons : [])
    .slice(0, MAX_REASONS_IN_PROMPT)
    .map((r) => `- ${String(r)}`)
    .join('\n');
  const prompt = [
    'Several blocked pipeline tasks share the same normalized blocker message.',
    'Identify ONE shared root cause and propose ONE fix task for it.',
    'Reply with JSON only, shaped exactly as:',
    '{"cause": "<one sentence>", "fixTask": {"title": "<short imperative title>", "rawText": "<2-4 sentence description>", "signature": "<the signature below, unchanged>"}}',
    '',
    `Signature: ${cluster.signature}`,
    `Count: ${cluster.count}`,
    'Example reasons:',
    reasons,
  ].join('\n');
  return prompt.length > MAX_PROMPT_CHARS ? prompt.slice(0, MAX_PROMPT_CHARS) : prompt;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`proposal ${label} must be a non-empty string`);
  }
  return value.trim();
}

function parseProposal(text, signature) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`proposal is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('proposal is not an object');
  }
  const cause = nonEmptyString(parsed.cause, 'cause');
  const fix = parsed.fixTask;
  if (!fix || typeof fix !== 'object') {
    throw new Error('proposal fixTask must be an object');
  }
  const title = nonEmptyString(fix.title, 'fixTask.title');
  const rawText = nonEmptyString(fix.rawText, 'fixTask.rawText');
  const fixSignature = nonEmptyString(fix.signature, 'fixTask.signature');
  if (fixSignature !== signature) {
    throw new Error('proposal fixTask.signature does not match cluster signature');
  }
  return { cause, fixTask: { title, rawText, signature: fixSignature } };
}

// opts is accepted for interface stability but is NOT forwarded to the client.
async function proposeClusterFix(cluster, opts = {}) {
  void opts;
  clusterFingerprint(cluster); // validates cluster shape up front
  const signature = normalizeSignature(cluster.signature);
  const prompt = buildPrompt(cluster);

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await callOnce({
        prompt,
        format: 'json',
        allowSideFindings: false,
        source: 'cluster-cause-proposer',
      });
      const text = typeof res === 'string' ? res : res && res.response;
      return parseProposal(String(text || ''), signature);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

module.exports = { clusterFingerprint, proposeClusterFix };
