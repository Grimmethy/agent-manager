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

async function renderDeepDiveTab() {
  const projects = await fetchJson('/api/deep-dive/projects');
  const main = document.getElementById('main');
  if (projects.length === 0) {
    main.innerHTML = '<div class="empty">No repos scouted yet -- project_search hasn\'t landed a Strong lead for deep_dive to pick up.</div>';
    return;
  }
  const rows = projects.map(p => `
    <tr class="clickable ${p.hotlist ? 'top-row' : ''}" data-slug="${escapeAttr(p.slug)}">
      <td onclick="event.stopPropagation()"><input type="checkbox" class="hotlist-toggle" data-slug="${escapeAttr(p.slug)}" ${p.hotlist ? 'checked' : ''} title="Move this repo to the top of the research priority list"></td>
      <td>${escapeHtml(p.slug)}</td>
      <td>${p.sourceUrl ? `<a href="${escapeAttr(p.sourceUrl)}" target="_blank" onclick="event.stopPropagation()">${escapeHtml(p.sourceUrl)}</a>` : ''}</td>
      <td>${p.reviewedCount} / ${p.communityCount}</td>
      <td>${p.totalActionItems}</td>
      <td>${p.clonedAt ? new Date(p.clonedAt).toLocaleString() : ''}</td>
    </tr>
  `).join('');
  main.innerHTML = `<table><thead><tr><th>Hot</th><th>Project</th><th>Source</th><th>Communities Reviewed</th><th>Action Items</th><th>Cloned</th></tr></thead><tbody>${rows}</tbody></table>`;
  main.querySelectorAll('tr.clickable').forEach(row => {
    row.onclick = () => openDeepDiveDetail(row.dataset.slug);
  });
  main.querySelectorAll('.hotlist-toggle').forEach(cb => {
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = () => toggleHotlist(cb.dataset.slug, cb.checked);
  });
}

async function toggleHotlist(slug, hotlist) {
  try {
    await fetch('/api/deep-dive/projects/' + encodeURIComponent(slug) + '/hotlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hotlist }),
    });
  } catch (e) {
    alert('Could not update hotlist: ' + e.message);
  }
  if (activeTab === 'deepdive') await renderDeepDiveTab();
}

function itemsForCommunity(items, community) {
  return items.filter((it) => (
    community.id != null && it.communityId != null
      ? it.communityId === community.id
      : it.community === community.name
  ));
}

function renderDeepDiveItems(items) {
  if (items.length === 0) return '<div class="empty">No action items for this selection.</div>';
  return items.map((it) => `
    <div class="worker-card">
      <div class="row">
        <span class="id">${escapeHtmlBright(it.title)}</span>
        <span class="badge ${it.rating === 'Use' ? 'ok' : it.rating === 'Adapt' ? 'warn' : 'idle'}">${escapeHtml(it.rating || '')}</span>
      </div>
      <div class="meta">${escapeHtml(it.community || '')}${it.files ? ' · ' + escapeHtml(it.files) : ''}</div>
      <div style="margin-top:8px">${escapeHtml(it.rationale || '')}</div>
    </div>
  `).join('');
}

function renderDeepDiveCommunityRows(detail, selectedIdx, items) {
  const rows = [];
  (detail.communities || []).forEach((c, i) => {
    const hasItems = (c.actionItemCount || 0) > 0;
    rows.push(`
      <tr class="${hasItems ? 'clickable' : ''} ${selectedIdx === i ? 'top-row' : ''}" data-community-idx="${i}">
        <td>${escapeHtml(c.name || '')}</td>
        <td>${c.lastReviewedAt ? new Date(c.lastReviewedAt).toLocaleString() : 'not yet reviewed'}</td>
        <td>${c.actionItemCount ?? '-'}</td>
      </tr>
    `);
    if (selectedIdx === i) {
      const shown = itemsForCommunity(items, { id: i, name: c.name });
      rows.push(`
        <tr>
          <td colspan="3" style="padding:0">
            <div style="padding:12px 4px 16px">
              <div class="field-label" style="margin-top:0">Ideas from "${escapeHtml(c.name)}" <a href="#" id="dd-collapse" style="margin-left:8px;font-weight:normal">(collapse)</a></div>
              ${renderDeepDiveItems(shown)}
            </div>
          </td>
        </tr>
      `);
    }
  });
  return rows.join('');
}

