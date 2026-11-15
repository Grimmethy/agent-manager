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
      <td>${escapeHtmlBright(c.title)} <button class="secondary" data-discovery-send-to-chat="${c.id}" title="Send this candidate's title and write-up to the System Chat panel as a message -- no AI call, works even while the local model is busy">Send to Chat</button></td>
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

  // "Send to Chat": dumps this arch_discovery candidate's title + write-up into the
  // System Chat panel as a user message (via sendTextToChat -> POST /api/chat/inject,
  // no model call) so a follow-up can be had about it. Same pattern as
  // concepts-and-adhoc-tab.js's concept cards: wired here (not inlined in an onclick)
  // so the payload isn't quote-escaping trouble, and hard-capped at <=200 chars
  // before sendTextToChat.
  main.querySelectorAll('[data-discovery-send-to-chat]').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation(); // keep the row's own click (open the full write-up) from firing too
      btn.disabled = true;
      try {
        const candidate = discoveryCandidatesCache.find((x) => x.id === parseInt(btn.dataset.discoverySendToChat, 10));
        if (!candidate) { showToast('Could not send to chat: that candidate is no longer in the list.'); return; }
        const parts = [`AC-${String(candidate.id).padStart(3, '0')}: ${candidate.title}`];
        if (candidate.content) parts.push(candidate.content);
        let text = parts.join('\n\n');
        if (text.length > 200) text = text.slice(0, 199) + '…'; // hard cap: sendTextToChat must never receive >200 chars
        await sendTextToChat(text); // POSTs { text } to /api/chat/inject, no model call
        showToast('Sent to chat', 'info');
      } catch (err) {
        showToast('Could not send to chat: ' + err.message);
      } finally {
        btn.disabled = false;
      }
    };
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
