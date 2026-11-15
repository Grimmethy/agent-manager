'use strict';

// The prompt lines for the model-reload rules (src/lib/io-churn-detector.js, docs/agents/io-churn-detector.md): the same layering as src/lib/poll-avoidance-lines.js (ADR-0024). The system keeps ONE local
// model resident and never unloads it; a request whose context size differs from the loaded one makes Ollama restart its runner, which reloads 21 GB from the SSD (13-20 reloads an hour on 2026-11-06,
// IO pressure 87-95%). These lines put the rule in front of the model that PLANS a change, the model that WRITES it and the model that REVIEWS it, so a new reload cause is stopped where it would be written;
// the detector and the pre-merge gates catch what the prompts miss. Advisory text only. Pure, no imports, so it can move with the detector.

const IO_OK_TOKEN = 'io-ok:';

// What the rule forbids, in one sentence, shared by all three prompts.
// io-ok: prompt text that names the forbidden endpoints; it makes no request
const WHAT_RELOADS_THE_MODEL = 'Anything that makes Ollama reload the resident model is forbidden: choosing a context size (num_ctx / numCtx), choosing a keep_alive (any value, including 0), unloading the model, or POSTing to /api/generate or /api/chat directly.';

// For the model that plans a change.
const PLAN_LINES = [
  'NO MODEL RELOADS: the system keeps ONE local model resident and never unloads it, and a request whose context size differs from the loaded one makes Ollama reload 21 GB from the SSD.',
  WHAT_RELOADS_THE_MODEL,
  'A plan never chooses a context size, a keep-alive or a model: it reaches the local model only through src/local-client.js (call / callOnce), which pins the context, sends the never-expire keep-alive and waits for the model to be resident.',
  'A plan that adds work to a periodic tick names the event that replaces a scan (ADR-0024) and does not add a per-tick directory scan, a re-read of a large file or a process spawn.',
].join(' ');

// For the model that writes the change (the implement pass).
const IMPLEMENT_LINES = [
  'NO MODEL RELOADS: do not write num_ctx / numCtx, keep_alive / keepAlive (any value, including 0), an unload call, an Ollama URL, or a request timeout shorter than a cold model load. Call src/local-client.js instead.',
  `The only exception is a line whose comment (same line or the line directly above) says \`${IO_OK_TOKEN} <the reason>\` (an empty reason does not count). Leave existing lines alone.`,
].join(' ');

// For the model that reviews the draft.
const REVIEW_LINES = [
  'MODEL RELOAD CHECK:',
  WHAT_RELOADS_THE_MODEL,
  `If an ADDED line does one of these outside src/local-client.js, vote REJECT unless that line or the line directly above carries \`${IO_OK_TOKEN} <non-empty reason>\`.`,
  'Test files and lines that were already in the file are NOT grounds to reject.',
].join(' ');

module.exports = { PLAN_LINES, IMPLEMENT_LINES, REVIEW_LINES, WHAT_RELOADS_THE_MODEL, IO_OK_TOKEN };