function renderDeepDiveDetailBody(detail, selectedIdx) {
  const items = detail.items || [];
  let html = `<div class="field-label">Communities (${(detail.communities || []).length}) -- click one with action items to see them inline</div>`;
  html += `<table><thead><tr><th>Name</th><th>Reviewed</th><th>Action Items</th></tr></thead><tbody>${renderDeepDiveCommunityRows(detail, selectedIdx, items)}</tbody></table>`;

  if (selectedIdx == null) {
    html += `<div class="field-label">All ideas picked from this repo</div>`;
    html += items.length === 0
      ? '<div class="empty">Nothing written up yet -- no community from this repo has cleared review.</div>'
      : renderDeepDiveItems(items);
  }
  return html;
}

function wireDeepDiveDetailHandlers(slug, selectedIdx) {
  document.querySelectorAll('#modal-content tr.clickable[data-community-idx]').forEach((row) => {
    const idx = Number(row.dataset.communityIdx);
    // Clicking the already-expanded row collapses it back rather than re-expanding it.
    row.onclick = () => openDeepDiveDetail(slug, idx === selectedIdx ? null : idx);
  });
  const collapse = document.getElementById('dd-collapse');
  if (collapse) collapse.onclick = (e) => { e.preventDefault(); openDeepDiveDetail(slug, null); };
}

async function openDeepDiveDetail(slug, selectedIdx = null) {
  const backdrop = document.getElementById('modal-backdrop');
  const content = document.getElementById('modal-content');

  // Re-opening the same project (selecting a different community) reuses the cached
  // fetch instead of re-fetching -- the underlying data can't have changed within one
  // modal session, and re-fetch would also flicker the "which row is highlighted" state.
  const detail = (deepDiveDetailCache && deepDiveDetailCache.slug === slug)
    ? deepDiveDetailCache
    : await fetchJson('/api/deep-dive/projects/' + encodeURIComponent(slug));
  deepDiveDetailCache = detail;

  let html = `<button class="close" onclick="closeDetail()">&times;</button><h2>${escapeHtml(detail.slug)}</h2>`;
  if (detail.sourceUrl) html += `<div><a href="${escapeAttr(detail.sourceUrl)}" target="_blank">${escapeHtml(detail.sourceUrl)}</a></div>`;
  html += renderDeepDiveDetailBody(detail, selectedIdx);

  content.innerHTML = html;
  backdrop.classList.add('open');
  wireDeepDiveDetailHandlers(slug, selectedIdx);
}

