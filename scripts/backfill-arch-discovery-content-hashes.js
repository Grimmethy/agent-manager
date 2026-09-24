'use strict';

// One-time backfill for the arch_discovery content-hash staleness fix (2026-09-24).
//
// Before this fix, arch_discovery's per-community coverage was gated purely by
// taskIdExistsInQueue('arch-discovery-community-<id>') -- permanent, by id, with no
// content/timestamp comparison at all. A community whose files were rewritten after its
// one-and-only review looked "already done" forever (confirmed live: 0 of 16 communities
// had ever had lastReviewedAt stamped by a real review). agent-manager-hygiene/src/arch.js
// now suffixes the task id with a content hash instead, so a content change produces a
// new, never-before-seen id and becomes eligible again.
//
// Without this backfill, EVERY community that already has a legacy (pre-hash,
// un-suffixed) terminal task would look stale the instant the hash-aware code shipped --
// isCommunityCovered() has nothing to compare the current hash against yet -- and the
// whole backlog would re-queue itself in one shot, even though nothing had actually
// changed. This script stamps community-coverage.json's lastReviewedContentHash with each
// such community's hash AS OF RIGHT NOW, once, so isCommunityCovered() treats "unchanged
// since this backfill" as still covered. Any real edit after this point correctly produces
// a new hash and re-opens that community for review.
//
// Usage: node scripts/backfill-arch-discovery-content-hashes.js

const fs = require('fs');
const path = require('path');
const { ensureRegistered, getConfig } = require('../src/config.js');
const { taskIdExistsInQueue } = require('../src/task-sources.js');
const { writeJsonAtomicSync } = require('../src/atomic-write.js');

ensureRegistered();

const plugins = require('../plugins.json');
const hygienePlugin = plugins.find((p) => p.name === 'agent-manager-hygiene');
if (!hygienePlugin) {
  console.error('agent-manager-hygiene plugin not found in plugins.json -- arch_discovery lives there.');
  process.exit(1);
}
const archPath = path.join(path.dirname(hygienePlugin.registerPath), 'src', 'arch.js');
const { loadGraph, communityContentHash } = require(archPath);

const { repoRoot, communityCoveragePath, graphPath } = getConfig();

const coverageText = fs.readFileSync(communityCoveragePath, 'utf8');
const coverage = JSON.parse(coverageText);
const graph = loadGraph(graphPath);
if (!graph) {
  console.error(`Could not load graph at ${graphPath} -- nothing to backfill.`);
  process.exit(1);
}

let stamped = 0;
let skippedAlreadySet = 0;
let skippedNotReviewed = 0;
for (const community of coverage.communities) {
  if (community.lastReviewedContentHash) {
    skippedAlreadySet += 1;
    continue;
  }
  const legacyId = 'arch-discovery-community-' + community.id;
  if (!taskIdExistsInQueue(legacyId)) {
    skippedNotReviewed += 1; // never reviewed at all -- leave uncovered, it'll get picked up normally
    continue;
  }
  community.lastReviewedContentHash = communityContentHash(graph, community.id, repoRoot);
  stamped += 1;
  console.log(`backfilled community ${community.id} (${community.name}): ${community.lastReviewedContentHash}`);
}

if (stamped > 0) {
  writeJsonAtomicSync(communityCoveragePath, coverage);
}

console.log(`\nBackfilled ${stamped} community/ies, skipped ${skippedAlreadySet} already-set, ${skippedNotReviewed} never-reviewed.`);
