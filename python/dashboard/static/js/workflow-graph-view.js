// Workers tab, Graph view (HUB0323 piece W-A4b): a read-only picture of GET /api/workflow-graph behind a Cards | Graph toggle.
// A plain global <script> loaded by index.html after worker-switch-ui.js, worker-status-helpers.js and workflow-layout.js, and before the inline script.
// The builders are pure string functions (no DOM) so `node --test` can load them in a bare vm context; the DOM wiring at the bottom is small.
// Uses these globals from the other scripts: fmtAge, statusBadgeClass, statusLabel (worker-status-helpers.js), buildWorkerSwitchHtml and
// wireWorkerSwitchButtons (worker-switch-ui.js), layoutGraph (workflow-layout.js), splitIntoLoops, fitScale and WF_MIN_SCALE (workflow-loops.js), loadOffsets, saveOffset, clearOffsets, applyOffsets, edgeBetween, moveBy and movedPastThreshold (workflow-drag.js), renderRunLogList and renderWorkers (workers-tab.js), fetchJson and
// renderStaleCheck (core-ui.js).

function wfEsc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---- Cards | Graph toggle ----

function workersViewMode(storage) {
  let store = storage;
  if (store === undefined) {
    try { store = typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { store = null; }
  }
  try { return store && store.getItem('workersView') === 'graph' ? 'graph' : 'cards'; } catch (e) { return 'cards'; }
}

function setWorkersView(mode, storage) {
  let store = storage;
  if (store === undefined) {
    try { store = typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { store = null; }
  }
  try { if (store) store.setItem('workersView', mode === 'graph' ? 'graph' : 'cards'); } catch (e) { /* storage unavailable: the view just is not remembered */ }
}

function workersViewToggleHtml(active) {
  const btn = (view, label) => '<button type="button" class="secondary wf-view-btn' + (active === view ? ' active' : '') + '" data-view="' + view + '"'
    + (active === view ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' + label + '</button>';
  return '<div class="wf-toggle" role="group" aria-label="Workers view">' + btn('cards', 'Cards') + btn('graph', 'Graph') + '</div>';
}

function wireWorkersViewToggle(root) {
  root.querySelectorAll('.wf-view-btn').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      setWorkersView(btn.dataset.view);
      renderWorkers();
    };
  });
}

// ---- pure builders ----

const WF_PROVIDERS = ['local', 'cloud', 'script'];
// Node box and gaps handed to layoutGraph and used for the card size, so the layout and the cards always agree (multiples of 4). Tall enough for the badge column and the model line.
const WF_LAYOUT_OPTS = { nodeW: 272, nodeH: 128, gapX: 64, gapY: 16 };

function wfStatusBadge(runtime) {
  if (!runtime) return '';
  const label = runtime.stale ? 'STALE' : statusLabel(runtime.status);
  return '<span class="badge ' + wfEsc(statusBadgeClass(runtime.status, runtime.stale)) + '">' + wfEsc(label) + '</span>';
}

function wfCountsHtml(counts) {
  if (!counts) return '';
  return '<span class="wf-counts">pending ' + wfEsc(counts.pending) + ' · drafting ' + wfEsc(counts.drafting) + '</span>';
}

function wfModelHtml(model) {
  if (!model) return '';
  const provider = WF_PROVIDERS.includes(model.provider) ? model.provider : 'local';
  return '<span class="wf-model">' + wfEsc(model.name || '-') + '</span> <span class="chip wf-provider wf-provider-' + provider + '">' + provider + '</span>';
}

