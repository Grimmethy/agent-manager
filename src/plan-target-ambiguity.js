'use strict';

// Pure resolver for ambiguous bare-filename plan targets. String operations
// only: no I/O, no timers, no requires.

function normalize(p) {
  if (typeof p !== 'string') return '';
  let s = p.replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * @param {{name: string, candidates: string[], featureDir: string, secondAttempt: boolean}} opts
 * @returns {{kind:'none'}
 *   | {kind:'resolved', path:string}
 *   | {kind:'revise', ambiguous:Array<{name:string, candidates:string[]}>}
 *   | {kind:'pass', modifyTarget:string}}
 */
function resolveAmbiguousTarget(opts) {
  const o = opts || {};
  const name = o.name;
  const candidates = Array.isArray(o.candidates) ? o.candidates.filter((c) => typeof c === 'string') : [];
  const dir = normalize(o.featureDir);
  const prefix = dir ? dir + '/' : '';

  const under = prefix ? candidates.filter((c) => normalize(c).startsWith(prefix)) : [];
  if (under.length === 1) return { kind: 'resolved', path: under[0] };

  if (candidates.length <= 1) return { kind: 'none' };

  if (!o.secondAttempt) {
    return { kind: 'revise', ambiguous: [{ name, candidates: candidates.slice() }] };
  }
  return { kind: 'pass', modifyTarget: name };
}

module.exports = { resolveAmbiguousTarget };
