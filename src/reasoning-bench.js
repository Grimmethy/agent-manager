'use strict';

// Reasoning benchmark for comparing local Ollama models head-to-head (originally: is
// qwen3.8:27b-q4_K_M actually a better "reasoning tier" model than ornith:35b, or just a
// different one -- Grimmethy, 2026-08-19, after ornith proved weak in the worker-reasoning
// slot). Deliberately standalone from the rest of this package's config.js/task-source
// machinery -- this is a manual analysis tool (invoked directly, or as a background
// process launched by the dashboard's Models tab, see python/dashboard/app.py's
// api_benchmark_run) rather than a pipeline daemon, so it only needs OLLAMA_URL/model
// names (local-client.js's own env vars) plus, optionally, CLAUDE_CODE_OAUTH_TOKEN for
// judge-graded cases and SECOND_BRAIN_DIR for persisting responses.
//
// Runs the fixed case battery (reasoning-bench-cases.js) against each requested model, one
// model's full case set at a time (not interleaved) -- minimizes Ollama model-swap churn
// during the run itself to exactly (modelCount - 1) swaps, and each real call still goes
// through local-client.js's own in-flight lock (model-inflight-lock.js), so if the live
// pipeline (local-worker.sh/review-runner.sh) is running at the same time, THEIR
// should_yield_for_model_swap guard will back off while this is actively calling a
// different model -- but this script does not itself wait on anything, so for a clean,
// uncontended run, stop the pipeline daemons first (stop.sh) rather than relying on that.
//
// Two grading modes per case (see reasoning-bench-cases.js's own header for the full
// contract): objective (exact/numeric/regex match against a "FINAL ANSWER: <x>" line the
// prompt asks every model to end with) and judge (a Claude subscription call scores the
// FULL response 0.0-1.0 against a written rubric -- for cases with no single objectively-
// checkable answer, e.g. "is this argument valid reasoning, not just a true conclusion").
//
// Per-model load/unload timing (2026-08-19, Grimmethy: "we need to know how long it takes
// a model to load or unload"): a tiny warm-up call brackets the START of each model's case
// loop (isolates cold-load cost -- Ollama's own `load_duration` field -- from the first
// real case's timing) and an explicit keep_alive:0 call brackets the END (Ollama unloads
// synchronously before responding to that call, so its own wall-clock IS the unload cost).
//
// Every response (2026-08-19, Grimmethy: "each benchmark test response should be saved in
// second brain and accessible to the user in app, same as reading any other task") is
// written as a task-shaped JSON file under SECOND_BRAIN_DIR/Model Benchmarks/<runId>/ --
// same field names (title, promptContext.rawText, planResponse, implementResponse,
// history[]) the dashboard's existing renderTaskDetailModal() already knows how to render
// generically for a real pipeline task, so no new frontend viewer was needed for these to
// be "readable same as any other task." A parallel .md file holds the same content as a
// plain-text note, browsable directly in the vault outside the app.
//
// CLI:
//   node reasoning-bench.js [--models m1,m2,...] [--categories c1,c2,...] [--cases id1,id2,...]
//                           [--runs N] [--judge-model sonnet] [--no-judge] [--out path.json]
//                           [--second-brain-dir DIR] [--run-id ID] [--progress-out path.json]
//
// Prints a summary table to stdout; --out additionally writes the full aggregate transcript
// to a JSON file for manual spot-checking (grading a "judge" case is itself a judgment
// call worth eyeballing, not treating as ground truth).

const fs = require('fs');
const path = require('path');
const local = require('./local-client.js');
const { postJson } = require('./ollama-http.js');
const { CASES } = require('./reasoning-bench-cases.js');

// No hardcoded model tags -- see local-client.js's own comment (2026-08-22, Grimmethy:
// "models should be fully interchangeable and their names should not be hardcoded
// anywhere"). Defaults to whichever local model is actually configured (LOCAL_MODEL);
// callers wanting a specific comparison should pass --models explicitly.
const DEFAULT_MODELS = [process.env.LOCAL_MODEL].filter(Boolean);
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