// One graph node as a card. pos = {x, y} and size = {w, h} place it inside the canvas; both optional.
function buildNodeHtml(node, selected, pos, size) {
  const n = node || {};
  const runtime = n.runtime || null;
  const off = runtime && runtime.switchable === true && runtime.disabled ? ' worker-off' : '';
  const place = pos ? ' style="left:' + wfEsc(pos.x) + 'px;top:' + wfEsc(pos.y) + 'px;width:' + wfEsc(size ? size.w : WF_LAYOUT_OPTS.nodeW) + 'px;height:' + wfEsc(size ? size.h : WF_LAYOUT_OPTS.nodeH) + 'px"' : '';
  const timer = runtime && runtime.stateAgeSeconds != null ? '<span class="state-timer">in this state ' + wfEsc(fmtAge(runtime.stateAgeSeconds)) + '</span>' : '';
  const sw = runtime ? buildWorkerSwitchHtml(runtime) : ''; // '' unless runtime.switchable === true
  const meta = [];
  if (n.kind && n.kind !== 'loop') meta.push('<span class="wf-kind">' + wfEsc(n.kind) + '</span>');
  if (n.kind === 'group') meta.push('<span class="wf-members">' + wfEsc(n.memberCount) + ' member(s)</span>');
  if (n.model) meta.push(wfModelHtml(n.model));
  if (n.counts) meta.push(wfCountsHtml(n.counts));
  const task = runtime && runtime.currentTaskId ? '<div class="meta wf-task">' + wfEsc(runtime.currentTaskId) + (runtime.currentPass ? ' · ' + wfEsc(runtime.currentPass) : '') + '</div>' : '';
  return '<div class="worker-card clickable wf-node' + (n.kind === 'group' ? ' wf-group-node' : '') + (selected ? ' wf-selected' : '') + off + '" data-node-id="' + wfEsc(n.id) + '"' + (n.kind === 'group' ? ' data-group="1"' : '') + place + '>'
    + '<div class="row"><span class="id">' + wfEsc(n.label || n.id) + '</span>'
    + '<span class="badge-col"><span class="wf-status-line">' + wfStatusBadge(runtime) + timer + '</span>' + sw + '</span></div>'
    + '<div class="meta">' + (meta.join(' · ') || '&nbsp;') + '</div>' + task + '</div>';
}

function wfPathData(points) {
  return (points || []).map((p, i) => (i === 0 ? 'M' : 'L') + wfEsc(p.x) + ' ' + wfEsc(p.y)).join(' ');
}

// One edge as an SVG path; a back edge (edge.back) is dashed.
function buildEdgeSvg(edge, points) {
  const e = edge || {};
  return '<path class="wf-edge wf-edge-' + wfEsc(e.kind || 'edge') + (e.back ? ' wf-edge-back' : '') + '" data-edge-id="' + wfEsc(e.id) + '" d="' + wfPathData(points) + '"'
    + (e.back ? ' stroke-dasharray="6 4"' : '') + ' fill="none" marker-end="url(#wf-arrow)"/>';
}

function wfRow(label, value) {
  return '<dt>' + wfEsc(label) + '</dt><dd>' + wfEsc(value === undefined || value === null || value === '' ? '-' : value) + '</dd>';
}

// Side panel for the selected node: the facts, with optional extra controls (extraHtml, from workflow-node-panel.js) under the title. warnings = the graph's warnings array.
function buildDetailHtml(node, warnings, extraHtml) {
  if (!node) return '';
  const rows = [wfRow('Node', node.id), wfRow('Kind', node.kind)];
  const rt = node.runtime;
  if (rt) {
    rows.push(wfRow('Status', rt.stale ? rt.status + ' (stale)' : rt.status), wfRow('PID', rt.pid), wfRow('Task', rt.currentTaskId), wfRow('Pass', rt.currentPass),
      wfRow('In this state', rt.stateAgeSeconds != null ? fmtAge(rt.stateAgeSeconds) : null), wfRow('Project', rt.projectLabel), wfRow('Borrowed', rt.borrowed ? 'yes' : 'no'));
  }
  if (node.model) {
    const m = node.model;
    rows.push(wfRow('Model', m.name), wfRow('Provider', m.provider), wfRow('Tier B', m.tierB), wfRow('Override', m.overridden ? 'yes' : 'no'),
      wfRow('Local choices', (m.choices && m.choices.local || []).join(', ')), wfRow('Cloud choices', (m.choices && m.choices.cloud || []).join(', ')));
  }
  if (node.work) {
    rows.push(wfRow('Task classes', node.work.taskClasses ? node.work.taskClasses.join(', ') : 'any'), wfRow('Preempt', node.work.preempt), wfRow('Reviewer', node.work.reviewer ? 'yes' : 'no'));
  }
  if (node.counts) rows.push(wfRow('Pending', node.counts.pending), wfRow('Drafting', node.counts.drafting));
  const warn = (warnings || []).length ? '<ul class="wf-warnings">' + warnings.map((w) => '<li>' + wfEsc(w) + '</li>').join('') + '</ul>' : '';
  return '<div class="wf-detail" id="wf-detail"><div class="row"><span class="id">' + wfEsc(node.label || node.id) + '</span></div>' + (extraHtml || '')
    + '<dl class="wf-facts">' + rows.join('') + '</dl>' + warn
    + (rt && node.kind === 'loop' ? '<div class="meta">Recent runs</div><div id="wf-runlog" class="wf-runlog"></div>' : '') + '</div>';
}

