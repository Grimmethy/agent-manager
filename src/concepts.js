'use strict';

// Concept registry (2026-09-06, Grimmethy: "break the existing project down into
// concepts that can each be given this same kind of research treatment... give us a log
// of the work done on these concepts... track how much of the concept we built from
// scratch compared to using resources found in other repos").
//
// A "concept" is a named, narrow topic (e.g. "chat-context-trimming",
// "web-search-capability") that gets the same treatment already run twice by hand this
// session: a research fork surveys other projects, deep-dives them, and files findings
// via writeSideFindingInbox()/side-finding-sweep.js. This module is just the registry
// row + tally counters for that pattern -- the actual audit trail (which brain-dump
// entries and tasks belong to a concept) is a query over existing data
// (getConceptTimeline), not a duplicated log, so it can never drift from the source.
//
// v1 scope is deliberately narrow: concepts are created manually or organically (the
// first research fork on a new topic creates its row), never by an autonomous
// pipeline-driven task source -- see the plan's "explicitly out of scope" section for
// why (mirrors the arch_import premise-check incident's risk shape).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomicSync } = require('./atomic-write.js');

function conceptsPath(pipelineDir) {
  return path.join(pipelineDir, 'concepts.json');
}

// Mirrors apply-group-a.js's loadBrainDump: never let a missing/corrupt file break a
// caller -- an empty registry is always a safe fallback.
function loadConcepts(pipelineDir) {
  const filePath = conceptsPath(pipelineDir);
  let data;
  try {
    data = JSON.parse(fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '{"concepts":[]}');
  } catch (err) {
    console.error(`[loadConcepts] ${filePath}: ${err.message} -- returning empty store`);
    data = { concepts: [] };
  }
  if (!Array.isArray(data.concepts)) data.concepts = [];
  return data;
}

function writeConcepts(pipelineDir, data) {
  const filePath = conceptsPath(pipelineDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeJsonAtomicSync(filePath, data);
}

function findConcept(data, id) {
  return data.concepts.find((c) => c && c.id === id) || null;
}

function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'concept';
}

// Idempotent on the slugified name -- a second research fork "creating" a concept that
// already exists (organic-creation path, no coordination between callers) must return
// the existing row unchanged, never a duplicate.
function createConcept({ name, description }, pipelineDir, { createdBy } = {}) {
  const data = loadConcepts(pipelineDir);
  const slug = slugify(name);
  const existing = data.concepts.find((c) => c && c.slug === slug);
  if (existing) return existing;

  const concept = {
    id: `concept-${slug}-${crypto.randomBytes(3).toString('hex')}`,
    slug,
    name: String(name || '').trim(),
    description: String(description || '').trim(),
    status: 'open',
    createdAt: new Date().toISOString(),
    createdBy: createdBy === 'organic' ? 'organic' : 'manual',
    researchForkCount: 0,
    lastResearchedAt: null,
    builtFromScratchCount: 0,
    adaptedFromResourceCount: 0,
  };
  data.concepts.push(concept);
  writeConcepts(pipelineDir, data);
  return concept;
}

function recordConceptResearch(pipelineDir, conceptId) {
  if (!conceptId) return null;
  const data = loadConcepts(pipelineDir);
  const concept = findConcept(data, conceptId);
  if (!concept) return null;
  concept.researchForkCount = (concept.researchForkCount || 0) + 1;
  concept.lastResearchedAt = new Date().toISOString();
  if (concept.status === 'open') concept.status = 'researched';
  writeConcepts(pipelineDir, data);
  return concept;
}

// kind: 'scratch' | 'adapted'. Self-reported by the implementing model -- deliberately
// unverified in v1 (see plan's "explicitly out of scope"); the dashboard must label this
// tally as such rather than presenting it as fact.
function recordConceptBuildTally(pipelineDir, conceptId, kind) {
  if (!conceptId || (kind !== 'scratch' && kind !== 'adapted')) return null;
  const data = loadConcepts(pipelineDir);
  const concept = findConcept(data, conceptId);
  if (!concept) return null;
  if (kind === 'scratch') concept.builtFromScratchCount = (concept.builtFromScratchCount || 0) + 1;
  else concept.adaptedFromResourceCount = (concept.adaptedFromResourceCount || 0) + 1;
  if (concept.status === 'researched' || concept.status === 'open') concept.status = 'in-progress';
  writeConcepts(pipelineDir, data);
  return concept;
}

