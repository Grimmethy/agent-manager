async function renderAdhocTasksTab() {
  const main = document.getElementById('main');
  let tasks;
  try {
    const resp = await fetchJson('/api/adhoc-tasks');
    tasks = resp.tasks;
  } catch (e) {
    main.innerHTML = `<div class="empty">Error loading adhoc tasks: ${e.message}</div>`;
    return;
  }
  if (tasks.length === 0) {
    main.innerHTML = '<div class="empty">No adhoc tasks right now.</div>';
    return;
  }
  const rows = tasks.map(t => {
    const isAwaitingConfirm = t.state === 'awaiting-confirm';
    const rowClass = isAwaitingConfirm ? 'clickable adhoc-awaiting-confirm-row' : 'clickable';
    const badgeClass = adhocStateBadgeClass(t.state);
    const when = t.createdAt ? new Date(t.createdAt).toLocaleString() : '';
    const excerptHtml = t.excerpt ? `<div class="meta">${escapeHtml(t.excerpt)}</div>` : '';
    // dependsOn (2026-08-22): each entry's `satisfied` mirrors task-sources.js's own
    // isDependencySatisfied() -- merged, not just done -- so this reads the same
    // "actually unblocked" answer the claim logic itself uses, not a looser guess.
    const dependsHtml = (t.dependsOn && t.dependsOn.length)
      ? `<div class="meta" style="color:var(--warn)">⏳ depends on: ${t.dependsOn.map((d) => `${escapeHtml(d.id)}${d.satisfied ? ' (merged)' : ' (not yet merged)'}`).join(', ')}</div>`
      : '';
    return `<tr class="${rowClass}" data-id="${escapeAttr(t.id)}">
      <td>${escapeHtmlBright(t.title)}${excerptHtml}${dependsHtml}</td>
      <td><span class="badge ${badgeClass}">${escapeHtml(adhocStateLabel(t.state))}</span>${isAwaitingConfirm ? ' <strong>-- needs your review</strong>' : ''}</td>
      <td>${escapeHtml(when)}</td>
    </tr>`;
  }).join('');
  const footer = `<div class="meta" style="padding:10px 4px">Showing ${tasks.length} adhoc task${tasks.length === 1 ? '' : 's'}.</div>`;
  main.innerHTML = `<table><thead><tr><th>Title</th><th>State</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table>${footer}`;
  main.querySelectorAll('tr.clickable').forEach(row => {
    row.onclick = () => openTaskAnywhere(row.dataset.id);
  });
}