// The whole surface: toggle bar, one scroll box holding the edge layer under the absolutely positioned node cards, then the detail panel.
// state = { selectedId }. layout = the result of layoutGraph(graph).
function buildGraphHtml(graph, layout, state) {
  const g = graph || { nodes: [], edges: [], warnings: [] };
  const lay = layout || { positions: {}, width: 0, height: 0, edges: [] };
  const selectedId = state && state.selectedId;
  const byEdge = {};
  (lay.edges || []).forEach((le) => { byEdge[le.id] = le; });
  // Expanded groups get a dashed box under everything; a box can start left of or above the layout, so the whole canvas is shifted by that amount (0 without groups).
  const boxes = typeof groupBoxes === 'function' ? groupBoxes(g, lay.positions, { w: WF_LAYOUT_OPTS.nodeW, h: WF_LAYOUT_OPTS.nodeH }, 12) : [];
  const dx = Math.max(0, ...boxes.map((b) => -b.x));
  const dy = Math.max(0, ...boxes.map((b) => -b.y));
  const width = Math.max(lay.width + dx, ...boxes.map((b) => b.x + dx + b.w));
  const height = Math.max(lay.height + dy, ...boxes.map((b) => b.y + dy + b.h));
  const shift = (pts) => (dx || dy ? (pts || []).map((p) => ({ x: p.x + dx, y: p.y + dy })) : pts);
  const boxHtml = boxes.map((b) => '<div class="wf-group-box" data-group-id="' + wfEsc(b.id) + '" style="left:' + wfEsc(b.x + dx) + 'px;top:' + wfEsc(b.y + dy) + 'px;width:' + wfEsc(b.w) + 'px;height:' + wfEsc(b.h) + 'px">'
    + '<button type="button" class="secondary wf-group-toggle" data-group-id="' + wfEsc(b.id) + '" aria-expanded="true" title="Collapse this group">▾ ' + wfEsc(b.label) + '</button></div>').join('');
  const paths = (g.edges || []).filter((e) => byEdge[e.id]).map((e) => buildEdgeSvg({ id: e.id, kind: e.kind, back: byEdge[e.id].back }, shift(byEdge[e.id].points))).join('');
  const nodes = (g.nodes || []).filter((n) => lay.positions[n.id]).map((n) => buildNodeHtml(n, n.id === selectedId, dx || dy ? { x: lay.positions[n.id].x + dx, y: lay.positions[n.id].y + dy } : lay.positions[n.id])).join('');
  const selected = (g.nodes || []).find((n) => n.id === selectedId);
  const warn = (g.warnings || []).length ? '<div class="meta wf-warn-line" title="' + wfEsc(g.warnings.join('\n')) + '">' + wfEsc(g.warnings.length) + ' warning(s) while building this graph: hover for details</div>' : '';
  return '<div class="worker-filter-bar wf-bar">' + workersViewToggleHtml('graph') + '</div>' + warn
    + '<div class="wf-surface" id="wf-surface"><div class="wf-canvas" style="width:' + wfEsc(width) + 'px;height:' + wfEsc(height) + 'px">' + boxHtml
    + '<svg class="wf-edges" width="' + wfEsc(width) + '" height="' + wfEsc(height) + '" aria-hidden="true"><defs><marker id="wf-arrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="8" markerHeight="8" orient="auto">'
    + '<path d="M0 0 L8 4 L0 8 z" class="wf-arrowhead"/></marker></defs>' + paths + '</svg>' + nodes + '</div></div>'
    + (selected ? ((typeof buildNodePanelHtml === 'function' && buildNodePanelHtml(selected, g.warnings, state && state.tasks, g.priorityOrder, g.priorityCompare, g.groups)) || buildDetailHtml(selected, g.warnings)) : '');
}

