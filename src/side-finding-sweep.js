'use strict';

// Drains queue/side-findings-inbox/ (written by local-client.js/claude-client.js's
// call() and local-tool-client.js's runPlanWithTools(), see side-finding.js's own
// header) into brain-dump.json, one batched read-modify-write per tick -- matching this
// codebase's own established watchdog-sweep convention (adhoc-staleness-flag.js,
// context-trim-sweep.js) rather than locking brain-dump.json at the (much hotter, much
// more concurrent) extraction chokepoints.
//
// Dedup + count tracker (2026-09-05, Grimmethy: "Sorters could also potentially recognize
// when an issue has already been found and combine them with a count tracker"): a new
// finding is compared, via the same cheap deterministic Jaccard similarity
// staleness-audit.js already uses for task-vs-task duplicate detection, against EXISTING
// brain-dump entries that carry a `raisedBy` field (i.e. other machine-raised findings
// only -- never a human-typed note, so a code observation can never silently absorb
// someone's actual project idea just because the words overlap). A match increments
// `count`/`lastSeenAt`/`seenIn` on the existing entry instead of creating a duplicate; no
// match files a brand new `status: 'captured'` entry, which then flows through the
// EXISTING brain_dump_sort task source exactly like a human-typed note -- no parallel
// triage system needed.
//
// Kill switch: AGENT_MANAGER_SIDE_FINDING_SWEEP=false.

const fs = require('fs');
const path = require('path');
const { normalizeTokens, jaccardSimilarity, sharesDistinctivePhrase } = require('./text-similarity.js');
const { writeJsonAtomicSync } = require('./atomic-write.js');
const { loadBrainDump } = require('./apply-group-a.js');
const { inboxDir } = require('./side-finding.js');

const MAX_SEEN_IN = 20;
const BATCH_CAP = Number(process.env.AGENT_MANAGER_SIDE_FINDING_SWEEP_BATCH) || 50;

function similarityThreshold() {
  const raw = Number(process.env.AGENT_MANAGER_SIDE_FINDING_DUP_SIMILARITY);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.6; // matches staleness-audit.js's own default
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'entry';
}

function nextSerial(entries) {
  let max = 0;
  for (const e of entries) {
    const n = Number(e && e.serial) || 0;
    if (n > max) max = n;
  }
  return max + 1;
}

function readInboxItems(pipelineDir) {
  const dir = inboxDir(pipelineDir);
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.slice(0, BATCH_CAP)) {
    const filePath = path.join(dir, name);
    try {
      const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (record && record.title && record.body) out.push({ record, filePath });
    } catch { /* malformed -- skip, cleaned up below regardless */ }
  }
  return out;
}

async function sweep({ pipelineDir, dryRun = false, now = Date.now() }) {
  const summary = { scanned: 0, merged: 0, created: 0, errors: 0, wouldMerge: [], wouldCreate: [] };
  if (process.env.AGENT_MANAGER_SIDE_FINDING_SWEEP === 'false') return summary;

  const items = readInboxItems(pipelineDir);
  summary.scanned = items.length;
  if (items.length === 0) return summary;

  const threshold = similarityThreshold();
  const nowIso = new Date(now).toISOString();
  const data = loadBrainDump(path.join(pipelineDir, 'brain-dump.json'));
  const machineEntries = data.entries.filter((e) => e && e.raisedBy);

  for (const { record, filePath } of items) {
    try {
      const mine = normalizeTokens(`${record.title} ${record.body}`);
      let best = null;
      for (const entry of machineEntries) {
        // Two signals, OR'd together -- root-caused live (2026-09-05): ~30 near-duplicate
        // findings landed as separate entries in one evening because their whole-text
        // Jaccard similarity (0.4, confirmed) sat under the 0.6 threshold even though they
        // were obviously the same underlying observation, just elaborated with a
        // different suggested fix each time. A shared distinctive multi-word phrase from
        // the TITLE (e.g. "duplicate-instance race") is a much more precise "same topic"
        // signal than a blended bag-of-words score, which dilutes on any elaboration.
        // Neither signal alone is sufficient -- phrase-sharing catches same-topic/
        // different-detail pairs Jaccard misses; Jaccard still catches a near-verbatim
        // restatement whose title happens to be phrased without a clean shared n-gram.
        const entryTitle = (entry.rawText || '').split('\n')[0];
        const phraseMatch = sharesDistinctivePhrase(record.title, entryTitle);
        const sim = mine.size >= 4
          ? jaccardSimilarity(mine, normalizeTokens(`${(entry.rawText || '').slice(0, 300)}`))
          : 0;
        if (phraseMatch || sim >= threshold) {
          const score = phraseMatch ? 1 : sim; // a phrase match always outranks a plain Jaccard match
          if (!best || score > best.sim) best = { entry, sim: score, viaPhrase: phraseMatch };
        }
      }

      if (best) {
        if (dryRun) {
          summary.wouldMerge.push({ title: record.title, into: best.entry.id, sim: best.sim });
          summary.merged += 1;
          continue;
        }
        best.entry.count = (best.entry.count || 1) + 1;
        best.entry.lastSeenAt = nowIso;
        const seenIn = Array.isArray(best.entry.seenIn) ? best.entry.seenIn : [];
        if (record.taskId && !seenIn.includes(record.taskId)) seenIn.push(record.taskId);
        best.entry.seenIn = seenIn.slice(-MAX_SEEN_IN);
        summary.merged += 1;
      } else {
        if (dryRun) {
          summary.wouldCreate.push({ title: record.title });
          summary.created += 1;
          continue;
        }
        const entry = {
          id: `bd-${now}-${slugify(record.title)}`,
          serial: nextSerial(data.entries),
          capturedAt: nowIso,
          rawText: `${record.title}\n\n${record.body}`,
          status: 'captured',
          raisedBy: { source: record.source || null, taskId: record.taskId || null, stage: record.stage || null },
          count: 1,
          lastSeenAt: nowIso,
          seenIn: record.taskId ? [record.taskId] : [],
        };
        data.entries.push(entry);
        machineEntries.push(entry); // visible to later items in this same batch
        summary.created += 1;
      }
    } catch (e) {
      console.error(`[side-finding-sweep] ${filePath}: ${e && e.message}`);
      summary.errors += 1;
    }
  }

  if (!dryRun) {
    writeJsonAtomicSync(path.join(pipelineDir, 'brain-dump.json'), data);
  }
  for (const { filePath } of items) {
    if (!dryRun) { try { fs.unlinkSync(filePath); } catch { /* already gone -- fine */ } }
  }

  return summary;
}

module.exports = { sweep, BATCH_CAP, MAX_SEEN_IN };

// --- CLI --------------------------------------------------------------------------
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const { getConfig } = require('./config.js');
  const { pipelineDir } = getConfig();
  sweep({ pipelineDir, dryRun })
    .then((s) => {
      if (dryRun) {
        for (const w of s.wouldMerge) console.log(`[merge] "${w.title}" -> ${w.into} (sim ${w.sim})`);
        for (const w of s.wouldCreate) console.log(`[create] "${w.title}"`);
        console.log(`\nwould merge ${s.merged}, would create ${s.created} / scanned ${s.scanned}`);
      } else {
        console.log(`side-finding-sweep: scanned=${s.scanned} merged=${s.merged} created=${s.created} errors=${s.errors}`);
      }
      process.exit(0);
    })
    .catch((e) => { console.error('[side-finding-sweep]', e && e.stack || e); process.exit(0); });
}