function renderConceptCard(concept) {
  const isStable = CONCEPT_STABLE_STATUSES.has(concept.status);
  const statusBadge = `<span class="badge ${isStable ? 'ok' : 'idle'}">${escapeHtml(concept.status || 'open')}</span>`;
  const researchChip = concept.researchForkCount > 0
    ? `<span title="Last researched ${concept.lastResearchedAt ? escapeAttr(new Date(concept.lastResearchedAt).toLocaleString()) : 'unknown'}" style="display:inline-block;margin-left:6px;padding:1px 5px;border:1px solid var(--muted);border-radius:3px;color:var(--muted);font-size:11px">🔬 researched ${concept.researchForkCount}×</span>`
    : '';
  const scratch = concept.builtFromScratchCount || 0;
  const adapted = concept.adaptedFromResourceCount || 0;
  const buildChip = (scratch + adapted) > 0
    ? `<span title="Self-reported by the implementing model when it finishes concept-tagged work -- NOT verified against real diffs, treat as a rough signal only" style="display:inline-block;margin-left:6px;padding:1px 5px;border:1px solid var(--warn);border-radius:3px;color:var(--warn);font-size:11px">🔨 ${scratch} scratch / 🔗 ${adapted} adapted (unverified)</span>`
    : '';
  // linkedTaskCount (2026-09-06): a deterministic backfill match (a done task's own
  // title/rawText literally named this concept) -- see src/concept-tally-backfill.js.
  // Kept visually distinct from buildChip above: this is a real, verified signal (an
  // exact phrase match), not a self-report, so it earns a plain accent tone instead of
  // the warn-colored "unverified" styling.
  const linkedChip = concept.linkedTaskCount > 0
    ? `<span title="Done tasks whose own title or text named this concept by name -- a deterministic match, not self-reported" style="display:inline-block;margin-left:6px;padding:1px 5px;border:1px solid var(--accent);border-radius:3px;color:var(--accent);font-size:11px">📎 ${concept.linkedTaskCount} linked task${concept.linkedTaskCount === 1 ? '' : 's'}</span>`
    : '';
  const shelveNote = concept.status === 'shelved'
    ? `<div class="row meta" style="margin-top:4px"><span>⏸ Shelved: ${escapeHtml(concept.shelvedReason || '')}${concept.revisitCondition ? ` — revisit when: ${escapeHtml(concept.revisitCondition)}` : ''}</span></div>`
    : '';
  const lifecycleButtons = isStable
    ? `<button class="secondary" data-reopen-concept="${escapeAttr(concept.id)}">Reopen</button>`
    : `<button class="secondary" data-shelve-concept="${escapeAttr(concept.id)}">Shelve</button>
       <button class="secondary" data-ship-concept="${escapeAttr(concept.id)}">Ship</button>`;
  // 2026-09-08, Grimmethy: "the concept entry isn't very readable, we need proper
  // paragraphs and line breaks in all concept entries" -- every concept's description now
  // renders through renderReportMarkdown() (analytics-and-discovery.js, already loaded on
  // this page for the unrelated Reports tab: #/## headers, - lists, **bold**, blank-line
  // paragraphs), not just kind:'reference' docs. A plain narrative description with no
  // markdown syntax at all just becomes normal wrapped <p> paragraphs -- strictly more
  // readable than the old single-line escaped <span> every concept used to get, never less.
  const descriptionHtml = `<div class="row meta" style="display:block">${renderReportMarkdown(concept.description || '')}</div>`;
  // Ghost-in-the-Machine's own audit surface (2026-09-09): hand-fixes (a person/agent
  // clicked Requeue) vs. mechanism recoveries (a watchdog sweep, no one in the loop),
  // plus the count of failure classes that currently have NO deterministic recovery
  // (Part B's ghost-debt register). Lazily hydrated in renderConceptsTab.
  const ghostPanel = concept.id === 'concept-ghost-in-the-machine-0dbeea'
    ? `<div class="ghost-telemetry meta" data-ghost-telemetry-for="${escapeAttr(concept.id)}" style="margin-top:6px">Loading requeue telemetry…</div>`
    : '';
  return `
    <div class="bd-entry" data-concept-id="${escapeAttr(concept.id)}">
      <div class="row">
        <span class="text"><strong>${escapeHtml(concept.name)}</strong>${researchChip}${buildChip}${linkedChip}</span>
        ${statusBadge}
      </div>
      ${descriptionHtml}
      ${ghostPanel}
      ${shelveNote}
      <div class="row" style="margin-top:8px">
        <span></span>
        <span>
          <button class="secondary" data-view-timeline="${escapeAttr(concept.id)}">View timeline</button>
          ${lifecycleButtons}
        </span>
      </div>
      <div class="concept-shelve-form" data-shelve-form-for="${escapeAttr(concept.id)}" hidden></div>
      <div class="concept-timeline" data-timeline-for="${escapeAttr(concept.id)}" hidden></div>
    </div>
  `;
}

function renderGhostSparkline(series) {
  const pts = (series || []).filter((d) => d && d.at);
  if (pts.length < 2) return '';
  const W = 160, H = 32, max = Math.max(1, ...pts.flatMap((d) => [d.handFixes || 0, d.mechanismRecoveries || 0]));
  const x = (i) => (i / (pts.length - 1)) * W;
  const y = (v) => H - (v / max) * H;
  const line = (key) => pts.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[key] || 0).toFixed(1)}`).join(' ');
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="vertical-align:middle;margin-left:8px" aria-hidden="true">
    <path d="${line('mechanismRecoveries')}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
    <path d="${line('handFixes')}" fill="none" stroke="var(--warn)" stroke-width="1.5"/>
  </svg>`;
}

function renderGhostTelemetry(t) {
  if (!t) return '<span style="color:var(--warn)">requeue telemetry unavailable</span>';
  const hand = t.handFixes || 0, mech = t.mechanismRecoveries || 0;
  const debt = t.openDebt || 0;
  const debtBit = debt > 0
    ? ` · <span style="color:var(--warn)" title="Failure classes with no deterministic recovery -- see the timeline below (ghost-debt findings)">🕳 ${debt} open ghost-debt</span>`
    : '';
  return `<span title="operator-manual + agent-session requeues"><span style="color:var(--warn)">🫥 ${hand}</span> hand-fix${hand === 1 ? '' : 'es'}</span>`
    + ` · <span title="watchdog-sweep requeues, no human in the loop"><span style="color:var(--accent)">⚙ ${mech}</span> mechanism recover${mech === 1 ? 'y' : 'ies'}</span>`
    + ` <span class="meta">(${escapeHtml(t.window || '30d')})</span>${debtBit}${renderGhostSparkline(t.series)}`;
}