// ---- one card per loop (HUB0346 piece 2) ----
// Each loop (see splitIntoLoops in workflow-loops.js) is its own full-height card laid out top to bottom; the cards sit in one horizontal scroll-snap row,
// so on a phone one swipe moves to the next loop. The row keeps the id wf-surface, which the poll and the scroll restore already use.
const WF_CARD_OPTS = Object.assign({}, WF_LAYOUT_OPTS, { direction: 'down' });
const WF_MAX_COLS = 4;

// How many nodes fit side by side on a card at this screen width (1 on a phone, up to WF_MAX_COLS on a desktop); a layer with more nodes wraps into rows.
function wfMaxPerRow() {
  const w = typeof window !== 'undefined' && window && Number.isFinite(window.innerWidth) ? window.innerWidth : 0;
  if (!w) return WF_MAX_COLS;
  return Math.max(1, Math.min(WF_MAX_COLS, Math.floor((w - 48) / (WF_LAYOUT_OPTS.nodeW + WF_LAYOUT_OPTS.gapX))));
}

// The storage the dragged positions live in: state.storage when one is injected (tests), else localStorage, else null (nothing is remembered).
function wfStore(state) {
  if (state && state.storage !== undefined) return state.storage;
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
}

// One card: a head with the loop name and "n of m", and a body holding the loop drawn as a canvas. The canvas is scaled to fit by wfFitCards (DOM) after it is in the page.
// Every card repeats the same arrow marker definition (same id, same shape), so the shared id is harmless.
function buildCardHtml(loop, index, total, state) {
  const g = (loop && loop.graph) || { nodes: [], edges: [], groups: [] };
  const lay = layoutGraph(g, Object.assign({}, WF_CARD_OPTS, { maxPerRow: state && state.maxPerRow ? state.maxPerRow : wfMaxPerRow() }));
  const selectedId = state && state.selectedId;
  const nodeSize = { w: WF_LAYOUT_OPTS.nodeW, h: WF_LAYOUT_OPTS.nodeH };
  // Where the owner left nodes by hand (workflow-drag.js) wins over the layout; an id that is no longer on this card is ignored.
  const saved = typeof loadOffsets === 'function' ? loadOffsets(wfStore(state), loop && loop.id) : {};
  const pos = typeof applyOffsets === 'function' ? applyOffsets(lay.positions, saved, (g.nodes || []).map((n) => n.id)) : lay.positions;
  const moved = (id) => pos[id] !== lay.positions[id];
  const byEdge = {};
  (lay.edges || []).forEach((le) => { byEdge[le.id] = le; });
  const boxes = typeof groupBoxes === 'function' ? groupBoxes(g, lay.positions, nodeSize, 12, 'down') : [];
  const dx = Math.max(0, ...boxes.map((b) => -b.x));
  const dy = Math.max(0, ...boxes.map((b) => -b.y));
  const movedIds = Object.keys(pos).filter(moved);
  const width = Math.max(lay.width + dx, ...boxes.map((b) => b.x + dx + b.w), ...movedIds.map((id) => pos[id].x + dx + nodeSize.w));
  const height = Math.max(lay.height + dy, ...boxes.map((b) => b.y + dy + b.h), ...movedIds.map((id) => pos[id].y + dy + nodeSize.h));
  const shift = (pts) => (dx || dy ? (pts || []).map((pt) => ({ x: pt.x + dx, y: pt.y + dy })) : pts);
  const boxHtml = boxes.map((b) => '<div class="wf-group-box" data-group-id="' + wfEsc(b.id) + '" style="left:' + wfEsc(b.x + dx) + 'px;top:' + wfEsc(b.y + dy) + 'px;width:' + wfEsc(b.w) + 'px;height:' + wfEsc(b.h) + 'px">'
    + '<button type="button" class="secondary wf-group-toggle" data-group-id="' + wfEsc(b.id) + '" aria-expanded="true" title="Collapse this group">▾ ' + wfEsc(b.label) + '</button></div>').join('');
  // An edge with a hand-moved end is a straight line between the two cards as they now sit; the others keep the layout's route.
  const edgePts = (e) => (moved(e.from) || moved(e.to) ? edgeBetween(pos[e.from], pos[e.to], nodeSize) : byEdge[e.id].points);
  const paths = (g.edges || []).filter((e) => byEdge[e.id]).map((e) => buildEdgeSvg({ id: e.id, kind: e.kind, back: byEdge[e.id].back }, shift(edgePts(e)))).join('');
  const nodes = (g.nodes || []).filter((n) => pos[n.id]).map((n) => buildNodeHtml(n, n.id === selectedId, { x: pos[n.id].x + dx, y: pos[n.id].y + dy })).join('');
  return '<section class="wf-card" data-loop-id="' + wfEsc(loop && loop.id) + '">'
    + '<header class="wf-card-head"><span class="id">' + wfEsc(loop && loop.label) + '</span><span class="meta wf-card-count">' + wfEsc(index + 1) + ' of ' + wfEsc(total) + '</span></header>'
    + '<div class="wf-card-body"><div class="wf-scale"><div class="wf-canvas" data-w="' + wfEsc(width) + '" data-h="' + wfEsc(height) + '" style="width:' + wfEsc(width) + 'px;height:' + wfEsc(height) + 'px">' + boxHtml
    + '<svg class="wf-edges" width="' + wfEsc(width) + '" height="' + wfEsc(height) + '" aria-hidden="true"><defs><marker id="wf-arrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="8" markerHeight="8" orient="auto">'
    + '<path d="M0 0 L8 4 L0 8 z" class="wf-arrowhead"/></marker></defs>' + paths + '</svg>' + nodes + '</div></div></div></section>';
}

