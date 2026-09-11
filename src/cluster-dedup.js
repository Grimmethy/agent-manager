'use strict';

// cluster-dedup.js -- cluster-based deduplication for findings. A sibling of
// staleness-audit-dedup.js, but keyed on a finding's (source, findingType,
// directory) triple instead of free-text similarity, so it is fully
// deterministic: two findings that are the same kind of issue flagged in the
// same place collapse into one cluster. If ANY member of a cluster was
// previously dismissed as a false positive, the WHOLE cluster is suppressed --
// a known false positive for a class of issue should not be re-dispatched for
// its siblings. Pure, no I/O, no external requires (same constraint as
// deterministic-recheck-registry.js, a core file on a hot path).

/**
 * @module cluster-dedup
 * @description Groups findings by `${source}|${findingType}|${directory}` and
 *   splits them into a flat `toDispatch` list and a flat `suppressed` list. A
 *   cluster is suppressed entirely when any one of its members carries
 *   `priorDisposition === 'dismissed-false-positive'`; otherwise the whole
 *   cluster is dispatched. Deterministic and pure: no I/O, no external requires.
 */

/**
 * Deduplicate a list of findings by their (source, findingType, directory)
 * cluster.
 * @param {Array<Object>} findings - Finding objects; each expected to have
 *   `source`, `findingType`, `directory` (which build the cluster key) and
 *   optionally `priorDisposition`.
 * @returns {{toDispatch: Array<Object>, suppressed: Array<Object>}} Flat lists of
 *   the input findings. Every cluster whose members include one with
 *   `priorDisposition === 'dismissed-false-positive'` lands in `suppressed`;
 *   every other cluster lands in `toDispatch`. Order within a list follows the
 *   order each cluster first appeared in `findings`.
 */
function dedupByCluster(findings) {
  if (!Array.isArray(findings)) {
    throw new TypeError('dedupByCluster: findings must be an array');
  }

  // Group findings into clusters, preserving first-appearance order.
  const clusters = new Map();
  for (const finding of findings) {
    const key = `${finding.source}|${finding.findingType}|${finding.directory}`;
    const list = clusters.get(key);
    if (list) {
      list.push(finding);
    } else {
      clusters.set(key, [finding]);
    }
  }

  const toDispatch = [];
  const suppressed = [];
  for (const cluster of clusters.values()) {
    const clusterSuppressed = cluster.some(
      (finding) => finding.priorDisposition === 'dismissed-false-positive'
    );
    if (clusterSuppressed) {
      suppressed.push(...cluster);
    } else {
      toDispatch.push(...cluster);
    }
  }

  return { toDispatch, suppressed };
}

module.exports = { dedupByCluster };