function renderConceptTimelineRows({ rows, truncated }) {
  const truncatedNote = truncated
    ? '<div class="meta" style="color:var(--warn)">⚠ Task history scan hit its time budget -- older completed tasks may be missing from this list (research findings above are always complete).</div>'
    : '';
  if (!rows.length) return truncatedNote + '<div class="meta">No research findings or tasks tied to this concept yet.</div>';
  return truncatedNote + '<ul class="concept-timeline-list">' + rows.map((r) => {
    const when = r.at ? new Date(r.at).toLocaleString() : 'unknown time';
    const icon = r.kind === 'research-finding' ? '🔬' : '🛠';
    return `<li>${icon} <span class="meta">${escapeHtml(when)}</span> — ${escapeHtml(r.summary || r.ref)}</li>`;
  }).join('') + '</ul>';
}

async function renderConceptsTab() {
  const main = document.getElementById('main');
  let concepts;
  try {
    concepts = await fetchJson('/api/concepts');
  } catch (e) {
    main.innerHTML = `<div class="empty">Error loading concepts: ${e.message}</div>`;
    return;
  }
  const newConceptForm = `
    <div class="row" style="margin-bottom:12px">
      <input type="text" id="concept-new-name" placeholder="Concept name (e.g. dependency-ordering)" style="flex:1">
      <input type="text" id="concept-new-description" placeholder="Short description (optional)" style="flex:2">
      <button id="concept-new-submit">+ New Concept</button>
    </div>
  `;
  const list = concepts.length
    ? concepts.map(renderConceptCard).join('')
    : '<div class="empty">No concepts tracked yet -- add one above, or one will appear the first time a research fork runs on a new topic.</div>';
  main.innerHTML = newConceptForm + list;

  document.getElementById('concept-new-submit').onclick = async () => {
    const name = document.getElementById('concept-new-name').value.trim();
    const description = document.getElementById('concept-new-description').value.trim();
    if (!name) return;
    await fetch('/api/concepts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    });
    renderConceptsTab();
  };

  main.querySelectorAll('[data-ghost-telemetry-for]').forEach(async (el) => {
    try {
      const t = await fetchJson(`/api/concepts/${encodeURIComponent(el.dataset.ghostTelemetryFor)}/ghost-telemetry`);
      el.innerHTML = renderGhostTelemetry(t);
    } catch (e) {
      el.innerHTML = '<span style="color:var(--warn)">requeue telemetry unavailable</span>';
    }
  });

  main.querySelectorAll('[data-view-timeline]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.viewTimeline;
      const panel = main.querySelector(`[data-timeline-for="${CSS.escape(id)}"]`);
      if (!panel.hidden) { panel.hidden = true; return; }
      panel.innerHTML = '<div class="meta">Loading…</div>';
      panel.hidden = false;
      try {
        const rows = await fetchJson(`/api/concepts/${encodeURIComponent(id)}/timeline`);
        panel.innerHTML = renderConceptTimelineRows(rows);
      } catch (e) {
        panel.innerHTML = `<div class="empty">Error loading timeline: ${e.message}</div>`;
      }
    };
  });

  // Shelve/Reopen/Ship (2026-09-06): shelving needs a real reason (and an optional
  // revisit condition), so it opens an inline form -- same lightweight pattern as the
  // "+ New Concept" form above -- rather than a bare confirm(), since "why" is the whole
  // point of the field (see src/concepts.js's shelveConcept: it refuses without one).
  main.querySelectorAll('[data-shelve-concept]').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.shelveConcept;
      const form = main.querySelector(`[data-shelve-form-for="${CSS.escape(id)}"]`);
      if (!form.hidden) { form.hidden = true; return; }
      form.hidden = false;
      form.innerHTML = `
        <div class="row" style="margin-top:6px;gap:6px">
          <input type="text" placeholder="Why are you shelving this? (required)" class="concept-shelve-reason" style="flex:1">
          <input type="text" placeholder="Revisit when... (optional)" class="concept-shelve-revisit" style="flex:1">
          <button data-shelve-confirm="${escapeAttr(id)}">Confirm shelve</button>
        </div>
      `;
      form.querySelector('[data-shelve-confirm]').onclick = async () => {
        const reason = form.querySelector('.concept-shelve-reason').value.trim();
        if (!reason) return;
        const revisitCondition = form.querySelector('.concept-shelve-revisit').value.trim() || null;
        await fetch(`/api/concepts/${encodeURIComponent(id)}/shelve`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason, revisitCondition }),
        });
        renderConceptsTab();
      };
    };
  });
  main.querySelectorAll('[data-ship-concept]').forEach((btn) => {
    btn.onclick = async () => {
      await fetch(`/api/concepts/${encodeURIComponent(btn.dataset.shipConcept)}/ship`, { method: 'POST' });
      renderConceptsTab();
    };
  });
  main.querySelectorAll('[data-reopen-concept]').forEach((btn) => {
    btn.onclick = async () => {
      await fetch(`/api/concepts/${encodeURIComponent(btn.dataset.reopenConcept)}/reopen`, { method: 'POST' });
      renderConceptsTab();
    };
  });
}