async function renderDiscoveryTab() {
  const d = await fetchJson('/api/discovery');
  discoveryCandidatesCache = d.candidates || [];
  const main = document.getElementById('main');
  if (!d.available) {
    main.innerHTML = '<div class="empty">No discovery state found for the active project -- community-coverage.json and the candidates doc appear once the project graph is built and arch_discovery has run.</div>';
    return;
  }

  const reviewed = d.communities.filter(c => c.lastReviewedAt).length;
  const inFlight = d.tasks.filter(t => t.state !== 'done');
  const doneRuns = d.tasks.filter(t => t.state === 'done');
  const nextCommunity = d.communities.find(c => c.id === d.nextCommunityId);
  const stats = `
    <div class="stat-row">
      <div class="stat"><strong>${reviewed} / ${d.communities.length}</strong>communities reviewed</div>
      <div class="stat"><strong>${inFlight.length}</strong>runs in flight</div>
      <div class="stat"><strong>${doneRuns.length}</strong>runs completed</div>
      <div class="stat"><strong>${d.candidates.length}</strong>candidates produced</div>
      <div class="stat"><strong>${nextCommunity ? escapeHtml(nextCommunity.name) : '--'}</strong>next up</div>
    </div>`;

  // Same order the job itself works in (nextArchDiscoveryTask's oldest-first rotation,
  // never-reviewed before any real timestamp), so the top of the table is always "what
  // discovery cares about right now".
  const sortedCommunities = [...d.communities].sort((a, b) =>
    (a.lastReviewedAt || '').localeCompare(b.lastReviewedAt || ''));
  // Only rows with something to say (in queue, next up, or actually reviewed) show by
  // default; the untouched tail collapses to a one-line count.
  const interesting = sortedCommunities.filter(c =>
    c.inFlightState || c.id === d.nextCommunityId || c.lastReviewedAt);
  const communities = discoveryShowAllCommunities ? sortedCommunities : interesting;
  const hiddenCount = sortedCommunities.length - communities.length;
  const communityRows = communities.map(c => {
    const status = c.inFlightState
      ? `<span class="badge warn">in queue: ${escapeHtml(c.inFlightState)}</span>`
      : c.id === d.nextCommunityId
        ? '<span class="badge ok">next up</span>'
        : c.lastReviewedAt
          ? '<span class="badge idle">reviewed</span>'
          : '<span class="badge idle">never reviewed</span>';
    return `<tr>
      <td>#${c.id} ${escapeHtml(c.name || '')}</td>
      <td>${status}</td>
      <td>${c.lastReviewedAt ? new Date(c.lastReviewedAt).toLocaleString() : ''}</td>
      <td>${c.lastCandidateCount ?? ''}</td>
    </tr>`;
  }).join('');

  const stateBadge = (s) => {
    const cls = s === 'done' ? 'ok' : s === 'blocked' ? 'bad'
      : (s === 'needs-clarification' || s === 'awaiting-confirm') ? 'warn' : 'idle';
    return `<span class="badge ${cls}">${escapeHtml(s)}</span>`;
  };
  const runRows = d.tasks.map(t => {
    // Whichever field carries the run's actual outcome -- same signal priority as
    // _adhoc_task_excerpt server-side.
    const result = t.blockedReason
      ? `<span style="color:var(--bad)">${escapeHtmlBright(t.blockedReason.slice(0, 140))}${t.blockedReason.length > 140 ? '…' : ''}</span>`
      : t.doneMarker
        ? escapeHtml(t.doneMarker)
        : t.hasImplement ? 'draft written' : t.hasPlan ? 'plan written' : '';
    return `<tr class="clickable" data-task-id="${escapeAttr(t.id)}" title="Click for the full readout (plan, draft, review verdicts)">
      <td>${escapeHtmlBright(t.title)}</td>
      <td>${stateBadge(t.state)}</td>
      <td>${t.createdAt ? new Date(t.createdAt).toLocaleString() : ''}</td>
      <td class="meta">${result}</td>
    </tr>`;
  }).join('');
  const runsTable = d.tasks.length === 0
    ? '<div class="empty">No arch-discovery runs in the queue yet.</div>'
    : `<table><thead><tr><th>Run</th><th>State</th><th>Created</th><th>Result</th></tr></thead><tbody>${runRows}</tbody></table>`;

  const candidateRows = d.candidates.map(c => `
    <tr class="clickable" data-candidate-id="${c.id}" title="Click to read the full write-up">
      <td><span class="bd-serial">AC-${String(c.id).padStart(3, '0')}</span></td>
      <td>${escapeHtmlBright(c.title)}</td>
      <td>${c.strength ? `<span class="badge ${c.strength === 'Strong' ? 'ok' : 'idle'}">${escapeHtml(c.strength)}</span>` : ''}</td>
      <td class="meta">${c.files.slice(0, 3).map(escapeHtml).join(', ')}${c.files.length > 3 ? ` +${c.files.length - 3} more` : ''}</td>
    </tr>`).join('');
  const candidatesTable = d.candidates.length === 0
    ? '<div class="empty">No candidates written yet.</div>'
    : `<table><thead><tr><th>ID</th><th>Candidate</th><th>Strength</th><th>Files</th></tr></thead><tbody>${candidateRows}</tbody></table>`;

  const communityToggle = (discoveryShowAllCommunities || hiddenCount > 0)
    ? `<div style="margin:8px 0 0"><button class="secondary" id="discovery-show-all">${
        discoveryShowAllCommunities
          ? 'Show active communities only'
          : `Show all ${sortedCommunities.length} communities (${hiddenCount} never reviewed hidden)`
      }</button></div>`
    : '';

  // Runs and candidates first -- they're what this tab exists to surface; the (large)
  // community rotation table is reference material below them.
  main.innerHTML = stats
    + `<div class="field-label">Discovery Runs</div>` + runsTable
    + `<div class="field-label">Candidates Produced${d.candidatesPath ? ` <span style="text-transform:none;letter-spacing:0">(${escapeHtml(d.candidatesPath)})</span>` : ''}</div>`
    + candidatesTable
    + `<div class="field-label">Communities (rotation order)</div>`
    + `<table><thead><tr><th>Community</th><th>Status</th><th>Last Reviewed</th><th>Candidates Last Run</th></tr></thead><tbody>${communityRows}</tbody></table>`
    + communityToggle;

  main.querySelectorAll('tr[data-task-id]').forEach(row => {
    row.onclick = () => openTaskAnywhere(row.dataset.taskId);
  });
  main.querySelectorAll('tr[data-candidate-id]').forEach(row => {
    row.onclick = () => openDiscoveryCandidate(parseInt(row.dataset.candidateId, 10));
  });
  const toggleBtn = document.getElementById('discovery-show-all');
  if (toggleBtn) toggleBtn.onclick = () => {
    discoveryShowAllCommunities = !discoveryShowAllCommunities;
    renderDiscoveryTab();
  };
}

