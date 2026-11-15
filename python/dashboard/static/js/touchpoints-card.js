'use strict';

// Header chip: owner touchpoints per day (HUB0361 piece 4). It reads GET /api/stats/touchpoints-per-day ONCE when the page loads and again only when the event stream
// announces 'touchpoints-changed' (live-updates.js -> applyLivePlan -> refreshTouchpointsChip). No timer. Only operator-manual requeues are counted today; the response's
// notCountable list says why the other actions are not (docs/design-notes/owner-touchpoints.md).

// -> { text, title } for the chip, or null when there is nothing to show.
function touchpointsChipModel(data) {
  if (!data || !Array.isArray(data.days) || data.days.length === 0) return null;
  const today = data.days[data.days.length - 1].requeues || 0;
  const total = data.days.reduce((n, d) => n + (d.requeues || 0), 0);
  const gaps = Array.isArray(data.notCountable) ? data.notCountable.map((n) => `${n.action}: ${n.gap}`).join('\n') : '';
  return {
    text: `owner requeues today: ${today}`,
    title: `${total} operator requeues in the last ${data.days.length} days.\nNot countable yet:\n${gaps}`,
  };
}

async function refreshTouchpointsChip() {
  const el = typeof document !== 'undefined' ? document.getElementById('touchpoints-chip') : null;
  if (!el) return;
  try {
    const res = await fetch('/api/stats/touchpoints-per-day');
    const model = res.ok ? touchpointsChipModel(await res.json()) : null;
    el.hidden = !model;
    if (model) { el.textContent = model.text; el.title = model.title; }
  } catch (err) {
    el.hidden = true;
  }
}

if (typeof document !== 'undefined') refreshTouchpointsChip();
if (typeof module !== 'undefined') module.exports = { touchpointsChipModel, refreshTouchpointsChip };
