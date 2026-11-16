// Pure nav diff: navChanges(prev, next) returns the ops that turn the previous nav description into the next one.
// Nav description (fields taken from core-ui.js renderNavSections / renderTabButton inputs):
//   { activeKey, groups: { [groupKey]: { collapsed } }, tabs: [ { key, group, label, count, severity, indent } ] }
// count is counts[key]; text is String(count ?? ''); severity is severityForTab(key, count) or null.
// A change to label, group, or indent has no contract op, so it is treated as structural and emits a single rebuild.
// Plain global script (no require). module.exports is guarded so node:test can load it.

function navChanges(prev, next) {
  const p = prev || {};
  const n = next || {};
  const pTabs = p.tabs || [];
  const nTabs = n.tabs || [];
  const pKeys = pTabs.map((t) => t.key);
  const nKeys = nTabs.map((t) => t.key);
  const pSet = new Set(pKeys);
  const nSet = new Set(nKeys);
  const ops = [];
  const addRebuild = () => { if (!ops.some((o) => o.op === 'rebuild')) ops.push({ op: 'rebuild' }); };

  for (const k of nKeys) if (!pSet.has(k)) ops.push({ op: 'add', key: k });
  for (const k of pKeys) if (!nSet.has(k)) ops.push({ op: 'remove', key: k });

  // Relative order of keys present in both lists; a change here means rebuild.
  const pOrder = pKeys.filter((k) => nSet.has(k));
  const nOrder = nKeys.filter((k) => pSet.has(k));
  if (pOrder.join('\u0000') !== nOrder.join('\u0000')) addRebuild();

  const pMap = new Map(pTabs.map((t) => [t.key, t]));
  for (const t of nTabs) {
    const old = pMap.get(t.key);
    if (!old) continue;
    if (old.label !== t.label || old.group !== t.group || !!old.indent !== !!t.indent) {
      addRebuild();
      continue;
    }
    const oldText = String(old.count ?? '');
    const newText = String(t.count ?? '');
    const oldSev = old.severity ?? null;
    const newSev = t.severity ?? null;
    if (oldText !== newText || oldSev !== newSev) {
      ops.push({ op: 'setBadge', key: t.key, text: newText, severity: newSev });
    }
  }

  const pa = p.activeKey ?? null;
  const na = n.activeKey ?? null;
  if (pa !== na) {
    if (pa !== null) ops.push({ op: 'setActive', key: pa, active: false });
    if (na !== null) ops.push({ op: 'setActive', key: na, active: true });
  }

  const pg = p.groups || {};
  const ng = n.groups || {};
  const groupKeys = new Set([...Object.keys(pg), ...Object.keys(ng)]);
  for (const g of groupKeys) {
    const was = !!(pg[g] && pg[g].collapsed);
    const now = !!(ng[g] && ng[g].collapsed);
    if (was !== now) ops.push({ op: 'setCollapsed', group: g, collapsed: now });
  }

  return ops;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { navChanges };
