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
