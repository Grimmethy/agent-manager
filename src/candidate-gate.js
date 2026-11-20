'use strict';
const fs = require('fs');
const path = require('path');

const RETRACTED_RES = [
  /\bretracted\b/i,
  /no code change is warranted/i,
  /premise[^.\n]{0,80}\bincorrect/i,
];

function normalize(block) {
  if (typeof block === 'string') return { heading: null, title: '', text: block, files: '' };
  const c = block || {};
  const files = Array.isArray(c.files) ? c.files.join(', ') : String(c.files || '');
  return {
    heading: c.headingId ? String(c.headingId) : (c.title ? String(c.title) : null),
    title: String(c.title || ''),
    text: [c.title, files ? 'Files: ' + files : '', c.body].filter(Boolean).join('\n'),
    files,
  };
}

function hasSection(text, label) {
  const re = new RegExp('^[ \\t]*(?:#{1,6}[ \\t]*)?[*_]*' + label + '[*_]*[ \\t]*:?[*_]*[ \\t]*:?[ \\t]*(\\S[^\\n]*)?$', 'im');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    if (m[1] && m[1].trim()) return true;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*#{1,6}\s/.test(lines[j])) break;
      if (lines[j].trim()) return true;
    }
  }
  return false;
}

function validateCandidateBlock(block) {
  const n = normalize(block);
  if (RETRACTED_RES.some((re) => re.test(n.title) || re.test(n.text))) return 'retracted';
  if (!n.files.trim() && !hasSection(n.text, 'Files')) return 'missing-files';
  if (!hasSection(n.text, 'Problem')) return 'missing-problem';
  if (!hasSection(n.text, 'Solution')) return 'missing-solution';
  if (!hasSection(n.text, 'Benefits')) return 'missing-benefits';
  return null;
}

function rejectCandidateBlock(c, candidatesPath) {
  const reason = validateCandidateBlock(c);
  if (!reason) return null;
  try {
    const logPath = path.join(path.dirname(candidatesPath), 'candidate-gate-rejections.jsonl');
    fs.appendFileSync(logPath, JSON.stringify({
      heading: normalize(c).heading,
      reason,
      timestamp: new Date().toISOString(),
    }) + '\n');
  } catch (e) {
    console.error('candidate-gate: failed to write rejection log:', e.message);
  }
  return reason;
}

module.exports = { rejectCandidateBlock, validateCandidateBlock };