function openDiscoveryCandidate(id) {
  const c = discoveryCandidatesCache.find(x => x.id === id);
  if (!c) return;
  const content = document.getElementById('modal-content');
  content.innerHTML = `<button class="close" onclick="closeDetail()">&times;</button>`
    + `<h2>AC-${String(c.id).padStart(3, '0')} · ${escapeHtmlBright(c.title)}</h2>`
    + `<pre>${escapeHtml(c.content)}</pre>`;
  document.getElementById('modal-backdrop').classList.add('open');
}

async function openJobLog(source) {
  const content = document.getElementById('modal-content');
  let data;
  try {
    data = await fetchJson(`/api/job-log/${encodeURIComponent(source)}`);
  } catch (e) {
    alert('Could not load job log: ' + e.message);
    return;
  }
  const stateBadge = (s) => {
    const cls = s === 'done' ? 'ok' : s === 'blocked' ? 'bad'
      : (s === 'needs-clarification' || s === 'awaiting-confirm') ? 'warn' : 'idle';
    return `<span class="badge ${cls}">${escapeHtml(s)}</span>`;
  };
  const rows = (data.runs || []).map((r) => `
    <tr class="clickable" data-task-id="${escapeAttr(r.id)}" title="Open this run's task log">
      <td>${escapeHtmlBright(r.title || r.id)}</td>
      <td>${stateBadge(r.state)}</td>
      <td>${r.at ? new Date(r.at).toLocaleString() : ''}</td>
      <td class="meta">${escapeHtml((r.outcome || '').slice(0, 140))}${(r.outcome || '').length > 140 ? '…' : ''}</td>
    </tr>`).join('');
  const body = (data.runs || []).length === 0
    ? `<div class="empty">No runs of <code>${escapeHtml(source)}</code> in the queue yet.</div>`
    : `<table><thead><tr><th>Run</th><th>State</th><th>When</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table>`;
  content.innerHTML = `<button class="close" onclick="closeDetail()">&times;</button>`
    + `<h2>Job Log · ${escapeHtml(source)}</h2>`
    + `<div class="meta" style="margin-bottom:10px">Showing ${(data.runs || []).length} of ${data.total} run(s), newest first.</div>`
    + body;
  document.getElementById('modal-backdrop').classList.add('open');
  content.querySelectorAll('tr[data-task-id]').forEach((row) => {
    row.onclick = () => openTaskAnywhere(row.dataset.taskId);
  });
}

