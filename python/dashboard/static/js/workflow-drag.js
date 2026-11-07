// Pure helpers for dragging the nodes of the Workers workflow graph (HUB0346 piece 3).
// A plain global <script> loaded by index.html before workflow-graph-view.js; only declarations, no DOM. The guarded export lets `node --test` require it.
//
// Approach taken from Drawflow (https://github.com/jerosoler/Drawflow, MIT): on press record the pointer and the node position, on move add the pointer delta
// divided by the zoom to the node position, then update the edges of that node. Re-written here for Pointer Events; nothing of Drawflow is copied or loaded.
//
// What is saved: localStorage key WF_POSITIONS_KEY holds { "<loop id>": { "<node id>": { x, y } } }, x and y being the node's top-left corner in the unscaled
// canvas pixels of that loop's card. The storage is always passed in (tests use a fake with getItem and setItem); every storage error is swallowed, so a browser
// that refuses storage just does not remember.

const WF_POSITIONS_KEY = 'workersGraphPositions';
const DRAG_THRESHOLD_PX = 5;

function wfDragFinite(n) { return typeof n === 'number' && Number.isFinite(n); }

// True once the pointer has travelled more than DRAG_THRESHOLD_PX from where it went down; a shorter press is a click.
function movedPastThreshold(dx, dy) {
  return wfDragFinite(dx) && wfDragFinite(dy) && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX;
}

// The node position after the pointer moved by (dx, dy) screen pixels while the card is drawn at `scale`: the delta is divided by the scale, rounded to whole
// pixels and never negative. A missing or bad scale counts as 1.
function moveBy(startPos, dx, dy, scale) {
  const s = wfDragFinite(scale) && scale > 0 ? scale : 1;
  const x = startPos && wfDragFinite(startPos.x) ? startPos.x : 0;
  const y = startPos && wfDragFinite(startPos.y) ? startPos.y : 0;
  const mx = wfDragFinite(dx) ? dx : 0;
  const my = wfDragFinite(dy) ? dy : 0;
  return { x: Math.max(0, Math.round(x + mx / s)), y: Math.max(0, Math.round(y + my / s)) };
}

function wfReadAll(storage) {
  try {
    const raw = storage && typeof storage.getItem === 'function' ? storage.getItem(WF_POSITIONS_KEY) : null;
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
}

function wfWriteAll(storage, all) {
  try {
    if (!storage || typeof storage.setItem !== 'function') return false;
    storage.setItem(WF_POSITIONS_KEY, JSON.stringify(all));
    return true;
  } catch (e) {
    return false;
  }
}

// The saved positions of one loop card as { nodeId: { x, y } }; entries that are not two finite numbers are dropped. Never throws.
function loadOffsets(storage, loopId) {
  const all = wfReadAll(storage);
  const mine = Object.prototype.hasOwnProperty.call(all, loopId) ? all[loopId] : null;
  const out = {};
  if (!mine || typeof mine !== 'object') return out;
  Object.keys(mine).forEach((id) => {
    const p = mine[id];
    if (p && wfDragFinite(p.x) && wfDragFinite(p.y)) out[id] = { x: p.x, y: p.y };
  });
  return out;
}

// Remember where one node was left on one loop card. Returns true when it was written.
function saveOffset(storage, loopId, nodeId, pos) {
  if (typeof loopId !== 'string' || typeof nodeId !== 'string' || !pos || !wfDragFinite(pos.x) || !wfDragFinite(pos.y)) return false;
  const all = wfReadAll(storage);
  const mine = Object.prototype.hasOwnProperty.call(all, loopId) && all[loopId] && typeof all[loopId] === 'object' ? all[loopId] : {};
  mine[nodeId] = { x: pos.x, y: pos.y };
  all[loopId] = mine;
  return wfWriteAll(storage, all);
}

// Forget the saved positions of the given loop cards (all of them when no list is given).
function clearOffsets(storage, loopIds) {
  if (!Array.isArray(loopIds)) return wfWriteAll(storage, {});
  const all = wfReadAll(storage);
  loopIds.forEach((id) => { delete all[id]; });
  return wfWriteAll(storage, all);
}

// A new positions object: `positions` with the saved offsets laid over it. An offset whose node id is not in validIds (an array or a Set) or not in `positions`,
// or whose numbers are not finite, is ignored. The inputs are not mutated.
function applyOffsets(positions, offsets, validIds) {
  const out = {};
  Object.keys(positions || {}).forEach((id) => { out[id] = positions[id]; });
  const valid = validIds instanceof Set ? validIds : new Set(Array.isArray(validIds) ? validIds : []);
  Object.keys(offsets || {}).forEach((id) => {
    const p = offsets[id];
    if (valid.has(id) && Object.prototype.hasOwnProperty.call(out, id) && p && wfDragFinite(p.x) && wfDragFinite(p.y)) out[id] = { x: p.x, y: p.y };
  });
  return out;
}

// The straight line for an edge whose end(s) were moved by hand: from the bottom middle of the source to the top middle of the target, or, when the target's top is now
// above the source's top (it was dragged above it), from the top middle of the source to the bottom middle of the target. Overlapping nodes keep the first form.
// size = { w, h } of a node card.
function edgeBetween(from, to, size) {
  const w = size && wfDragFinite(size.w) ? size.w : 0;
  const h = size && wfDragFinite(size.h) ? size.h : 0;
  const a = from || { x: 0, y: 0 };
  const b = to || { x: 0, y: 0 };
  if (b.y >= a.y) return [{ x: Math.round(a.x + w / 2), y: Math.round(a.y + h) }, { x: Math.round(b.x + w / 2), y: Math.round(b.y) }];
  return [{ x: Math.round(a.x + w / 2), y: Math.round(a.y) }, { x: Math.round(b.x + w / 2), y: Math.round(b.y + h) }];
}

if (typeof module !== 'undefined') module.exports = { WF_POSITIONS_KEY, DRAG_THRESHOLD_PX, movedPastThreshold, moveBy, loadOffsets, saveOffset, clearOffsets, applyOffsets, edgeBetween };
