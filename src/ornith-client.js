'use strict';

// Thin wrapper over the local Ollama HTTP API for the `ornith` model, encoding the
// mechanics and guardrails documented in Docs/agents/ornith-delegation.md so no caller
// has to rediscover them: explicit num_ctx/num_predict (the `ollama run` CLI silently
// truncates), a degenerate-output detector for the failure modes that fail *silently*
// (done_reason: stop, syntactically fine, semantically garbage), retry-on-degenerate
// (these have been observed to self-heal), and a majority-vote helper for judgment
// calls that are otherwise an invisible coin flip at default temperature.

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.ORNITH_MODEL || 'ornith';

function detectDegenerate(text) {
  if (!text || text.trim().length === 0) return 'empty';

  // Repeated-character garbage (e.g. a literal run of "000000..." was observed for 20
  // straight calls in one documented overnight run).
  const charCounts = {};
  for (const ch of text) charCounts[ch] = (charCounts[ch] || 0) + 1;
  const dominant = Math.max(...Object.values(charCounts));
  if (text.length > 20 && dominant / text.length > 0.4) return 'repeated-character';

  // Verbatim-paragraph repetition loop leaking into the visible response.
  const words = text.trim().split(/\s+/);
  if (words.length > 30) {
    const chunk = words.slice(0, 8).join(' ');
    const repeats = text.split(chunk).length - 1;
    if (repeats >= 3) return 'repetition-loop';
  }

  // Multi-script / gibberish word-salad for what should be an English task.
  const nonAscii = [...text].filter((ch) => ch.charCodeAt(0) > 127).length;
  if (nonAscii / text.length > 0.3) return 'non-ascii-gibberish';

  return null;
}

async function callOnce({ prompt, think = true, temperature = 0.4, numCtx = 8192, numPredict = 1200, repeatPenalty, format }) {
  const options = { num_ctx: numCtx, num_predict: numPredict, temperature };
  if (repeatPenalty) options.repeat_penalty = repeatPenalty;

  const body = { model: MODEL, prompt, think, stream: false, options };
  // Grammar-constrained decoding. When `format` is set ("json", or a full JSON-schema object),
  // Ollama restricts the sampler to tokens valid for that grammar, so a malformed or
  // markdown-fenced response is *unrepresentable* rather than merely discouraged in the prompt.
  // This is the structural replacement for "Output ONLY the draft JSON"-style instructions that
  // the model is documented to ignore (Docs/agents/ornith-delegation.md — a real state_targets
  // implement draft came back ```json-fenced despite that exact instruction). The constraint
  // applies only to `response`; the `thinking` trace is left unconstrained.
  if (format) body.format = format;

  return postJson(`${OLLAMA_URL}/api/generate`, body);
}

// Raw http.request instead of fetch: with stream:false Ollama only answers once the
// whole generation is done, and a large num_predict on this hardware legitimately takes
// longer than fetch/undici's built-in ~5-minute header/body timeouts — observed live
// 2026-07-10 as a bare "fetch failed" on an 8192-token draft. Same 30-minute-timeout
// pattern Docs/agents/ornith-delegation.md already mandates for ornith-chat.js's postJson.
const REQUEST_TIMEOUT_MS = Number(process.env.ORNITH_TIMEOUT_MS) || 1_800_000;

function postJson(urlString, bodyObj) {
  const http = require('http');
  const url = new URL(urlString);
  const payload = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Ollama HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
          return;
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Ollama returned unparseable JSON: ${e.message}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`Ollama request timed out after ${REQUEST_TIMEOUT_MS}ms`)); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Calls Ornith once, retrying up to maxRetries times if the degenerate-output detector
// fires — per the doc, degeneracy is usually a transient inference-state glitch that
// self-heals on a later call with identical input, not a stable property of the prompt.
async function call(opts, maxRetries = 2) {
  let lastDegenerate = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await callOnce(opts);
    const degenerate = detectDegenerate(result.response);
    if (!degenerate) return { ...result, degenerate: null, attempts: attempt + 1 };
    lastDegenerate = degenerate;
  }
  return { response: '', thinking: '', degenerate: lastDegenerate, attempts: maxRetries + 1 };
}

// Majority-vote helper for qualitative judgment calls. Runs the SAME prompt `n` times
// at low temperature and returns the majority verdict, requiring an ABSOLUTE count of
// agreeing REAL (non-degenerate) votes (`minAgreeing`), not a relative comparison of
// two buckets that can both be small — that relative-comparison bug once let 1 genuine
// verdict + 2 degenerate "unclear" votes pass as a confident 1-0 consensus.
async function majorityVote({ prompt, classify, n = 3, minAgreeing = 2, temperature = 0.2 }) {
  const votes = [];
  for (let i = 0; i < n; i++) {
    const result = await call({ prompt, think: false, temperature }, 1);
    if (result.degenerate) continue;
    const verdict = classify(result.response);
    if (verdict) votes.push({ verdict, response: result.response });
  }

  const tally = {};
  for (const v of votes) tally[v.verdict] = (tally[v.verdict] || 0) + 1;

  let winner = null;
  let winnerCount = 0;
  for (const [verdict, count] of Object.entries(tally)) {
    if (count > winnerCount) {
      winner = verdict;
      winnerCount = count;
    }
  }

  return {
    verdict: winnerCount >= minAgreeing ? winner : null,
    confident: winnerCount >= minAgreeing,
    votes,
    realVoteCount: votes.length,
    requestedVotes: n,
  };
}

module.exports = { call, callOnce, majorityVote, detectDegenerate };

// CLI: node ornith-client.js <request.json>
// request.json: { prompt, think, temperature, numCtx, numPredict, repeatPenalty, maxRetries,
//                 format, mode: "single" | "majority-vote", classifyMarkers: [string, ...] }
//   format: "json" (or a JSON-schema object) grammar-constrains the response — use for passes
//           that must emit pure JSON (e.g. the state_targets implement pass drafting index.json).
// Writes the JSON result to stdout.
if (require.main === module) {
  const fs = require('fs');
  const requestPath = process.argv[2];
  if (!requestPath) {
    console.error('usage: node ornith-client.js <request.json>');
    process.exit(1);
  }
  const req = JSON.parse(fs.readFileSync(requestPath, 'utf8'));

  (async () => {
    try {
      if (req.mode === 'majority-vote') {
        const markers = req.classifyMarkers || [];
        const classify = (text) => {
          const lower = text.toLowerCase();
          return markers.find((m) => lower.includes(m.toLowerCase())) || null;
        };
        const result = await majorityVote({ ...req, classify });
        process.stdout.write(JSON.stringify(result));
      } else {
        const result = await call(req, req.maxRetries ?? 2);
        process.stdout.write(JSON.stringify(result));
      }
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  })();
}
