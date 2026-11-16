'use strict';
const fs = require('fs');
const path = require('path');

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rulesFor(symbol) {
  const n = escapeRegex(symbol);
  return [
    { re: new RegExp('^\\s*(async\\s+)?def ' + n + '\\s*\\('), kind: () => 'def' },
    { re: new RegExp('^\\s*(export\\s+)?class ' + n + '\\b'), kind: () => 'class' },
    { re: new RegExp('^\\s*(export\\s+)?(async\\s+)?function ' + n + '\\b'), kind: () => 'function' },
    { re: new RegExp('^\\s*(export\\s+)?(const|let|var)\\s+' + n + '\\s*='), kind: (m) => m[2] },
  ];
}

function symbolDefinedInFile(filePath, symbol) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { found: false, line: null, kind: null };
    throw err;
  }
  const lines = text.split(/\r?\n/);
  const rules = rulesFor(String(symbol));
  for (let i = 0; i < lines.length; i++) {
    for (const rule of rules) {
      const m = rule.re.exec(lines[i]);
      if (m) return { found: true, line: i + 1, kind: rule.kind(m) };
    }
  }
  return { found: false, line: null, kind: null };
}

function appendDismissal(record, logPath) {
  const entry = {
    taskId: record.taskId,
    claim: record.claim,
    path: record.path,
    symbol: record.symbol,
    line: record.line,
    timestamp: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  return entry;
}

module.exports = { symbolDefinedInFile, appendDismissal };
