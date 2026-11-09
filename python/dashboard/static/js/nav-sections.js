'use strict';

// Sidebar sections: the ~45 nav tabs are grouped into a few collapsible sections (Work, Queue, Ideas, System, Forges, Knowledge, Business), the
// Forges section into sub-groups, with a small label per section and a hairline divider between them (owner request 2026-11-02, layout from the
// 'Sidebar UI' reel). This file is the pure part (no DOM, testable from Node): which tab goes in which section, which sections start open,
// and what a closed section summarises. core-ui.js renderNavSections() draws it. The phone layout draws the same sections (only the collapse button and the icon rail are wide-only).

const NAV_SECTIONS = [
  { key: 'work', label: 'Work', defaultOpen: true, items: ['branches', 'workers', 'adhoc', 'project'] },
  {
    key: 'queue', label: 'Queue',
    items: ['joblist', 'pending', 'drafting', 'review', 'approved', 'blocked', 'needs-clarification', 'awaiting-confirm', 'coordinating', 'done'],
    badgeKeys: ['pending', 'drafting', 'review', 'approved', 'blocked', 'needs-clarification', 'awaiting-confirm', 'coordinating'],
  },
  { key: 'ideas', label: 'Ideas', items: ['brain-dump', 'filed', 'concepts', 'discovery', 'deepdive', 'hygiene'], badgeKeys: ['brain-dump', 'filed'] },
  { key: 'system', label: 'System', items: ['hardware', 'models', 'plugins', 'gpu-broker', 'reports', 'tokenfold'] },
  {
    key: 'forges', label: 'Forges',
    subgroups: [
      { key: 'create', label: 'Create', items: ['promptforge', 'adforge', 'scriptforge', 'characterforge', 'postforge', 'cutforge', 'voiceforge', 'storyforge', 'videoforge', 'sceneforge', 'stageforge'] },
      { key: 'practice', label: 'Practice', items: ['sparforge', 'journalforge', 'kaggleforge'] },
      { key: 'other', label: 'Other', items: ['uiforge', 'annieforge', 'recipeforge', 'intakereel'], catchAllForGroup: 'Forges' },
    ],
  },
  { key: 'knowledge', label: 'Knowledge', items: ['secondbrain', 'agent-manager-wiki', 'wikiforge-wiki', 'propertyforager-wiki'] },
  { key: 'business', label: 'Business', items: ['books', 'fsbo-callsheet', 'inventory', 'trade-calculator', 'mailroom'] },
];

const NAV_MORE_SECTION = { key: 'more', label: 'More' };

// TABS holds plain tabs and {group, children} rows (plugin tabs bring their own group); this flattens it, remembering the group a tab came from.
function navFlattenTabs(tabs) {
  const out = [];
  for (const t of tabs || []) {
    if (t && t.group && Array.isArray(t.children)) for (const c of t.children) out.push({ tab: c, group: t.group });
    else if (t && t.key) out.push({ tab: t, group: null });
  }
  return out;
}

// -> [{key, label, defaultOpen, items: [tab], subgroups: [{key, label, items: [tab]}] | null}] in display order. Every tab appears exactly once;
// empty sections and sub-groups are left out. A plugin tab in the 'Forges' group that is not listed lands in Forges > Other, any other
// unlisted tab in a final 'More' section, so a newly added tab is never lost.
function buildNavSections(tabs) {
  const flat = navFlattenTabs(tabs);
  const byKey = new Map();
  for (const f of flat) if (!byKey.has(f.tab.key)) byKey.set(f.tab.key, f);
  const claimed = new Set();
  const take = (keys) => {
    const items = [];
    for (const k of keys || []) {
      if (byKey.has(k) && !claimed.has(k)) { claimed.add(k); items.push(byKey.get(k).tab); }
    }
    return items;
  };
  const sections = [];
  for (const def of NAV_SECTIONS) {
    if (def.subgroups) {
      const subgroups = def.subgroups.map((sg) => ({ key: sg.key, label: sg.label, items: take(sg.items), catchAllForGroup: sg.catchAllForGroup }));
      for (const sg of subgroups) {
        if (!sg.catchAllForGroup) continue;
        for (const f of flat) if (f.group === sg.catchAllForGroup && !claimed.has(f.tab.key)) { claimed.add(f.tab.key); sg.items.push(f.tab); }
      }
      const kept = subgroups.filter((sg) => sg.items.length).map(({ key, label, items }) => ({ key, label, items }));
      if (kept.length) sections.push({ key: def.key, label: def.label, defaultOpen: false, items: [], subgroups: kept });
    } else {
      const items = take(def.items);
      if (items.length) sections.push({ key: def.key, label: def.label, defaultOpen: !!def.defaultOpen, items, subgroups: null });
    }
  }
  const rest = flat.filter((f) => !claimed.has(f.tab.key) && byKey.get(f.tab.key) === f).map((f) => f.tab);
  if (rest.length) sections.push({ key: NAV_MORE_SECTION.key, label: NAV_MORE_SECTION.label, defaultOpen: false, items: rest, subgroups: null });
  return sections;
}