// The whole Graph view as a row of loop cards: toggle bar, warning line, the swipe row, then the detail panel of the selected node. state = { selectedId, tasks }.
function buildCardsHtml(graph, state) {
  const g = graph || { nodes: [], edges: [], warnings: [] };
  const loops = typeof splitIntoLoops === 'function' ? splitIntoLoops(g) : [];
  const selected = (g.nodes || []).find((n) => n.id === (state && state.selectedId));
  const warn = (g.warnings || []).length ? '<div class="meta wf-warn-line" title="' + wfEsc(g.warnings.join('\n')) + '">' + wfEsc(g.warnings.length) + ' warning(s) while building this graph: hover for details</div>' : '';
  return '<div class="worker-filter-bar wf-bar">' + workersViewToggleHtml('graph')
    + ' <button type="button" class="secondary wf-reset-btn" title="Put every node back where the layout placed it">Reset layout</button></div>' + warn
    + '<div class="wf-cards" id="wf-surface">' + loops.map((l, i) => buildCardHtml(l, i, loops.length, state)).join('') + '</div>'
    + (selected ? ((typeof buildNodePanelHtml === 'function' && buildNodePanelHtml(selected, g.warnings, state && state.tasks, g.priorityOrder, g.priorityCompare, g.groups)) || buildDetailHtml(selected, g.warnings)) : '');
}

// What the poll compares: ids and the values the cards show. stateAgeSeconds is left out on purpose, it changes every poll.
function graphSignature(graph) {
  const nodes = (graph && graph.nodes) || [];
  return JSON.stringify([nodes.map((n) => {
    const r = n.runtime || {};
    const c = n.counts || {};
    return [n.id, r.status, r.stale, r.disabled, r.currentTaskId, r.currentPass, c.pending, c.drafting, n.model && n.model.name, n.model && n.model.overridden];
  }), ((graph && graph.edges) || []).map((e) => e.id), (graph && graph.warnings) || [], ((graph && graph.groups) || []).map((g) => [g.id, g.label, g.children, g.collapsed])]);
}

// A poll redraws only when a visible value changed or nothing is drawn yet (the stored signature starts as null, which never equals a real one); a selected node and the scroll position are left alone otherwise.
function graphNeedsRedraw(previousSignature, nextSignature) {
  return previousSignature !== nextSignature;
}

// ---- DOM wiring ----

// tasks = { id, items, type, error } of the selected worker node's task picker; it lives here, like the selection, so it survives the 5 s poll.
// toggles = { <group id>: true|false }: the operator's collapsed or expanded choice per group (it wins over the group's own flag); shown = the graph as drawn (groups collapsed), which is where the selection is looked up.
const wfState = { selectedId: null, signature: null, graph: null, tasks: null, toggles: {}, shown: null, dragging: false, cols: 0 };