function parseArgs(argv) {
  const out = {
    models: null, categories: null, caseIds: null, runs: 1, judgeModel: null, noJudge: false,
    out: null, secondBrainDir: process.env.SECOND_BRAIN_DIR || null, runId: null, progressOut: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inlineValue] = arg.startsWith('--') ? arg.slice(2).split(/=(.*)/s) : [null, null];
    const takeValue = () => (inlineValue !== undefined ? inlineValue : argv[++i]);
    if (flag === 'models') out.models = takeValue().split(',').map((s) => s.trim()).filter(Boolean);
    else if (flag === 'categories') out.categories = takeValue().split(',').map((s) => s.trim()).filter(Boolean);
    else if (flag === 'cases') out.caseIds = takeValue().split(',').map((s) => s.trim()).filter(Boolean);
    else if (flag === 'runs') out.runs = Math.max(1, Number(takeValue()) || 1);
    else if (flag === 'judge-model') out.judgeModel = takeValue();
    else if (flag === 'no-judge') out.noJudge = true;
    else if (flag === 'out') out.out = takeValue();
    else if (flag === 'second-brain-dir') out.secondBrainDir = takeValue();
    else if (flag === 'run-id') out.runId = takeValue();
    else if (flag === 'progress-out') out.progressOut = takeValue();
  }
  return out;
}

function extractFinalAnswer(text) {
  if (!text) return null;
  const matches = [...text.matchAll(/FINAL ANSWER:\s*(.+)/gi)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1].trim().replace(/[.\s]+$/, '');
}