function navSectionTabs(section) {
  return section.subgroups ? section.subgroups.flatMap((sg) => sg.items) : section.items;
}

function navSectionContains(section, activeKey) {
  return navSectionTabs(section).some((t) => t.key === activeKey);
}

// stored is what localStorage holds for this section: 'expanded', 'collapsed' or nothing. A choice the user made always wins; otherwise a section
// is open when it starts open or holds the tab that is on screen.
function navSectionOpen({ stored, defaultOpen, containsActive }) {
  if (stored === 'expanded') return true;
  if (stored === 'collapsed') return false;
  return !!defaultOpen || !!containsActive;
}

// What a section header shows when closed: the sum of the counts that mean "work waiting" (only for sections that define badgeKeys) and the worst
// severity among its tabs ('bad' beats 'warn'). countOf(key) -> number|undefined, severityOf(key) -> 'bad'|'warn'|null.
function navSectionSummary(section, { countOf = () => undefined, severityOf = () => null } = {}) {
  const def = NAV_SECTIONS.find((s) => s.key === section.key);
  let badge = null;
  if (def && def.badgeKeys) {
    const sum = def.badgeKeys.reduce((n, k) => n + (typeof countOf(k) === 'number' ? countOf(k) : 0), 0);
    badge = sum > 0 ? sum : null;
  }
  let severity = null;
  for (const t of navSectionTabs(section)) {
    const s = severityOf(t.key);
    if (s === 'bad') { severity = 'bad'; break; }
    if (s === 'warn') severity = 'warn';
  }
  return { badge, severity };
}

// --- Icon rail (the collapsed sidebar) ---
const NAV_RAIL_KEY = 'agentManagerNavRail';   // localStorage: 'collapsed' or nothing

// The one-character stand-in for a tab in the rail: an explicit tab.icon when a tab has one (the line-icon set will provide it), else the emoji its
// label starts with, else the first letter of the label.
function navTabGlyph(tab) {
  if (tab && tab.icon) return String(tab.icon);
  const label = String((tab && tab.label) || (tab && tab.key) || '').trim();
  const m = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)/u.exec(label);
  if (m) return m[1];
  return label ? Array.from(label)[0].toUpperCase() : '?';
}

// The label without a leading emoji, for tooltips and screen readers.
function navTabPlainLabel(tab) {
  const label = String((tab && tab.label) || (tab && tab.key) || '').trim();
  return label.replace(/^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s*/u, '') || label;
}

// What the rail draws, in order: for every section a divider (except before the first), then its tabs as icons when the section is open,
// or one section button when it is folded (clicking that opens the section and widens the sidebar). openOf(section) -> boolean.
function navRailEntries(sections, openOf) {
  const out = [];
  sections.forEach((section, i) => {
    if (i > 0) out.push({ type: 'divider' });
    if (openOf(section)) for (const tab of navSectionTabs(section)) out.push({ type: 'tab', tab, section });
    else out.push({ type: 'section', section });
  });
  return out;
}

if (typeof module !== 'undefined') module.exports = { NAV_RAIL_KEY, navTabGlyph, navTabPlainLabel, navRailEntries, NAV_SECTIONS, NAV_MORE_SECTION, navFlattenTabs, buildNavSections, navSectionTabs, navSectionContains, navSectionOpen, navSectionSummary };