function wfMessageHtml(text) {
  return '<div class="worker-filter-bar wf-bar">' + workersViewToggleHtml('graph') + '</div><div class="empty">' + wfEsc(text)
    + '</div><div style="text-align:center"><button type="button" class="secondary wf-view-btn" data-view="cards">Back to Cards</button></div>';
}

function wfSelectedNode() {
  const g = wfState.shown || wfState.graph;
  return (g && g.nodes || []).find((n) => n.id === wfState.selectedId) || null;
}

// Redraw only the task-pick slot (a chosen type, or a fresh task list), then wire its selects again.
function wfRedrawTaskSlot(main) {
  const slot = main.querySelector('#wf-taskpick');
  const node = wfSelectedNode();
  if (!slot || !node) return;
  slot.innerHTML = buildTaskPickSlotHtml(node, wfState.tasks && wfState.tasks.id === node.id ? wfState.tasks : null);
  wireNodePanel(main, {});
}

function wfSetTaskType(instanceId, type) {
  if (wfState.tasks && wfState.tasks.id === instanceId) wfState.tasks.type = type;
  if (typeof document !== 'undefined') wfRedrawTaskSlot(document.getElementById('main'));
}

// Fetch the selected worker node's assignable tasks (fail soft) and redraw the slot when they changed; the type already chosen is kept.
async function wfLoadTasks(main) {
  const node = wfSelectedNode();
  if (!node || !isTaskPinNode(node)) { wfState.tasks = null; return; }
  const id = node.id;
  let next;
  try {
    const r = await fetchJson('/api/instances/' + encodeURIComponent(id) + '/assignable-tasks');
    next = { items: (r && r.items) || [], error: false };
  } catch (e) {
    next = { items: null, error: true };
  }
  if (wfState.selectedId !== id) return;
  const cur = wfState.tasks && wfState.tasks.id === id ? wfState.tasks : null;
  const changed = !cur || cur.error !== next.error || JSON.stringify(cur.items) !== JSON.stringify(next.items);
  wfState.tasks = { id, type: cur ? cur.type : '', items: next.items, error: next.error };
  if (changed) wfRedrawTaskSlot(main);
}

// Flip a group between collapsed and expanded (the operator's choice, kept in the view state) and redraw.
function wfToggleGroup(groupId, main) {
  wfState.toggles[groupId] = !effectiveCollapsed(wfState.graph, wfState.toggles).has(groupId);
  wfDraw(main);
}

// Scale every card's canvas to fit its body (never above 1, never below WF_MIN_SCALE; below that the body scrolls). The wrapper takes the scaled size so the scroll area matches what is drawn.
function wfFitCards(main) {
  main.querySelectorAll('.wf-card').forEach((card) => {
    const body = card.querySelector('.wf-card-body');
    const wrap = card.querySelector('.wf-scale');
    const canvas = card.querySelector('.wf-canvas');
    if (!body || !wrap || !canvas) return;
    const w = Number(canvas.dataset.w);
    const h = Number(canvas.dataset.h);
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(body) : null;
    const pad = (a, b) => (cs ? (parseFloat(cs[a]) || 0) + (parseFloat(cs[b]) || 0) : 0);
    const s = fitScale(w, h, body.clientWidth - pad('paddingLeft', 'paddingRight'), body.clientHeight - pad('paddingTop', 'paddingBottom'), WF_MIN_SCALE);
    canvas.style.transformOrigin = '0 0';
    canvas.style.transform = s < 1 ? 'scale(' + s + ')' : '';
    wrap.style.width = Math.ceil(w * s) + 'px';
    wrap.style.height = Math.ceil(h * s) + 'px';
    card.dataset.scale = String(s);
  });
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('resize', () => {
    const main = typeof document !== 'undefined' ? document.getElementById('main') : null;
    if (!main || !main.querySelector('.wf-card')) return;
    if (wfMaxPerRow() !== wfState.cols && !wfState.dragging) wfDraw(main); // the screen crossed a column breakpoint (phone turned, window resized): lay the cards out again
    else wfFitCards(main);
  });
}