function normalize(s) {
  return s.toLowerCase().trim().replace(/["'.]/g, '').replace(/\s+/g, ' ');
}

function parseNumberOrFraction(s) {
  const trimmed = s.trim();
  const frac = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const num = trimmed.match(/-?\d+(?:\.\d+)?/);
  return num ? Number(num[0]) : null;
}

function gradeExact(answer, expected) {
  if (answer == null) return { pass: false, reason: 'no FINAL ANSWER line found' };
  return { pass: normalize(answer) === normalize(expected), reason: `got "${answer}"` };
}

function gradeNumeric(answer, expected, tolerance = 0) {
  if (answer == null) return { pass: false, reason: 'no FINAL ANSWER line found' };
  const num = parseNumberOrFraction(answer);
  if (num == null) return { pass: false, reason: `could not parse a number from "${answer}"` };
  return { pass: Math.abs(num - expected) <= tolerance, reason: `got ${num}, expected ${expected}` };
}

function gradeRegex(answer, expectedSource) {
  if (answer == null) return { pass: false, reason: 'no FINAL ANSWER line found' };
  const re = new RegExp(expectedSource, 'i');
  const compact = answer.replace(/\s+/g, '').toUpperCase();
  return { pass: re.test(compact), reason: `got "${answer}"` };
}

function buildJudgePrompt(question, candidateResponse, rubric) {
  return `You are grading a candidate model's answer to a reasoning question. Score strictly on the reasoning quality described in the rubric -- not on writing style, length, or confidence.

QUESTION GIVEN TO THE CANDIDATE:
${question}

RUBRIC (what separates a strong answer from a weak one):
${rubric}

CANDIDATE'S FULL RESPONSE:
${candidateResponse || '(empty response)'}

Score the candidate's response on a 0.0-1.0 scale (1.0 = fully matches the strong-answer criteria, 0.0 = matches the weak-answer failure mode described, use values in between for partial credit). Respond with EXACTLY two lines and nothing else:
SCORE: <a number between 0.0 and 1.0>
REASON: <one or two sentences justifying the score>`;
}

async function gradeJudge(kase, candidateResponse, judgeModel, claudeClient) {
  const prompt = buildJudgePrompt(kase.prompt, candidateResponse, kase.expected);
  let result;
  try {
    result = await claudeClient.call({ prompt, model: judgeModel }, 1);
  } catch (e) {
    return { pass: null, score: null, reason: `judge call failed: ${e.message}` };
  }
  const scoreMatch = (result.response || '').match(/SCORE:\s*([0-9.]+)/i);
  const reasonMatch = (result.response || '').match(/REASON:\s*(.+)/is);
  const score = scoreMatch ? Number(scoreMatch[1]) : null;
  return {
    pass: score != null ? score >= 0.6 : null,
    score,
    reason: reasonMatch ? reasonMatch[1].trim() : (result.response || '').trim() || 'judge returned no parseable score',
  };
}

// Every field Ollama's /api/generate itself reports beyond `response`/`thinking` --
// load_duration, prompt_eval_count/duration, eval_count/duration, total_duration,
// done_reason -- passes straight through local-client.js's call()/callOnce() via its own
// `{ ...result }` spread, but the ORIGINAL version of this harness only ever read
// `.response`/`.degenerate`/`.attempts` off it, silently discarding the rest. That gap is
// exactly what made an earlier investigation session mischaracterize qwen3.8:27b-q4_K_M as
// having ~1 token/sec throughput (an estimate built from response-CHARACTER-count/wall-
// clock, which counts neither the model's hidden `thinking` tokens nor the real per-call
// eval_count/eval_duration Ollama already reports) -- this pulls every one of those real
// fields through so that mistake can't repeat.
function extractMetrics(callResult) {
  const evalCount = callResult.eval_count ?? null;
  const evalDurationMs = callResult.eval_duration != null ? callResult.eval_duration / 1e6 : null;
  return {
    totalDurationMs: callResult.total_duration != null ? callResult.total_duration / 1e6 : null,
    loadDurationMs: callResult.load_duration != null ? callResult.load_duration / 1e6 : null,
    promptEvalCount: callResult.prompt_eval_count ?? null,
    promptEvalDurationMs: callResult.prompt_eval_duration != null ? callResult.prompt_eval_duration / 1e6 : null,
    evalCount,
    evalDurationMs,
    tokensPerSecond: evalCount != null && evalDurationMs ? evalCount / (evalDurationMs / 1000) : null,
    doneReason: callResult.done_reason ?? null,
    thinkingChars: (callResult.thinking || '').length,
  };
}

// Brackets a model's case loop: a trivial warm-up call isolates cold-load cost (Ollama's
// own load_duration, whether this is truly the first load or a keep_alive-expired reload)
// from case #1's timing, and an explicit keep_alive:0 call unloads synchronously before
// Ollama responds -- that response's OWN wall-clock time is a real, direct measurement of
// unload cost, not an estimate. Never throws -- a warm-up/unload failure (Ollama
// unreachable, model name typo) degrades to null timings rather than aborting the whole
// model's benchmark run over a measurement nicety.
async function measureLoad(model) {
  const t0 = Date.now();
  try {
    const result = await postJson(`${OLLAMA_URL}/api/generate`, { model, prompt: 'hi', think: false, stream: false, keep_alive: '30m', options: { num_predict: 1 } }, 120_000);
    return { loadDurationMs: result.load_duration != null ? result.load_duration / 1e6 : null, wallClockMs: Date.now() - t0, error: null };
  } catch (e) {
    return { loadDurationMs: null, wallClockMs: Date.now() - t0, error: e.message };
  }
}

async function measureUnload(model) {
  const t0 = Date.now();
  try {
    await postJson(`${OLLAMA_URL}/api/generate`, { model, prompt: '', stream: false, keep_alive: 0 }, 60_000);
    return { unloadDurationMs: Date.now() - t0, error: null };
  } catch (e) {
    return { unloadDurationMs: Date.now() - t0, error: e.message };
  }
}

async function runCase(model, kase, runIndex, judgeModel, judgeClient) {
  const t0 = Date.now();
  let callResult;
  try {
    // think:true -- these are reasoning probes, deliberately NOT disabling the model's
    // own chain-of-thought the way majorityVote's classification calls do. numPredict
    // raised well above local-draft.js's typical passes -- several cases (the logic
    // grid, the code trace) need real multi-step working, and truncating mid-reasoning
    // would fail them for a harness reason, not a model-quality one.
    callResult = await local.call({ prompt: kase.prompt, model, think: true, temperature: 0.2, numPredict: 1800 }, 1);
  } catch (e) {
    callResult = { response: '', thinking: '', degenerate: `call-error: ${e.message}`, attempts: 1 };
  }
  const latencyMs = Date.now() - t0;
  const answer = extractFinalAnswer(callResult.response);

  let grade;
  if (kase.grader === 'exact') grade = gradeExact(answer, kase.expected);
  else if (kase.grader === 'numeric') grade = gradeNumeric(answer, kase.expected, kase.tolerance || 0);
  else if (kase.grader === 'regex') grade = gradeRegex(answer, kase.expected);
  else if (kase.grader === 'judge') {
    grade = judgeClient
      ? await gradeJudge(kase, callResult.response, judgeModel, judgeClient)
      : { pass: null, score: null, reason: 'judge unavailable (CLAUDE_CODE_OAUTH_TOKEN not set, or --no-judge passed) -- ungraded, inspect the saved response manually' };
  } else {
    grade = { pass: null, score: null, reason: `unknown grader "${kase.grader}"` };
  }

  return {
    model,
    caseId: kase.id,
    category: kase.category,
    grader: kase.grader,
    runIndex,
    latencyMs,
    degenerate: callResult.degenerate,
    attempts: callResult.attempts,
    answer,
    response: callResult.response,
    thinking: callResult.thinking || '',
    metrics: extractMetrics(callResult),
    grade,
  };
}

function slugify(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function fmtMs(ms) {
  if (ms == null) return 'n/a';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

// Writes one response as a task-shaped JSON (field names renderTaskDetailModal() in
// python/dashboard/templates/index.html already renders generically for a real pipeline
// task -- title, promptContext.rawText, planResponse, implementResponse, history[] -- so
// no new frontend detail viewer was needed for these to be readable "same as any other
// task") plus a parallel .md note with the same content in plain text, browsable directly
// in the vault outside the dashboard. Returns the response id (used as the dashboard's
// per-row key).
function writeResponseArtifact(benchDir, kase, result) {
  const id = `${slugify(result.model)}__${kase.id}__run${result.runIndex}`;
  const m = result.metrics;
  const metricsLine = [
    `latency ${fmtMs(result.latencyMs)}`,
    m.tokensPerSecond != null ? `${m.tokensPerSecond.toFixed(1)} tok/s (${m.evalCount} tokens in ${fmtMs(m.evalDurationMs)})` : null,
    m.loadDurationMs != null ? `load ${fmtMs(m.loadDurationMs)}` : null,
    m.promptEvalCount != null ? `prompt ${m.promptEvalCount} tokens in ${fmtMs(m.promptEvalDurationMs)}` : null,
    m.doneReason ? `done_reason ${m.doneReason}` : null,
  ].filter(Boolean).join(', ');
  const gradeLine = result.grade.pass === true ? 'PASS' : result.grade.pass === false ? 'FAIL' : 'ungraded';

  const task = {
    id,
    title: `Benchmark: ${result.model} :: ${kase.id} (run ${result.runIndex})`,
    domain: 'model_benchmark',
    source: 'model_benchmark',
    runId: benchDir.runId,
    model: result.model,
    caseId: kase.id,
    category: kase.category,
    grader: kase.grader,
    runIndex: result.runIndex,
    promptContext: { rawText: kase.prompt },
    planResponse: result.thinking || '',
    implementResponse: result.response || '(empty response)',
    blockedReason: result.grade.pass === false || result.degenerate ? (result.degenerate ? `degenerate: ${result.degenerate}` : result.grade.reason) : null,
    grade: result.grade,
    metrics: m,
    history: [
      { stage: 'response', at: new Date().toISOString(), detail: metricsLine },
      { stage: 'grade', at: new Date().toISOString(), detail: `${gradeLine}${result.grade.reason ? ' -- ' + result.grade.reason : ''}` },
    ],
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(benchDir.dir, `${id}.json`), JSON.stringify(task, null, 2));

  const md = `# ${task.title}\n\n`
    + `**Model:** ${result.model}  \n**Case:** ${kase.id} (${kase.category})  \n**Grader:** ${kase.grader}  \n**Run:** ${result.runIndex}  \n**Result:** ${gradeLine}${result.grade.reason ? ' -- ' + result.grade.reason : ''}\n\n`
    + `## Metrics\n${metricsLine}\n\n`
    + `## Prompt\n${kase.prompt}\n\n`
    + (result.thinking ? `## Thinking\n${result.thinking}\n\n` : '')
    + `## Response\n${result.response || '(empty response)'}\n`;
  fs.writeFileSync(path.join(benchDir.dir, `${id}.md`), md);

  return id;
}

function ensureBenchDir(secondBrainDir, runId) {
  if (!secondBrainDir) return null;
  const dir = path.join(secondBrainDir, 'Model Benchmarks', runId);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, runId };
}

function writeProgress(progressOut, state) {
  if (!progressOut) return;
  try {
    fs.writeFileSync(progressOut, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
  } catch {
    // best-effort -- a progress-file write failure must never abort the actual benchmark run.
  }
}

function summarize(results, models, cases, modelTimings) {
  const byModel = {};
  for (const model of models) {
    const rows = results.filter((r) => r.model === model);
    const objective = rows.filter((r) => r.grader !== 'judge');
    const judged = rows.filter((r) => r.grader === 'judge');
    const objectivePassed = objective.filter((r) => r.grade.pass === true).length;
    const judgeScores = judged.map((r) => r.grade.score).filter((s) => s != null);
    const avgJudgeScore = judgeScores.length ? judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length : null;
    const degenerateCount = rows.filter((r) => r.degenerate).length;
    const avgLatencyMs = rows.length ? rows.reduce((a, r) => a + r.latencyMs, 0) / rows.length : 0;
    const tokRates = rows.map((r) => r.metrics.tokensPerSecond).filter((v) => v != null);
    const avgTokensPerSec = tokRates.length ? tokRates.reduce((a, b) => a + b, 0) / tokRates.length : null;

    const byCategory = {};
    for (const category of [...new Set(cases.map((c) => c.category))]) {
      const catRows = rows.filter((r) => r.category === category);
      const catObjective = catRows.filter((r) => r.grader !== 'judge');
      const catJudged = catRows.filter((r) => r.grader === 'judge');
      const catObjPassed = catObjective.filter((r) => r.grade.pass === true).length;
      const catJudgeScores = catJudged.map((r) => r.grade.score).filter((s) => s != null);
      byCategory[category] = {
        objectivePassRate: catObjective.length ? catObjPassed / catObjective.length : null,
        objective: catObjective.length ? `${catObjPassed}/${catObjective.length}` : null,
        judgeAvg: catJudgeScores.length ? (catJudgeScores.reduce((a, b) => a + b, 0) / catJudgeScores.length) : null,
      };
    }

    byModel[model] = {
      objectivePassed,
      objectiveTotal: objective.length,
      objectivePassRate: objective.length ? objectivePassed / objective.length : null,
      avgJudgeScore,
      judgeCount: judgeScores.length,
      judgeTotal: judged.length,
      degenerateCount,
      avgLatencyMs: Math.round(avgLatencyMs),
      avgTokensPerSec,
      loadDurationMs: modelTimings[model]?.loadDurationMs ?? null,
      unloadDurationMs: modelTimings[model]?.unloadDurationMs ?? null,
      byCategory,
    };
  }
  return byModel;
}

function printSummary(summary, models, cases) {
  console.log('\n=== Reasoning Bench Summary ===\n');
  for (const model of models) {
    const s = summary[model];
    console.log(`Model: ${model}`);
    console.log(`  Objective (exact/numeric/regex): ${s.objectivePassed}/${s.objectiveTotal} correct`);
    if (s.judgeTotal > 0) {
      console.log(`  Judge-graded: avg score ${s.avgJudgeScore != null ? s.avgJudgeScore.toFixed(2) : 'n/a'} (${s.judgeCount}/${s.judgeTotal} scored)`);
    }
    console.log(`  Degenerate responses: ${s.degenerateCount}`);
    console.log(`  Avg latency: ${s.avgLatencyMs}ms, avg ${s.avgTokensPerSec != null ? s.avgTokensPerSec.toFixed(1) : 'n/a'} tok/s`);
    console.log(`  Load: ${fmtMs(s.loadDurationMs)}, Unload: ${fmtMs(s.unloadDurationMs)}`);
    console.log('  By category:');
    for (const [category, row] of Object.entries(s.byCategory)) {
      const parts = [];
      if (row.objective != null) parts.push(`objective ${row.objective}`);
      if (row.judgeAvg != null) parts.push(`judge avg ${row.judgeAvg.toFixed(2)}`);
      if (parts.length) console.log(`    ${category}: ${parts.join(', ')}`);
    }
    console.log('');
  }
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  (async () => {
    const models = args.models || DEFAULT_MODELS;
    let cases = args.categories ? CASES.filter((c) => args.categories.includes(c.category)) : CASES;
    if (args.caseIds) cases = cases.filter((c) => args.caseIds.includes(c.id));
    if (cases.length === 0) {
      console.error(`No cases matched the given --categories/--cases filter. Known categories: ${[...new Set(CASES.map((c) => c.category))].join(', ')}`);
      process.exit(1);
    }

    let judgeClient = null;
    if (!args.noJudge && process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      judgeClient = require('./claude-client.js');
    } else if (!args.noJudge && cases.some((c) => c.grader === 'judge')) {
      console.error('[bench] CLAUDE_CODE_OAUTH_TOKEN is not set -- judge-graded cases will be left ungraded (pass --no-judge to silence this, or export the token to enable them).');
    }
    const judgeModel = args.judgeModel || process.env.CLAUDE_MODEL || 'sonnet';

    const runId = args.runId || `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const benchDir = ensureBenchDir(args.secondBrainDir, runId);
    if (!benchDir && !args.out) {
      console.error('[bench] warning: neither --second-brain-dir (nor SECOND_BRAIN_DIR) nor --out is set -- results will only print to stdout, nothing will be saved.');
    }

    const totalSteps = models.length * cases.length * args.runs;
    let completedSteps = 0;
    writeProgress(args.progressOut, { runId, status: 'running', totalSteps, completedSteps, models, caseIds: cases.map((c) => c.id), runs: args.runs, currentModel: null, currentCase: null, startedAt: new Date().toISOString() });

    const results = [];
    const modelTimings = {};
    for (const model of models) {
      process.stderr.write(`[bench] ${model} :: warming up (measuring load time)...\n`);
      const load = await measureLoad(model);
      modelTimings[model] = { loadDurationMs: load.loadDurationMs };
      process.stderr.write(`[bench] ${model} :: load ${fmtMs(load.loadDurationMs)}${load.error ? ` (warning: ${load.error})` : ''}\n`);

      for (const kase of cases) {
        for (let runIndex = 1; runIndex <= args.runs; runIndex++) {
          writeProgress(args.progressOut, { runId, status: 'running', totalSteps, completedSteps, models, caseIds: cases.map((c) => c.id), runs: args.runs, currentModel: model, currentCase: kase.id, currentRun: runIndex, startedAt: undefined });
          process.stderr.write(`[bench] ${model} :: ${kase.id} (run ${runIndex}/${args.runs})... `);
          const result = await runCase(model, kase, runIndex, judgeModel, judgeClient);
          results.push(result);
          if (benchDir) writeResponseArtifact(benchDir, kase, result);
          completedSteps++;
          const verdict = result.grade.pass === true ? 'PASS' : result.grade.pass === false ? 'FAIL' : 'ungraded';
          process.stderr.write(`${verdict} (${result.latencyMs}ms${result.metrics.tokensPerSecond != null ? `, ${result.metrics.tokensPerSecond.toFixed(1)} tok/s` : ''})\n`);
        }
      }

      process.stderr.write(`[bench] ${model} :: unloading (measuring unload time)...\n`);
      const unload = await measureUnload(model);
      modelTimings[model].unloadDurationMs = unload.unloadDurationMs;
      process.stderr.write(`[bench] ${model} :: unload ${fmtMs(unload.unloadDurationMs)}${unload.error ? ` (warning: ${unload.error})` : ''}\n`);
    }

    const summary = summarize(results, models, cases, modelTimings);
    printSummary(summary, models, cases);

    const transcript = { runId, generatedAt: new Date().toISOString(), models, caseIds: cases.map((c) => c.id), runs: args.runs, results, summary, modelTimings };
    if (args.out) fs.writeFileSync(args.out, JSON.stringify(transcript, null, 2));
    if (benchDir) fs.writeFileSync(path.join(benchDir.dir, '_summary.json'), JSON.stringify(transcript, null, 2));
    writeProgress(args.progressOut, { runId, status: 'done', totalSteps, completedSteps, models, caseIds: cases.map((c) => c.id), runs: args.runs, currentModel: null, currentCase: null, finishedAt: new Date().toISOString() });
    if (args.out) console.log(`Full transcript written to ${args.out}`);
    if (benchDir) console.log(`Responses + summary written to ${benchDir.dir}`);
  })().catch((e) => {
    console.error(e);
    if (args.progressOut) writeProgress(args.progressOut, { status: 'error', error: e.message });
    process.exit(1);
  });
}

module.exports = { extractFinalAnswer, gradeExact, gradeNumeric, gradeRegex, extractMetrics, summarize, runCase, slugify };
