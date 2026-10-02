// Models tab: the model/stage configuration view and the benchmark runner (panel, radar chart, results tables). Moved verbatim out of analytics-and-discovery.js (2026-10-02);
// a plain global <script>, loaded by index.html right after analytics-and-discovery.js and above the inline script.
// No require()/module.exports: the browser loads this with a plain <script src> tag, so every name below is a shared global.

async function renderModelsTab() {
  // Every fetch this tab needs -- including the benchmark panel's -- happens up front, in
  // parallel, BEFORE any DOM write (2026-08-19, Grimmethy: "I refreshed and my screen
  // still flashes"). The previous version wrote an EMPTY '<div id="benchmark-panel">'
  // placeholder first and only populated it after its own separate await chain resolved
  // (which itself wrote an empty '#benchmark-results' placeholder, populated by a THIRD
  // await) -- a real collapse-then-expand on every single 5s background refresh, not just
  // a scroll-offset problem (the earlier scrollY save/restore fix only corrected the
  // FINAL position after that flash had already been visible). Fetching everything first
  // and writing main.innerHTML exactly once eliminates the intermediate empty states
  // entirely, so there is nothing left to flash.
  const [models, usageRows, costSummary, settingsPanel, usagePanel, benchModels, benchCases, benchStatus, benchRuns] = await Promise.all([
    fetchJson('/api/models'),
    fetchJson('/api/models/usage'),
    fetchJson('/api/models/cost-summary'),
    renderClaudeSettingsPanel(),
    renderClaudeUsagePanel(),
    benchmarkModelsCache || fetchJson('/api/benchmark/models').then(r => { benchmarkModelsCache = r.ollamaModels || []; return benchmarkModelsCache; }),
    benchmarkCasesCache || fetchJson('/api/benchmark/cases').then(r => { benchmarkCasesCache = r; return r; }),
    fetchJson('/api/benchmark/status'),
    fetchJson('/api/benchmark/runs'),
  ]);
  if (benchmarkSelectedModels.size === 0 && benchmarkSelectedCases.size === 0) {
    benchModels.forEach(m => benchmarkSelectedModels.add(m));
    benchCases.forEach(c => benchmarkSelectedCases.add(c.id));
  }
  // Default to the combined view across every saved run (2026-08-24, Grimmethy: "results
  // should default to All Runs (combined)") -- was defaulting to just the single most
  // recent run, which is also why the radar chart (aggregate-only per the same request
  // earlier today) wasn't visible without a manual dropdown click.
  const viewingRunId = benchmarkViewingRunId || (benchRuns.length > 0 ? BENCHMARK_ALL_RUNS_ID : null);
  const benchResultsHtml = await buildBenchmarkResultsHtml(viewingRunId, benchRuns);
  const benchmarkPanelHtml = buildBenchmarkPanelHtml(benchModels, benchCases, benchStatus, benchRuns, viewingRunId, benchResultsHtml);

  const main = document.getElementById('main');

  const sorted = models.slice().sort((a, b) => {
    const av = a[modelsSortKey], bv = b[modelsSortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;   // nulls last regardless of direction
    if (bv == null) return -1;
    if (av < bv) return modelsSortDir === 'asc' ? -1 : 1;
    if (av > bv) return modelsSortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const maxApprove = Math.max(...models.map(m => m.approveRate ?? 0), 0);
  const maxTokS = Math.max(...models.map(m => m.avgTokensPerSec ?? 0), 0);

  const headCells = MODELS_COLUMNS.map(col => {
    if (!col.sortable) return `<th>${col.label}</th>`;
    const arrow = modelsSortKey === col.key ? (modelsSortDir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="sortable" data-key="${col.key}">${col.label}${arrow}</th>`;
  }).join('');

  const rows = sorted.map((m, i) => `
    <tr class="${i === 0 ? 'top-row' : ''}">
      <td>${m.model}</td>
      <td>${m.callCount}</td>
      <td>${renderBarCell(m.approveRate, maxApprove, 'ok', fmtPct)}</td>
      <td>${renderBarCell(m.avgTokensPerSec, maxTokS, 'accent', (v) => fmtNum(v, 1))}</td>
      <td>${fmtNum(m.minTokensPerSec, 1)}</td>
      <td>${fmtNum(m.maxTokensPerSec, 1)}</td>
      <td>${fmtNum(m.avgLatencyMs, 0)}</td>
      <td>${m.degenerateCount}</td>
      <td>${m.errorCount}</td>
      <td>${fmtUsd(m.totalCostUsd)}</td>
    </tr>
  `).join('');

  const implementTable = models.length === 0
    ? '<div class="empty">No implement-pass stats yet -- set AGENT_MANAGER_CLAUDE_SOURCES or ORNITH_AB_MODELS to compare candidates.</div>'
    : `<table><thead><tr>${headCells}</tr></thead><tbody>${rows}</tbody></table>`;

  // Estimated Anthropic API Cost (2026-08-23, Grimmethy: "Do we have any way of knowing
  // how much these tasks would cost using anthropic API?") -- claude-client.js's call()
  // has always computed a real per-call cost estimate (Claude Code CLI's own
  // total_cost_usd, against real Anthropic API pricing) but nothing stored or surfaced
  // it until now. Explicitly labeled "estimate, not a bill" -- every real call here runs
  // under a Claude subscription, never pay-per-token, so this is what the SAME work
  // would have cost on the API, not what was actually charged.
  const mostRecentDay = costSummary.byDay && costSummary.byDay[0] ? costSummary.byDay[0] : null;
  // hypothetical (2026-08-23, Grimmethy: "Clarification on the anthropic costs. I'd like
  // estimates for if we had used the API. Even if we used the local models.") -- unlike
  // totalCostUsd above (real spend, only real Claude calls contribute), this covers
  // EVERY call, local ones included (a token-based estimate via anthropic-pricing.js for
  // those) -- see api_models_cost_summary's own docstring.
  const hyp = costSummary.hypothetical || { totalCostUsd: 0, totalCalls: 0 };
  const costWidget = `
    <div class="grill-session" style="margin-bottom:16px">
      <div class="field-label">Estimated Anthropic API Cost</div>
      <div class="row" style="gap:24px;margin-top:6px">
        <div class="stat" title="What every recorded Claude call would have cost on real Anthropic API pricing -- these calls actually ran under a subscription, never billed per-token. An estimate of avoided/equivalent cost, not a bill."><strong>${fmtUsd(costSummary.totalCostUsd)}</strong>real spend (all time)</div>
        <div class="stat"><strong>${costSummary.callsWithCost}</strong>Claude calls</div>
        <div class="stat" title="Local Ollama calls -- genuinely free, not just unbilled."><strong>${costSummary.freeCalls}</strong>free (local) calls</div>
        ${mostRecentDay ? `<div class="stat"><strong>${fmtUsd(mostRecentDay.totalCost)}</strong>${escapeHtml(mostRecentDay.day)} (${mostRecentDay.calls} call(s))</div>` : ''}
      </div>
      <div class="row" style="gap:24px;margin-top:6px">
        <div class="stat" title="What EVERY call this pipeline has ever made -- including the ones that ran locally, free -- would have cost had it gone through the Anthropic API instead. Real Claude calls use their real cost; local calls are a token-based estimate."><strong>${fmtUsd(hyp.totalCostUsd)}</strong>if every call had used the API (${hyp.totalCalls} call(s))</div>
      </div>
    </div>`;

  const usageTableRows = usageRows.map(r => `
    <tr>
      <td>${escapeHtml(r.model)}</td>
      <td>${escapeHtml(r.stage)}</td>
      <td>${r.callCount}</td>
      <td>${fmtNum(r.avgLatencyMs, 0)}</td>
      <td>${r.lastUsedAt ? new Date(r.lastUsedAt).toLocaleString() : ''}</td>
    </tr>
  `).join('');
  const usageTable = usageRows.length === 0 ? '' : `
    <div class="field-label" style="margin-top:20px">All Calls (every stage, both providers)</div>
    <table><thead><tr><th>Model</th><th>Stage</th><th>Calls</th><th>Avg Latency (ms)</th><th>Last Used</th></tr></thead>
    <tbody>${usageTableRows}</tbody></table>`;

  // Scroll-position preservation on top of the single-write fix above: the generic 5s
  // refresh() cycle (see its own comment near setInterval(refresh, 5000)) still re-renders
  // this whole tab on a timer regardless of what the user is doing on it, so restoring
  // window.scrollY keeps their reading position stable across a background refresh they
  // didn't ask for, even though the write itself no longer has an empty intermediate state.
  const scrollY = window.scrollY;
  main.innerHTML = settingsPanel + usagePanel + costWidget + '<div class="field-label">Implement-Pass Quality</div>' + implementTable + usageTable
    + benchmarkPanelHtml;
  wireClaudeSettingsPanel();
  main.querySelectorAll('th.sortable').forEach(th => {
    th.onclick = () => {
      const key = th.dataset.key;
      modelsSortDir = (modelsSortKey === key && modelsSortDir === 'desc') ? 'asc' : 'desc';
      modelsSortKey = key;
      renderModelsTab();
    };
  });
  wireBenchmarkPanel(benchModels, benchCases);
  window.scrollTo(0, scrollY);
}

function buildBenchmarkPanelHtml(models, cases, status, runs, viewingRunId, resultsHtml) {
  const running = status.status === 'running';
  const categories = [...new Set(cases.map(c => c.category))];

  const modelChecks = models.map(m => `
    <label class="benchmark-check"><input type="checkbox" class="bench-model-check" value="${escapeAttr(m)}" ${benchmarkSelectedModels.has(m) ? 'checked' : ''} ${running ? 'disabled' : ''}> ${escapeHtml(m)}</label>
  `).join('');

  // stats (best/worst scoring model pooled across every saved run, see app.py's
  // _compute_case_stats) render inline next to each case -- one row per case rather than
  // the models list's wrapped chip grid, since there's no room for this much text in a chip.
  const renderCaseStats = (c) => {
    if (!c.stats) return '';
    const { best, worst } = c.stats;
    const pct = (s) => `${Math.round(s.score * 100)}%`;
    return ` <span class="bench-case-stats">best: <strong class="ok-text">${escapeHtml(best.model)}</strong> (${pct(best)}) &middot; worst: <strong class="bad-text">${escapeHtml(worst.model)}</strong> (${pct(worst)})</span>`;
  };

  const caseChecks = categories.map(cat => `
    <div class="bench-category-group">
      <div class="meta" style="margin-top:6px"><strong>${escapeHtml(cat)}</strong></div>
      ${cases.filter(c => c.category === cat).map(c => `
        <div class="benchmark-check"><input type="checkbox" class="bench-case-check" value="${escapeAttr(c.id)}" ${benchmarkSelectedCases.has(c.id) ? 'checked' : ''} ${running ? 'disabled' : ''}> <a href="#" class="bench-case-info" data-case-id="${escapeAttr(c.id)}" title="Click for what this test measures and its full prompt">${escapeHtml(c.id)}</a>${c.grader === 'judge' ? ' <span class="badge warn" title="Graded by a Claude subscription call, not auto-checkable">judge</span>' : ''}${renderCaseStats(c)}</div>
      `).join('')}
    </div>
  `).join('');

  const progressHtml = running ? `
    <div class="grill-session" style="margin-top:10px">
      <div class="field-label">Running: ${escapeHtml(status.runId)}</div>
      <div>${status.completedSteps}/${status.totalSteps} steps${status.currentModel ? ` -- currently ${escapeHtml(status.currentModel)} :: ${escapeHtml(status.currentCase || '')}` : ''}</div>
      <div class="bar-track" style="margin-top:6px"><div class="bar-fill" style="width:${status.totalSteps ? Math.round(100 * status.completedSteps / status.totalSteps) : 0}%; background:var(--accent)"></div></div>
    </div>` : '';

  // "All Runs (combined)" (2026-08-19, Grimmethy: "I only see 2 runs... we should have run
  // 3 times each now") -- the underlying data was always complete (every saved run's
  // responses pool correctly into the case picker's best/worst stats above), but the
  // Responses table below is scoped to ONE selected run by design (that's what "a run" IS
  // -- one invocation, N cases x M repeats), so after running the same model in two
  // separate invocations there was no single place to see every response from both at
  // once. This pseudo-run option covers that.
  const runOptions = [`<option value="${BENCHMARK_ALL_RUNS_ID}" ${viewingRunId === BENCHMARK_ALL_RUNS_ID ? 'selected' : ''}>All Runs (combined)</option>`]
    .concat(runs.map(r => `<option value="${escapeAttr(r.runId)}" ${viewingRunId === r.runId ? 'selected' : ''}>${escapeHtml(r.runId)} (${r.models.length} model${r.models.length === 1 ? '' : 's'}, ${r.caseIds.length} case${r.caseIds.length === 1 ? '' : 's'}, ${r.runs} run${r.runs === 1 ? '' : 'x'})</option>`))
    .join('');
  const runPicker = runs.length === 0 ? '<div class="empty">No saved benchmark runs yet.</div>' : `
    <select id="benchmark-run-picker">${runOptions}</select>`;

  return `
    <div class="field-label" style="margin-top:24px">Reasoning Benchmark</div>
    <div class="grill-session">
      <div class="meta">Compare local models on a fixed battery of reasoning probes (misdirection traps, logic puzzles, code tracing, planning, quantitative -- plus open-ended reasoning cases scored by a Claude judge call). Every response is saved to Second Brain and browsable below, same as any other task.</div>
      <div style="margin-top:10px"><strong>Models</strong> (<a href="#" id="bench-models-all">all</a> / <a href="#" id="bench-models-none">none</a>)</div>
      <div class="benchmark-check-grid">${modelChecks || '<div class="empty">No local Ollama models found.</div>'}</div>
      <div style="margin-top:10px"><strong>Test Cases</strong> (<a href="#" id="bench-cases-all">all</a> / <a href="#" id="bench-cases-none">none</a>)</div>
      <div class="benchmark-check-grid">${caseChecks}</div>
      <div class="row" style="margin-top:10px;align-items:center;gap:10px">
        <label>Runs per case <input type="number" id="bench-runs-input" min="1" max="20" value="1" style="width:60px" ${running ? 'disabled' : ''}></label>
        <label><input type="checkbox" id="bench-judge-input" ${running ? 'disabled' : ''}> Include judge-graded cases (uses Claude subscription)</label>
        <button type="button" class="action" id="bench-run-btn" ${running ? 'disabled' : ''}>${running ? 'Running...' : 'Run Benchmark'}</button>
      </div>
      ${progressHtml}
    </div>
    <div class="field-label" style="margin-top:20px">Results</div>
    <div style="margin-bottom:10px">${runPicker}</div>
    <div id="benchmark-results">${resultsHtml}</div>
  `;
}

async function buildBenchmarkResultsHtml(viewingRunId, runs) {
  if (!viewingRunId) return '<div class="empty">No saved benchmark runs yet.</div>';
  if (viewingRunId === BENCHMARK_ALL_RUNS_ID) {
    const fetched = await Promise.all(runs.map(r => fetchJson(`/api/benchmark/runs/${encodeURIComponent(r.runId)}`).catch(() => null)));
    return buildAllRunsResultsHtml(fetched.filter(Boolean));
  }
  let run;
  try {
    run = await fetchJson(`/api/benchmark/runs/${encodeURIComponent(viewingRunId)}`);
  } catch (e) {
    return `<div class="empty">Could not load run: ${escapeHtml(e.message)}</div>`;
  }
  return buildSingleRunResultsHtml(run);
}

function buildSingleRunResultsHtml(run) {
  const models = run.models;
  const categories = [...new Set(run.results.map(r => r.category))];

  // Per-category pass-rate bars, one row per model -- same renderBarCell() the
  // Implement-Pass Quality table above already uses, so this reads as one visual system
  // rather than a bolted-on second chart style.
  const chartRows = categories.map(cat => {
    const cells = models.map(m => {
      const row = run.summary[m]?.byCategory?.[cat];
      if (!row) return '<td></td>';
      const pct = row.objectivePassRate != null ? row.objectivePassRate * 100 : (row.judgeAvg != null ? row.judgeAvg * 100 : null);
      const label = row.objective || (row.judgeAvg != null ? `judge ${row.judgeAvg.toFixed(2)}` : 'n/a');
      return `<td>${pct != null ? renderBarCell(pct, 100, 'ok', () => label) : label}</td>`;
    }).join('');
    return `<tr><td>${escapeHtml(cat)}</td>${cells}</tr>`;
  }).join('');
  const chartTable = `<table><thead><tr><th>Category</th>${models.map(m => `<th>${escapeHtml(m)}</th>`).join('')}</tr></thead><tbody>${chartRows}</tbody></table>`;

  const perfRows = models.map(m => {
    const s = run.summary[m] || {};
    return `<tr>
      <td>${escapeHtml(m)}</td>
      <td>${s.objectivePassed ?? '-'}/${s.objectiveTotal ?? '-'}</td>
      <td>${s.judgeTotal ? `${(s.avgJudgeScore ?? 0).toFixed(2)} (${s.judgeCount}/${s.judgeTotal})` : '-'}</td>
      <td>${s.degenerateCount ?? '-'}</td>
      <td>${fmtNum(s.avgLatencyMs, 0)}</td>
      <td>${s.avgTokensPerSec != null ? fmtNum(s.avgTokensPerSec, 1) : '-'}</td>
      <td>${s.loadDurationMs != null ? fmtNum(s.loadDurationMs, 0) : '-'}</td>
      <td>${s.unloadDurationMs != null ? fmtNum(s.unloadDurationMs, 0) : '-'}</td>
    </tr>`;
  }).join('');
  const perfTable = `<table><thead><tr><th>Model</th><th>Objective</th><th>Judge Avg</th><th>Degenerate</th><th>Avg Latency (ms)</th><th>Avg Tok/s</th><th>Load (ms)</th><th>Unload (ms)</th></tr></thead><tbody>${perfRows}</tbody></table>`;

  const responseTable = buildResponseTable(run.results.map(r => ({ ...r, runId: run.runId })));
  const radarHtml = models.length > 1 ? buildBenchmarkRadarHtml(models, run.results) : '';

  return `
    <div class="meta">Run ${escapeHtml(run.runId)} -- ${run.generatedAt ? new Date(run.generatedAt).toLocaleString() : ''}</div>
    <div class="field-label" style="margin-top:10px">Pass Rate by Category</div>
    ${chartTable}
    <div class="field-label" style="margin-top:16px">Performance</div>
    ${perfTable}
    <div class="field-label" style="margin-top:16px">Responses (click to view full prompt/response)</div>
    <div class="bench-responses-row">
      <div class="bench-responses-table">${responseTable}</div>
      ${radarHtml}
    </div>
  `;
}

function benchRadarColorFor(index) {
  return BENCH_RADAR_COLORS[index % BENCH_RADAR_COLORS.length];
}

function benchResultScore(r) {
  const grade = r.grade || {};
  if (grade.score != null) return grade.score;
  if (grade.pass === true) return 1;
  if (grade.pass === false) return 0;
  return null;
}

function buildBenchmarkRadarHtml(models, results) {
  // {caseId: {model: [scores...]}}
  const byCase = new Map();
  for (const r of results) {
    const score = benchResultScore(r);
    if (score == null) continue;
    if (!byCase.has(r.caseId)) byCase.set(r.caseId, new Map());
    const byModel = byCase.get(r.caseId);
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(score);
  }
  const caseIds = [...byCase.keys()];
  if (caseIds.length < 3) return ''; // a radar needs at least 3 axes to read as a shape

  const seriesByModel = models.map((model, i) => ({
    model,
    color: benchRadarColorFor(i),
    values: caseIds.map(caseId => {
      const scores = byCase.get(caseId)?.get(model);
      return scores && scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    }),
  }));

  const legend = `<div class="bench-radar-legend">${seriesByModel.map(s => `
    <span class="bench-radar-legend-item"><span class="bench-radar-swatch" style="background:${s.color}"></span>${escapeHtml(s.model)}</span>
  `).join('')}</div>`;

  return `
    <div class="bench-radar-wrap">
      ${legend}
      ${buildRadarChartSvg(caseIds, seriesByModel)}
    </div>
  `;
}

function buildRadarChartSvg(axisLabels, seriesByModel) {
  const size = 300;
  const center = size / 2;
  const radius = size / 2 - 46; // leave room for axis labels around the rim
  const n = axisLabels.length;
  const angleFor = (i) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const pointAt = (i, frac) => {
    const a = angleFor(i);
    return [center + radius * frac * Math.cos(a), center + radius * frac * Math.sin(a)];
  };

  const ringSteps = [0.25, 0.5, 0.75, 1];
  const rings = ringSteps.map(frac => {
    const pts = axisLabels.map((_, i) => pointAt(i, frac).join(',')).join(' ');
    return `<polygon points="${pts}" fill="none" stroke="#2c2c2a" stroke-width="1"></polygon>`;
  }).join('');

  const spokes = axisLabels.map((_, i) => {
    const [x, y] = pointAt(i, 1);
    return `<line x1="${center}" y1="${center}" x2="${x}" y2="${y}" stroke="#383835" stroke-width="1"></line>`;
  }).join('');

  const labels = axisLabels.map((label, i) => {
    const [x, y] = pointAt(i, 1.14);
    const short = label.length > 16 ? `${label.slice(0, 15)}…` : label;
    const anchor = Math.abs(Math.cos(angleFor(i))) < 0.15 ? 'middle' : (Math.cos(angleFor(i)) > 0 ? 'start' : 'end');
    return `<text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="middle" class="bench-radar-axis-label"><title>${escapeHtml(label)}</title>${escapeHtml(short)}</text>`;
  }).join('');

  const polygons = seriesByModel.map(s => {
    const pts = s.values.map((v, i) => pointAt(i, v == null ? 0 : v).join(',')).join(' ');
    const dots = s.values.map((v, i) => {
      if (v == null) return '';
      const [x, y] = pointAt(i, v);
      return `<circle cx="${x}" cy="${y}" r="3" fill="${s.color}"><title>${escapeHtml(s.model)}: ${Math.round(v * 100)}%</title></circle>`;
    }).join('');
    return `<polygon points="${pts}" fill="${s.color}" fill-opacity="0.12" stroke="${s.color}" stroke-width="2"></polygon>${dots}`;
  }).join('');

  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${rings}${spokes}${polygons}${labels}</svg>`;
}

function buildAllRunsResultsHtml(runsData) {
  if (runsData.length === 0) return '<div class="empty">No saved benchmark runs yet.</div>';
  const allResults = runsData.flatMap(run => run.results.map(r => ({ ...r, runId: run.runId })))
    .sort((a, b) => (a.model === b.model ? a.caseId.localeCompare(b.caseId) : a.model.localeCompare(b.model)));
  const totalRuns = runsData.length;
  const allModels = [...new Set(runsData.flatMap(run => run.models))].sort();
  const radarHtml = allModels.length > 1 ? buildBenchmarkRadarHtml(allModels, allResults) : '';
  return `
    <div class="meta">${allResults.length} response${allResults.length === 1 ? '' : 's'} across ${totalRuns} saved run${totalRuns === 1 ? '' : 's'}.</div>
    <div class="field-label" style="margin-top:16px">Responses (click to view full prompt/response)</div>
    <div class="bench-responses-row">
      <div class="bench-responses-table">${buildResponseTable(allResults)}</div>
      ${radarHtml}
    </div>
  `;
}

function buildResponseTable(rows) {
  const responseRows = rows.map(r => {
    const verdict = r.grade.pass === true ? '<span class="badge ok">PASS</span>' : r.grade.pass === false ? '<span class="badge bad">FAIL</span>' : '<span class="badge">ungraded</span>';
    const id = `${r.model.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')}__${r.caseId}__run${r.runIndex}`;
    return `<tr class="worker-card" data-bench-response="${escapeAttr(id)}" data-bench-run="${escapeAttr(r.runId)}" style="cursor:pointer">
      <td>${escapeHtml(r.model)}</td><td>${escapeHtml(r.caseId)}</td><td>${r.runIndex}</td><td>${verdict}</td>
      <td>${fmtNum(r.latencyMs, 0)}ms</td><td>${r.metrics.tokensPerSecond != null ? fmtNum(r.metrics.tokensPerSecond, 1) : '-'}</td>
    </tr>`;
  }).join('');
  return `<table><thead><tr><th>Model</th><th>Case</th><th>Run</th><th>Result</th><th>Latency</th><th>Tok/s</th></tr></thead><tbody>${responseRows}</tbody></table>`;
}

function wireBenchmarkPanel(models, cases) {
  document.querySelectorAll('.bench-model-check').forEach(cb => {
    cb.onchange = () => { cb.checked ? benchmarkSelectedModels.add(cb.value) : benchmarkSelectedModels.delete(cb.value); };
  });
  document.querySelectorAll('.bench-case-check').forEach(cb => {
    cb.onchange = () => { cb.checked ? benchmarkSelectedCases.add(cb.value) : benchmarkSelectedCases.delete(cb.value); };
  });
  document.querySelectorAll('.bench-case-info').forEach(a => {
    a.onclick = (e) => {
      e.preventDefault();
      const kase = cases.find(c => c.id === a.dataset.caseId);
      if (kase) renderCaseInfoModal(kase);
    };
  });
  const bindAllNone = (allId, noneId, set, values) => {
    document.getElementById(allId).onclick = (e) => { e.preventDefault(); values.forEach(v => set.add(v)); renderModelsTab(); };
    document.getElementById(noneId).onclick = (e) => { e.preventDefault(); set.clear(); renderModelsTab(); };
  };
  bindAllNone('bench-models-all', 'bench-models-none', benchmarkSelectedModels, models);
  bindAllNone('bench-cases-all', 'bench-cases-none', benchmarkSelectedCases, cases.map(c => c.id));

  const runBtn = document.getElementById('bench-run-btn');
  if (runBtn) {
    runBtn.onclick = async () => {
      const runs = Math.max(1, Math.min(20, Number(document.getElementById('bench-runs-input').value) || 1));
      const includeJudge = document.getElementById('bench-judge-input').checked;
      try {
        const resp = await fetch('/api/benchmark/run', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ models: [...benchmarkSelectedModels], caseIds: [...benchmarkSelectedCases], runs, includeJudge }),
        });
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          throw new Error(body.description || `${resp.status}`);
        }
        const data = await resp.json();
        benchmarkViewingRunId = data.runId;
        await renderModelsTab();
      } catch (e) {
        alert('Could not start benchmark: ' + e.message);
      }
    };
  }
  const picker = document.getElementById('benchmark-run-picker');
  if (picker) {
    picker.onchange = () => { benchmarkViewingRunId = picker.value; renderModelsTab(); };
  }
  document.querySelectorAll('[data-bench-response]').forEach(row => {
    row.onclick = async () => {
      try {
        const task = await fetchJson(`/api/benchmark/response/${encodeURIComponent(row.dataset.benchRun)}/${encodeURIComponent(row.dataset.benchResponse)}`);
        renderTaskDetailModal(task);
      } catch (e) {
        alert('Could not load response: ' + e.message);
      }
    };
  });
}