// Pointer-event dragging of the nodes of every card (approach of Drawflow, see workflow-drag.js). A press that never moves past the threshold stays a click and selects the node;
// buttons, selects and inputs inside a node keep working. While a node moves only the edges of that node are re-pointed (no redraw), the end saves the position, and the 5 s poll waits.
function wfWireDrag(main) {
  if (typeof movedPastThreshold !== 'function' || typeof splitIntoLoops !== 'function') return;
  const loopsById = {};
  splitIntoLoops(wfState.shown || wfState.graph).forEach((l) => { loopsById[l.id] = l; });
  const size = { w: WF_LAYOUT_OPTS.nodeW, h: WF_LAYOUT_OPTS.nodeH };
  main.querySelectorAll('.wf-card').forEach((card) => {
    const loop = loopsById[card.dataset.loopId];
    if (!loop) return;
    const els = {};
    card.querySelectorAll('.wf-node').forEach((e) => { els[e.dataset.nodeId] = e; });
    const paths = {};
    card.querySelectorAll('.wf-edge').forEach((e) => { paths[e.dataset.edgeId] = e; });
    const redrawEdges = (nodeId) => {
      (loop.graph.edges || []).forEach((e) => {
        if (e.from !== nodeId && e.to !== nodeId) return;
        const a = els[e.from];
        const b = els[e.to];
        const path = paths[e.id];
        if (a && b && path) path.setAttribute('d', wfPathData(edgeBetween({ x: a.offsetLeft, y: a.offsetTop }, { x: b.offsetLeft, y: b.offsetTop }, size)));
      });
    };
    Object.keys(els).forEach((id) => {
      const el = els[id];
      el.addEventListener('pointerdown', (ev) => {
        if (ev.button > 0 || (ev.target && ev.target.closest && ev.target.closest('button, select, input, a'))) return;
        delete el.dataset.justDragged;
        const scale = Number(card.dataset.scale) || 1;
        const start = { px: ev.clientX, py: ev.clientY, x: el.offsetLeft, y: el.offsetTop };
        let dragging = false;
        let last = { x: start.x, y: start.y };
        try { el.setPointerCapture(ev.pointerId); } catch (e) { /* a synthetic event has no active pointer to capture */ }
        const onMove = (e) => {
          const dx = e.clientX - start.px;
          const dy = e.clientY - start.py;
          if (!dragging) {
            if (!movedPastThreshold(dx, dy)) return;
            dragging = true;
            wfState.dragging = true;
            el.classList.add('wf-dragging');
          }
          last = moveBy({ x: start.x, y: start.y }, dx, dy, scale);
          el.style.left = last.x + 'px';
          el.style.top = last.y + 'px';
          redrawEdges(id);
        };
        const onEnd = () => {
          el.removeEventListener('pointermove', onMove);
          el.removeEventListener('pointerup', onEnd);
          el.removeEventListener('pointercancel', onEnd);
          try { el.releasePointerCapture(ev.pointerId); } catch (e) { /* already released */ }
          if (!dragging) return;
          wfState.dragging = false;
          el.classList.remove('wf-dragging');
          saveOffset(wfStore(wfState), card.dataset.loopId, id, last);
          el.dataset.justDragged = '1'; // read once by the click that ends this drag; the next press clears it if no click came (no timer needed)
        };
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onEnd);
        el.addEventListener('pointercancel', onEnd);
      });
    });
  });
}

// Reset layout: forget every saved position of the loops now shown and redraw.
function wfWireReset(main) {
  const btn = main.querySelector('.wf-reset-btn');
  if (!btn) return;
  btn.onclick = (e) => {
    e.stopPropagation();
    if (typeof clearOffsets === 'function' && typeof splitIntoLoops === 'function') clearOffsets(wfStore(wfState), splitIntoLoops(wfState.shown || wfState.graph).map((l) => l.id));
    wfDraw(main);
  };
}

