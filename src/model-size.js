'use strict';

// Model size for the Workers graph (loops by type, piece 1): how big a model a step needs, as a number of billions of parameters, a tier and a node scale.
// Pure: no I/O, never throws, never mutates its input. The graph builder attaches the result to every step; the view sizes the step card by `scale`.
//
// Local models: the size is read from the tag ('ornith:35b' -> 35, 'qwen3-vl:8b-instruct' -> 8, 'gemma4:e4b-it-qat' -> 4). Version digits before the colon ('qwen3.8', 'gemma4')
// are never a size. A tag with no size falls back to the lane's tierB.
// Cloud models: the vendor publishes no sizes, so CLOUD_NOMINAL_B is an ASSUMPTION used only to order the cloud tiers against local models. Edit it here, in one place.

const CLOUD_NOMINAL_B = { haiku: 30, sonnet: 100, opus: 200, fable: 400 };
const CLOUD_DEFAULT_B = 100;
const UNKNOWN_B = 100;   // for ordering only: an unknown size loses to any known one in smallestModelSize

const TIERS = [
  { max: 10, tier: 'small', scale: 1.0 },
  { max: 40, tier: 'medium', scale: 1.25 },
  { max: Infinity, tier: 'large', scale: 1.5 },
];

function tierFor(b) {
  return TIERS.find((t) => b <= t.max);
}

// The size in billions from a local tag: a number followed by 'b' right after a ':' '-' or '_' separator, so the family and its version ('qwen3.8', 'gemma4', 'llama3b')
// are never a size. An optional e-prefix ('e4b') is the same size as '4b'.
function sizeFromTag(name) {
  const m = /[:\-_]e?(\d+(?:\.\d+)?)b(?![a-z0-9])/i.exec(String(name || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// modelSize(name, provider, tierB) -> { b, tier, label, scale, source }
function modelSize(name, provider, tierB) {
  try {
    if (provider === 'script') return { b: 0, tier: 'script', label: 'script', scale: 0.8, source: 'none' };
    if (provider === 'cloud') {
      const lower = String(name || '').toLowerCase();
      const family = Object.keys(CLOUD_NOMINAL_B).find((f) => lower.includes(f));
      const b = family ? CLOUD_NOMINAL_B[family] : CLOUD_DEFAULT_B;
      const t = tierFor(b);
      return { b, tier: t.tier, label: family ? 'cloud ' + family : 'cloud', scale: t.scale, source: 'cloud-table' };
    }
    let b = sizeFromTag(name);
    let source = 'tag';
    if (b === null && typeof tierB === 'number' && Number.isFinite(tierB) && tierB > 0) { b = tierB; source = 'tierB'; }
    if (b === null) return { b: null, tier: 'medium', label: '?B', scale: 1.0, source: 'none' };
    const t = tierFor(b);
    return { b, tier: t.tier, label: b + 'B', scale: t.scale, source };
  } catch (e) {
    return { b: null, tier: 'medium', label: '?B', scale: 1.0, source: 'none' };
  }
}

// smallestModelSize(models) -> the modelSize object of the smallest model in [{ name, provider, tierB }], or null for an empty or non-array input.
// A script is 0 and so the smallest; an unknown size counts as UNKNOWN_B and loses to any known one; a tie keeps the first.
function smallestModelSize(models) {
  try {
    if (!Array.isArray(models) || !models.length) return null;
    let best = null;
    let bestB = Infinity;
    for (const m of models) {
      if (!m || typeof m !== 'object') continue;
      const size = modelSize(m.name, m.provider, m.tierB);
      const b = size.b === null ? UNKNOWN_B : size.b;
      if (b < bestB) { best = size; bestB = b; }
    }
    return best;
  } catch (e) {
    return null;
  }
}

if (typeof module !== 'undefined') module.exports = { CLOUD_NOMINAL_B, modelSize, smallestModelSize, sizeFromTag };