// Computed on demand from existing data, never persisted -- a concept's audit trail is
// a query over brain-dump.json (findings raised while researching/working on it) and
// task history (implementation work tagged with this concept), so it can't drift from
// the source of truth the way a duplicated log could.
function getConceptTimeline(pipelineDir, conceptId, { loadBrainDump, listTaskHistory } = {}) {
  const rows = [];

  if (typeof loadBrainDump === 'function') {
    let brainDump;
    try {
      brainDump = loadBrainDump(path.join(pipelineDir, 'brain-dump.json'));
    } catch { brainDump = { entries: [] }; }
    for (const entry of (brainDump.entries || [])) {
      if (entry && entry.raisedBy && entry.raisedBy.conceptId === conceptId) {
        rows.push({
          at: entry.capturedAt || entry.lastSeenAt || null,
          kind: 'research-finding',
          ref: entry.id,
          summary: (entry.rawText || '').split('\n')[0].slice(0, 120),
        });
      }
    }
  }

  if (typeof listTaskHistory === 'function') {
    let tasks;
    try {
      tasks = listTaskHistory(pipelineDir) || [];
    } catch { tasks = []; }
    for (const task of tasks) {
      if (task && task.conceptId === conceptId) {
        rows.push({
          at: task.completedAt || task.updatedAt || task.createdAt || null,
          kind: 'task',
          ref: task.id,
          summary: task.title || task.id,
        });
      }
    }
  }

  rows.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  return rows;
}

// Self-reported build-vs-borrow tally (Part 4). Same house style as
// side-finding.js's SIDE-FINDING: marker (one-line, lenient, strip-and-continue), but
// gated on the CALLER opting a task into it via conceptId -- unlike side-finding, this
// is not injected into every prompt, only ones a human/assistant explicitly tied to a
// concept (see AGENTS.md's "Concept research" section for why this stays manual for v1).
const CONCEPT_BUILD_INSTRUCTION = (
  'This task is tied to tracked concept work. When you finish, end your response with '
  + 'one line: CONCEPT-BUILD: scratch|adapted | <one-sentence detail> -- "scratch" if you '
  + "wrote this from nothing, \"adapted\" if you drew on a specific researched repo or "
  + 'design option, naming which one in the detail. This is a self-report for an audit '
  + 'chart, not graded -- be honest, not impressive.'
);

const CONCEPT_BUILD_MARKER_RE = /^CONCEPT-BUILD:\s*(scratch|adapted)\s*\|\s*(.+)$/im;

function injectConceptBuildInstruction(text) {
  const base = text || '';
  if (base.includes('CONCEPT-BUILD:')) return base;
  return `${base}\n\n${CONCEPT_BUILD_INSTRUCTION}`;
}

// Returns { cleanText, report: {kind, detail} | null }. Lenient: a missing/malformed
// marker just means report is null, never thrown -- the real response must never be
// held hostage by an optional audit tag the model forgot to include.
function extractConceptBuildReport(text) {
  const source = text || '';
  const match = source.match(CONCEPT_BUILD_MARKER_RE);
  if (!match) return { cleanText: source, report: null };
  const kind = match[1].toLowerCase();
  const detail = match[2].trim();
  const cleanText = source.replace(match[0], '').replace(/\n{3,}/g, '\n\n').trim();
  if (!detail) return { cleanText, report: null };
  return { cleanText, report: { kind, detail } };
}

module.exports = {
  conceptsPath,
  loadConcepts,
  writeConcepts,
  findConcept,
  createConcept,
  recordConceptResearch,
  recordConceptBuildTally,
  getConceptTimeline,
  CONCEPT_BUILD_INSTRUCTION,
  injectConceptBuildInstruction,
  extractConceptBuildReport,
};
