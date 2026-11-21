'use strict';

// Queue project filter (HUB0499). Renders a <select> into `container` with options:
// 'active' (default), one per project slug, then 'all' ("All Projects").
// Initial value precedence: URL ?project=, then `selected`, then 'active'.
// onChange is NOT called on initial render. No timers, polling or fetches.
function renderQueueProjectFilter(container, opts) {
  if (!container) return null;
  const o = opts || {};
  const onChange = o.onChange;

  const slugs = [];
  (Array.isArray(o.projects) ? o.projects : []).forEach(function (p) {
    const slug = typeof p === 'string' ? p : (p && p.slug);
    if (!slug || slug === 'active' || slug === 'all' || slugs.indexOf(slug) !== -1) return;
    slugs.push(slug);
  });

  const values = ['active'].concat(slugs, ['all']);

  const label = document.createElement('label');
  label.textContent = 'Project ';
  const select = document.createElement('select');
  select.id = 'queue-project-filter-select';
  select.setAttribute('aria-label', 'Project');

  values.forEach(function (v) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v === 'all' ? 'All Projects' : (v === 'active' ? 'Active' : v);
    select.appendChild(opt);
  });

  let initial = null;
  try {
    initial = new URLSearchParams(window.location.search).get('project');
  } catch (e) { initial = null; }
  if (!initial || values.indexOf(initial) === -1) initial = o.selected;
  if (!initial || values.indexOf(initial) === -1) initial = 'active';
  select.value = initial;

  select.addEventListener('change', function () {
    const value = select.value;
    const url = new URL(window.location.href);
    url.searchParams.set('project', value);
    history.replaceState(null, '', url);
    if (typeof onChange === 'function') onChange(value);
  });

  container.textContent = '';
  label.appendChild(select);
  container.appendChild(label);
  return select;
}

if (typeof module !== 'undefined') module.exports = { renderQueueProjectFilter };
