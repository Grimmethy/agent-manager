'use strict';

// Node code drift: compare each node's code version (codeSha) against wok's
// master sha and report whether each node is current, behind, or unknown.
//
// Pure module. No git, no fs, no network. Node built-ins only.
//
// `codeSha` is a lowercase 40-hex string (the HEAD sha of the node's
// agent-manager checkout) or null when it cannot be read. It rides in the
// heartbeat payload, is stored by recordHeartbeat, and is listed by listNodes.
//
// `countBehind(nodeSha, masterSha)` is an injected function returning the
// number of master commits the node lacks: a non-negative integer, or null
// when it cannot tell (for example the node's sha is not in wok's history).
//
// Returns one entry per input node in input order:
//   { id, codeSha, state, behind }
//   state  'current'  codeSha === masterSha, behind = 0
//   state  'behind'   countBehind returned an integer > 0, behind = that int
//   state  'unknown'  codeSha is null/missing, or countBehind returned null
//                    or threw, behind = null
// A node whose status is 'stale' or 'off' is still reported by its sha with
// the same rules.
//
// Throws TypeError for a masterSha that is not 40 lowercase hex or for a
// non-array `nodes`.

const MASTER_SHA_RE = /^[0-9a-f]{40}$/;

function codeDrift(nodes, masterSha, countBehind) {
  if (!Array.isArray(nodes)) {
    throw new TypeError('nodes must be an array');
  }
  if (typeof masterSha !== 'string' || !MASTER_SHA_RE.test(masterSha)) {
    throw new TypeError('masterSha must be a 40-character lowercase hex string');
  }
  if (typeof countBehind !== 'function') {
    throw new TypeError('countBehind must be a function');
  }
  return nodes.map((node) => {
    const id = node && typeof node.id === 'string' ? node.id : null;
    const codeSha = node && typeof node.codeSha === 'string' ? node.codeSha : null;

    if (codeSha === null || codeSha === undefined) {
      return { id, codeSha: codeSha, state: 'unknown', behind: null };
    }

    if (codeSha === masterSha) {
      return { id, codeSha, state: 'current', behind: 0 };
    }

    let behind;
    try {
      behind = countBehind(codeSha, masterSha);
    } catch (e) {
      return { id, codeSha, state: 'unknown', behind: null };
    }

    if (behind === null || behind === undefined || !Number.isInteger(behind) || behind < 0) {
      return { id, codeSha, state: 'unknown', behind: null };
    }

    if (behind === 0) {
      return { id, codeSha, state: 'current', behind: 0 };
    }

    return { id, codeSha, state: 'behind', behind };
  });
}

function describeDrift(entry) {
  const name = entry && typeof entry.id === 'string' ? entry.id : 'unknown';
  if (entry.state === 'behind') {
    const n = entry.behind || 0;
    const word = n === 1 ? 'commit' : 'commits';
    const short = typeof entry.codeSha === 'string' ? entry.codeSha.slice(0, 8) : '--------';
    return `${name}: behind by ${n} ${word} (${short})`;
  }
  if (entry.state === 'current') {
    const short = typeof entry.codeSha === 'string' ? entry.codeSha.slice(0, 8) : '--------';
    return `${name}: current (${short})`;
  }
  return `${name}: code version unknown`;
}

module.exports = { codeDrift, describeDrift };