// 2026-09-08, Grimmethy ("too many line breaks, just break between paragraphs headers and
// bullets"): a hand-authored concept description hard-wraps one logical paragraph across
// several source lines (~80-100 chars each) -- this used to treat every non-blank line as
// its own <p>, so a single paragraph rendered as a stack of tiny ones instead of flowing
// text. Standard markdown paragraph semantics instead: consecutive plain-text lines
// accumulate into ONE paragraph (joined with a space, not a break), and a paragraph only
// closes on a blank line, a header, or a list item. Machine-generated report content
// (system-report.js's renderMarkdown) already pushes one fact/sentence per array entry
// with no internal hard-wrapping, so this is a no-op there -- purely additive for the
// concept-description case this was actually reported against.
function renderReportMarkdown(md) {
  // Long-word brightness rule (core-ui.js's escapeHtmlBright/markLongWords/
  // unmarkToBrightSpans): mark BEFORE escaping so sentinels survive every other
  // transform in this function untouched, unmark as the LAST step below.
  const lines = escapeHtml(markLongWords(md)).split('\n');
  let html = '';
  let inList = false;
  let para = null;
  let li = null; // accumulates one list item's text, including hard-wrapped continuation lines
  const closeLi = () => { if (li !== null) { html += `<li>${li}</li>`; li = null; } };
  const closeList = () => { closeLi(); if (inList) { html += '</ul>'; inList = false; } };
  const closePara = () => { if (para !== null) { html += `<p>${para}</p>`; para = null; } };
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  for (const line of lines) {
    if (line.startsWith('## ')) { closePara(); closeList(); html += `<h3>${inline(line.slice(3))}</h3>`; }
    else if (line.startsWith('# ')) { closePara(); closeList(); html += `<h2>${inline(line.slice(2))}</h2>`; }
    else if (line.startsWith('- ')) { closePara(); closeLi(); if (!inList) { html += '<ul>'; inList = true; } li = inline(line.slice(2)); }
    else if (line.trim() === '') { closePara(); closeList(); }
    // A hard-wrapped continuation line of the CURRENT list item (e.g. a source line
    // starting with leading spaces right after a `- ` line) stays part of that bullet,
    // not a new paragraph -- same "only break between paragraphs, headers, and bullets"
    // rule this whole function exists to enforce.
    else if (inList && li !== null) { li = `${li} ${inline(line.trim())}`; }
    else { closeList(); para = para === null ? inline(line) : `${para} ${inline(line)}`; }
  }
  closePara();
  closeList();
  return unmarkToBrightSpans(html);
}

async function openReportDetail(period, filename) {
  const backdrop = document.getElementById('modal-backdrop');
  const content = document.getElementById('modal-content');
  let report;
  try {
    report = await fetchJson(`/api/reports/${encodeURIComponent(period)}/${encodeURIComponent(filename)}`);
  } catch (e) {
    content.innerHTML = `<button class="close" onclick="closeDetail()">&times;</button><div class="empty">Error loading report: ${escapeHtml(e.message)}</div>`;
    backdrop.classList.add('open');
    return;
  }
  content.innerHTML = `<button class="close" onclick="closeDetail()">&times;</button>${renderReportMarkdown(report.content)}`;
  backdrop.classList.add('open');
}