function wfDraw(main) {
  const old = main.querySelector('#wf-surface');
  const scroll = old ? { left: old.scrollLeft, top: old.scrollTop } : null;
  const bodyTops = {}; // each card scrolls on its own when it is below the minimum scale
  main.querySelectorAll('.wf-card').forEach((c) => { const b = c.querySelector('.wf-card-body'); if (b) bodyTops[c.dataset.loopId] = b.scrollTop; });
  const shown = typeof collapseGraph === 'function' ? collapseGraph(wfState.graph, effectiveCollapsed(wfState.graph, wfState.toggles)) : wfState.graph;
  wfState.shown = shown;
  wfState.cols = wfMaxPerRow();
  if (wfState.selectedId && !(shown.nodes || []).some((n) => n.id === wfState.selectedId)) { wfState.selectedId = null; wfState.tasks = null; } // hidden inside a collapsed group
  main.innerHTML = typeof splitIntoLoops === 'function' ? buildCardsHtml(shown, wfState) : buildGraphHtml(shown, layoutGraph(shown, WF_LAYOUT_OPTS), wfState);
  wfFitCards(main);
  main.querySelectorAll('.wf-card').forEach((c) => { const b = c.querySelector('.wf-card-body'); if (b && bodyTops[c.dataset.loopId]) b.scrollTop = bodyTops[c.dataset.loopId]; });
  const surface = main.querySelector('#wf-surface');
  if (surface && scroll) { surface.scrollLeft = scroll.left; surface.scrollTop = scroll.top; }
  wireWorkersViewToggle(main);
  wireWorkerSwitchButtons(main);
  if (typeof wireNodePanel === 'function') wireNodePanel(main, {});
  if (typeof isTaskPinNode === 'function') wfLoadTasks(main);
  main.querySelectorAll('.wf-node').forEach((el) => {
    el.onclick = () => {
      if (el.dataset.justDragged === '1') { delete el.dataset.justDragged; return; } // the click that ends a drag is not a selection
      if (el.dataset.group === '1') { wfToggleGroup(el.dataset.nodeId, main); return; }
      wfState.selectedId = wfState.selectedId === el.dataset.nodeId ? null : el.dataset.nodeId;
      wfDraw(main);
    };
  });
  main.querySelectorAll('.wf-group-toggle').forEach((btn) => {
    btn.onclick = (e) => { e.stopPropagation(); wfToggleGroup(btn.dataset.groupId, main); };
  });
  wfWireDrag(main);
  wfWireReset(main);
  const log = main.querySelector('#wf-runlog');
  if (log) {
    fetchJson('/api/instances/' + encodeURIComponent(wfState.selectedId) + '/run-log')
      .then((r) => { if (main.contains(log)) log.innerHTML = renderRunLogList((r && r.runs) || []); })
      .catch(() => { log.textContent = 'Run log unavailable.'; });
  }
}

async function renderGraphView(main, isPoll) {
  // Like the Cards view: a poll must not redraw while the operator is choosing in a model or task dropdown.
  if (isPoll && typeof document !== 'undefined' && document.activeElement && document.activeElement.classList && ['worker-model-select', 'worker-type-select', 'worker-task-select'].some((c) => document.activeElement.classList.contains(c))) return;
  if (isPoll && wfState.dragging) return; // never replace the surface under a node that is being dragged
  const isStale = renderStaleCheck();
  let graph = null;
  let reason = '';
  try { graph = await fetchJson('/api/workflow-graph'); } catch (e) { reason = e && e.message ? e.message : 'request failed'; }
  if (isStale()) return;
  if (!graph || graph.available === false || !Array.isArray(graph.nodes)) {
    // A poll that fails (a slow route under load) keeps the graph that is already drawn, so the selection, the open panel and a dropdown survive; only a first or explicit render shows the message.
    if (isPoll && main.querySelector('#wf-surface')) return;
    wfState.signature = null;
    main.innerHTML = wfMessageHtml('The workflow graph is unavailable' + (graph && graph.reason ? ': ' + graph.reason : reason ? ': ' + reason : '') + '.');
    wireWorkersViewToggle(main);
    return;
  }
  const signature = graphSignature(graph);
  if (isPoll && !graphNeedsRedraw(wfState.signature, signature) && main.querySelector('#wf-surface')) return;
  wfState.graph = graph;
  wfState.signature = signature;
  if (wfState.selectedId && !graph.nodes.some((n) => n.id === wfState.selectedId)) wfState.selectedId = null;
  wfDraw(main);
}

if (typeof module !== 'undefined') module.exports = { wfEsc, workersViewMode, setWorkersView, workersViewToggleHtml, buildNodeHtml, buildEdgeSvg, buildDetailHtml, buildGraphHtml, buildCardHtml, buildCardsHtml, wfStore, wfMaxPerRow, graphSignature, graphNeedsRedraw };
