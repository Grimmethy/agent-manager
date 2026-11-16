'use strict';

const fs = require('fs');

const DENY_KINDS = ['client', 'person', 'id', 'secret'];
const WORD = String.raw`\p{L}\p{N}_`;
const SUFFIX = '(?:[\u0027\u2019]s|s)?';

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}

// Whole-word, case-insensitive regex for a term. Words may be separated by
// '.' or spaces (initials). Throws if the term contains no words.
function compileTerm(term) {
  const tokens = String(term).split(/[.\s]+/).filter(Boolean);
  if (tokens.length === 0) throw new Error('term has no words');
  const body = tokens.map(escapeRegex).join('[. ]+');
  return new RegExp(`(?<![${WORD}])${body}${SUFFIX}(?![${WORD}])`, 'giu');
}

function lineOf(text, offset) {
  let n = 1;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}

function loadDenylist(path) {
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { present: false, rules: [] };
    throw err;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  const rules = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const fields = lines[i].split('|').map((f) => f.trim());
    const kind = fields[0];
    const fail = (msg) => new Error(`${path}:${lineNo}: ${msg}`);

    if (kind === 'allow') {
      if (fields.length !== 2) {
        throw fail(`allow rule must have 2 fields (allow|term), found ${fields.length}`);
      }
      if (!fields[1]) throw fail('empty term');
      rules.push({ allow: true, term: fields[1], line: lineNo });
    } else if (DENY_KINDS.includes(kind)) {
      if (fields.length !== 3) {
        throw fail(`${kind} rule must have 3 fields (kind|term|placeholder), found ${fields.length}`);
      }
      if (!fields[1]) throw fail('empty term');
      rules.push({ kind, term: fields[1], placeholder: fields[2], line: lineNo });
    } else {
      throw fail(`unknown kind '${kind}'`);
    }
  }
  return { present: true, rules };
}

function scanText(text, rules, fileLabel) {
  const source = text == null ? '' : String(text);
  const matches = [];
  const dismissed = [];
  const errors = [];
  const deny = [];
  const allow = [];

  for (const rule of rules || []) {
    let re;
    try {
      re = compileTerm(rule.term);
    } catch (err) {
      errors.push({
        file: fileLabel,
        line: rule.line,
        term: rule.term,
        message: `${fileLabel}:${rule.line}: ${err.message}`,
      });
      continue;
    }
    const bucket = rule.allow === true ? allow : deny;
    bucket.push({ rule, re });
  }

  const allowSpans = [];
  for (const { rule, re } of allow) {
    for (const m of source.matchAll(re)) {
      allowSpans.push({ start: m.index, end: m.index + m[0].length, term: rule.term });
    }
  }

  for (const { rule, re } of deny) {
    for (const m of source.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      const base = {
        kind: rule.kind,
        term: rule.term,
        start,
        end,
        line: lineOf(source, start),
        text: m[0],
        file: fileLabel,
      };
      const cover = allowSpans.find((a) => a.start <= start && a.end >= end);
      if (cover) {
        dismissed.push({ ...base, allowTerm: cover.term });
      } else {
        matches.push({ ...base, placeholder: rule.placeholder });
      }
    }
  }

  matches.sort((a, b) => a.start - b.start);
  dismissed.sort((a, b) => a.start - b.start);

  return {
    matches,
    dismissed,
    errors,
    stats: {
      matched: matches.length,
      dismissedByAllow: dismissed.length,
      termsLoaded: rules ? rules.length : 0,
    },
  };
}

module.exports = { loadDenylist, scanText };