async function renderReportsTab() {
  const main = document.getElementById('main');
  try {
    reportsListCache = await fetchJson('/api/reports');
  } catch (e) {
    main.innerHTML = `<div class="empty">Error loading reports: ${escapeHtml(e.message)}</div>`;
    return;
  }

  const filterBar = `
    <div class="row" style="margin-bottom:12px">
      ${['all', 'hourly', 'daily', 'weekly'].map(p => `<button class="${reportsPeriodFilter === p ? 'active' : ''}" data-report-filter="${p}">${p[0].toUpperCase()}${p.slice(1)}</button>`).join('')}
    </div>`;

  const visible = reportsPeriodFilter === 'all' ? reportsListCache : reportsListCache.filter(r => r.period === reportsPeriodFilter);

  if (visible.length === 0) {
    main.innerHTML = filterBar + '<div class="empty">No reports generated yet -- the pipeline files an hourly report as soon as the first hour elapses since it started tracking.</div>';
  } else {
    const rows = visible.map(r => `
      <tr class="clickable" data-open-report-period="${escapeAttr(r.period)}" data-open-report-filename="${escapeAttr(r.filename)}">
        <td><span class="badge">${escapeHtml(r.period)}</span></td>
        <td>${escapeHtml(r.filename)}</td>
        <td>${fmtAge((Date.now() - new Date(r.generatedAt).getTime()) / 1000)} ago</td>
      </tr>`).join('');
    main.innerHTML = filterBar + `<table><thead><tr><th>Period</th><th>Report</th><th>Generated</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  main.querySelectorAll('[data-report-filter]').forEach((btn) => {
    btn.onclick = () => { reportsPeriodFilter = btn.dataset.reportFilter; renderReportsTab(); };
  });
  main.querySelectorAll('[data-open-report-period]').forEach((row) => {
    row.onclick = () => openReportDetail(row.dataset.openReportPeriod, row.dataset.openReportFilename);
  });
}

async function renderTokenfoldTab() {
  const main = document.getElementById('main');
  const data = await fetchJson('/api/tokenfold/stats');
  const openBtn = (port) => `<button onclick="window.open('http://' + location.hostname + ':${port}/tokenfold/dashboard', '_blank')">Open full TokenFold dashboard ↗</button>`;
  if (!data.available) {
    main.innerHTML = `<div class="empty">TokenFold proxy is not running on port ${escapeHtml(String(data.port))} -- it starts automatically with scripts/launch.sh when a tokenfold checkout is installed next to this repo (set AGENT_MANAGER_TOKENFOLD=false to turn that off).</div>`;
    return;
  }
  const s = data.stats || {};
  const modelRows = (s.by_model || []).map(m => `
    <tr><td>${escapeHtml(m.model || '')}</td><td>${(m.n ?? 0).toLocaleString()}</td>
    <td>${(m.saved ?? 0).toLocaleString()}</td><td>${m.avg_pct ?? 0}%</td></tr>`).join('');
  main.innerHTML = `
    <div class="row" style="margin-bottom:12px">${openBtn(escapeAttr(String(data.port)))}</div>
    <div style="font-size:2rem;font-weight:700">${(s.saved ?? 0).toLocaleString()} tokens saved${s.reduction_pct != null ? ` (${s.reduction_pct}%)` : ''}</div>
    <div class="meta" style="margin:6px 0 16px">${(s.n ?? 0).toLocaleString()} requests · original ${(s.orig ?? 0).toLocaleString()} → encoded ${(s.enc ?? 0).toLocaleString()} tokens${s.avg_latency != null ? ` · avg encode ${Number(s.avg_latency).toFixed(1)} ms` : ''}${s.fallback_pct != null ? ` · fallback rate ${Number(s.fallback_pct).toFixed(1)}%` : ''}</div>
    ${modelRows ? `<table><thead><tr><th>Model</th><th>Requests</th><th>Tokens saved</th><th>Avg %</th></tr></thead><tbody>${modelRows}</tbody></table>` : '<div class="empty">No model calls have gone through the proxy yet -- numbers appear as soon as the pipeline makes its first call.</div>'}`;
}

async function renderPromptForgeTab() {
  const main = document.getElementById('main');
  let url = 'http://' + location.hostname + ':7430/';
  try {
    const cfg = await fetchJson('/api/promptforge/config');
    if (cfg && cfg.url) url = cfg.url.replace('localhost', location.hostname);
  } catch (e) { /* fall back to the default host:7430 */ }
  const existing = main.querySelector('iframe.promptforge-frame');
  if (existing) {
    if (existing.getAttribute('src') !== url) existing.setAttribute('src', url);
    return;
  }
  main.innerHTML = `<iframe class="viz promptforge-frame" src="${escapeAttr(url)}" style="width:100%;height:calc(100vh - 120px);border:2px solid var(--border);border-radius:8px"></iframe>`;
}

async function renderAdForgeTab() {
  const main = document.getElementById('main');
  let url = 'http://' + location.hostname + ':7431/';
  try {
    const cfg = await fetchJson('/api/adforge/config');
    if (cfg && cfg.url) url = cfg.url.replace('localhost', location.hostname);
  } catch (e) { /* fall back to the default host:7431 */ }
  const existing = main.querySelector('iframe.adforge-frame');
  if (existing) {
    if (existing.getAttribute('src') !== url) existing.setAttribute('src', url);
    return;
  }
  main.innerHTML = `<iframe class="viz adforge-frame" src="${escapeAttr(url)}" style="width:100%;height:calc(100vh - 120px);border:2px solid var(--border);border-radius:8px"></iframe>`;
}

async function renderScriptForgeTab() {
  const main = document.getElementById('main');
  let url = 'http://' + location.hostname + ':7432/';
  try {
    const cfg = await fetchJson('/api/scriptforge/config');
    if (cfg && cfg.url) url = cfg.url.replace('localhost', location.hostname);
  } catch (e) { /* fall back to the default host:7432 */ }
  const existing = main.querySelector('iframe.scriptforge-frame');
  if (existing) {
    if (existing.getAttribute('src') !== url) existing.setAttribute('src', url);
    return;
  }
  main.innerHTML = `<iframe class="viz scriptforge-frame" src="${escapeAttr(url)}" style="width:100%;height:calc(100vh - 120px);border:2px solid var(--border);border-radius:8px"></iframe>`;
}
