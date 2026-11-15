'use strict';

// Core module-knowledge library: front-matter parsing, git-diff analysis, coverage
// discovery, and anti-hallucination validation. Pure Node.js with no external
// dependencies. Every exported function is synchronous and deterministic.

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Minimal YAML-like front-matter parser (no external YAML library).
// Handles: strings, numbers, booleans, arrays (inline `[a, b]` and block
// `key:\n  - item` forms), and nested key-value pairs.
// ---------------------------------------------------------------------------

const FRONT_MATTER_RE = /^---\s*\n([\s\S]*?)^---\s*\n?/m;

function parseValue(raw) {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  // Strip surrounding quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseInlineArray(str) {
  // e.g. "[a, b, c]" or "[ 'a', 'b' ]"
  const inner = str.trim();
  if (!inner.startsWith('[') || !inner.endsWith(']')) return null;
  const content = inner.slice(1, -1).trim();
  if (content === '') return [];
  const items = [];
  let current = '';
  let depth = 0;
  let inQuote = null;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      items.push(parseValue(current));
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) items.push(parseValue(current));
  return items;
}

function parseBlockArray(lines, indent) {
  const items = [];
  for (const line of lines) {
    const stripped = line.slice(indent);
    if (stripped.startsWith('- ')) {
      items.push(parseValue(stripped.slice(2)));
    } else if (stripped.startsWith('-')) {
      items.push(parseValue(stripped.slice(1)));
    } else {
      break;
    }
  }
  return items;
}

// text -> parsed object (plain JS)
function parseModuleDoc(text) {
  if (typeof text !== 'string') {
    throw new Error('parseModuleDoc: expected string input');
  }
  const match = text.match(FRONT_MATTER_RE);
  if (!match) {
    throw new Error('parseModuleDoc: no front matter block found (must start with ---)');
  }
  const raw = match[1];
  const lines = raw.split('\n');
  const result = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }
    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();
    if (rest === '') {
      // Block array form: collect subsequent indented lines starting with "- "
      const indent = line.length - line.trimStart().length;
      const blockLines = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (next.trim() === '') { j++; continue; }
        const nextIndent = next.length - next.trimStart().length;
        if (nextIndent <= indent) break;
        blockLines.push(next);
        j++;
      }
      if (blockLines.length > 0 && blockLines[0].trim().startsWith('-')) {
        result[key] = parseBlockArray(blockLines, indent + 2);
      } else {
        result[key] = null;
      }
      i = j;
      continue;
    }
    // Inline array form
    if (rest.startsWith('[')) {
      const arr = parseInlineArray(rest);
      if (arr !== null) {
        result[key] = arr;
      } else {
        result[key] = parseValue(rest);
      }
    } else {
      result[key] = parseValue(rest);
    }
    i++;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Front-matter writer
// ---------------------------------------------------------------------------

function stringifyValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    const items = v.map((item) => {
      if (typeof item === 'string') {
        if (item.includes(':') || item.includes('[') || item.includes(']') ||
            item.includes(',') || item.includes("'") || item.includes('"') ||
            item.trim() === '' || item !== item.trim()) {
          return `"${item.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
        }
        return `'${item}'`;
      }
      return stringifyValue(item);
    });
    return `[${items.join(', ')}]`;
  }
  const s = String(v);
  if (s.includes('\n') || s.includes(':') || s.includes("'") || s.includes('"') ||
      s.trim() === '' || s !== s.trim()) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

function writeFrontMatter(obj, originalText) {
  if (obj === null || obj === undefined) {
    throw new Error('writeFrontMatter: obj must be an object');
  }
  if (typeof originalText !== 'string') {
    throw new Error('writeFrontMatter: originalText must be a string');
  }
  // Strip existing front matter block if present
  let body = originalText;
  if (body.startsWith('---')) {
    const endIdx = body.indexOf('\n---', 3);
    if (endIdx !== -1) {
      body = body.slice(endIdx + 4);
      // Strip leading newline if any
      if (body.startsWith('\n')) body = body.slice(1);
    }
  }
  // Build front matter
  const keys = Object.keys(obj);
  const lines = ['---'];
  for (const key of keys) {
    const value = obj[key];
    if (value === null || value === undefined) continue;
    lines.push(`${key}: ${stringifyValue(value)}`);
  }
  lines.push('---');
  return lines.join('\n') + '\n' + body;
}

// ---------------------------------------------------------------------------
// Schema validation — anti-hallucination guard
// ---------------------------------------------------------------------------

const REQUIRED_KEYS = ['id', 'schema_version'];
const OPTIONAL_KEYS = ['type', 'covers', 'depends_on', 'last_synced_commit', 'stale', 'stale_reason', 'auto_update', 'owner_notes_frozen', 'ignore'];
const ALL_KEYS = [...REQUIRED_KEYS, ...OPTIONAL_KEYS];

function validateDoc(text) {
  const violations = [];
  let parsed;
  try {
    parsed = parseModuleDoc(text);
  } catch (e) {
    violations.push({ line: 1, message: `Front matter parse error: ${e.message}` });
    return { violations };
  }

  // Check required keys presence
  for (const key of REQUIRED_KEYS) {
    if (!(key in parsed) || parsed[key] === undefined || parsed[key] === null) {
      violations.push({ line: 1, message: `Missing required key: ${key}` });
    }
  }

  // Check optional keys presence (warn but don't fail)
  for (const key of OPTIONAL_KEYS) {
    if (key in parsed && parsed[key] === undefined) {
      violations.push({ line: 1, message: `Key ${key} has null value` });
    }
  }

  // Validate id
  if ('id' in parsed && parsed.id !== null && parsed.id !== undefined) {
    if (typeof parsed.id !== 'string') {
      violations.push({ line: 1, message: `id must be a string, got ${typeof parsed.id}` });
    } else if (parsed.id.trim() === '') {
      violations.push({ line: 1, message: 'id must not be empty' });
    }
  }

  // Validate type
  if ('type' in parsed && parsed.type !== null && parsed.type !== undefined) {
    if (typeof parsed.type !== 'string') {
      violations.push({ line: 1, message: `type must be a string, got ${typeof parsed.type}` });
    }
  }

  // Validate covers
  if ('covers' in parsed && parsed.covers !== null && parsed.covers !== undefined) {
    if (!Array.isArray(parsed.covers)) {
      violations.push({ line: 1, message: 'covers must be an array' });
    } else {
      for (let i = 0; i < parsed.covers.length; i++) {
        if (typeof parsed.covers[i] !== 'string') {
          violations.push({ line: 1, message: `covers[${i}] must be a string` });
        }
      }
    }
  }

  // Validate ignore
  if ('ignore' in parsed && parsed.ignore !== null && parsed.ignore !== undefined) {
    if (!Array.isArray(parsed.ignore)) {
      violations.push({ line: 1, message: 'ignore must be an array' });
    } else {
      for (let i = 0; i < parsed.ignore.length; i++) {
        if (typeof parsed.ignore[i] !== 'string') {
          violations.push({ line: 1, message: `ignore[${i}] must be a string` });
        }
      }
    }
  }

  // Validate depends_on
  if ('depends_on' in parsed && parsed.depends_on !== null && parsed.depends_on !== undefined) {
    if (!Array.isArray(parsed.depends_on)) {
      violations.push({ line: 1, message: 'depends_on must be an array' });
    }
  }

  // Validate last_synced_commit
  if ('last_synced_commit' in parsed && parsed.last_synced_commit !== null && parsed.last_synced_commit !== undefined) {
    if (typeof parsed.last_synced_commit !== 'string') {
      violations.push({ line: 1, message: 'last_synced_commit must be a string' });
    }
  }

  // Validate stale
  if ('stale' in parsed && parsed.stale !== null && parsed.stale !== undefined) {
    if (typeof parsed.stale !== 'boolean') {
      violations.push({ line: 1, message: 'stale must be a boolean' });
    }
  }

  // Validate stale_reason
  if ('stale_reason' in parsed && parsed.stale_reason !== null && parsed.stale_reason !== undefined) {
    if (typeof parsed.stale_reason !== 'string') {
      violations.push({ line: 1, message: 'stale_reason must be a string' });
    }
  }

  // Validate auto_update
  if ('auto_update' in parsed && parsed.auto_update !== null && parsed.auto_update !== undefined) {
    if (typeof parsed.auto_update !== 'boolean') {
      violations.push({ line: 1, message: 'auto_update must be a boolean' });
    }
  }

  // Validate schema_version
  if ('schema_version' in parsed && parsed.schema_version !== null && parsed.schema_version !== undefined) {
    if (typeof parsed.schema_version !== 'number') {
      violations.push({ line: 1, message: 'schema_version must be a number' });
    }
  }

  // Validate owner_notes_frozen
  if ('owner_notes_frozen' in parsed && parsed.owner_notes_frozen !== null && parsed.owner_notes_frozen !== undefined) {
    if (typeof parsed.owner_notes_frozen !== 'boolean') {
      violations.push({ line: 1, message: 'owner_notes_frozen must be a boolean' });
    }
  }

  // Check for unknown keys
  for (const key of Object.keys(parsed)) {
    if (!ALL_KEYS.includes(key)) {
      violations.push({ line: 1, message: `Unknown key: ${key}` });
    }
  }

  return { violations };
}

// ---------------------------------------------------------------------------
// loadConfig — read JSON config file with module definitions
// ---------------------------------------------------------------------------

function loadConfig(filePath) {
  if (typeof filePath !== 'string') {
    throw new Error('loadConfig: filePath must be a string');
  }
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`loadConfig: file not found: ${absolutePath}`);
  }
  const raw = fs.readFileSync(absolutePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`loadConfig: invalid JSON: ${e.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('loadConfig: config must be a JSON array of modules');
  }
  // Validate each module
  const result = [];
  for (let i = 0; i < parsed.length; i++) {
    const mod = parsed[i];
    if (typeof mod !== 'object' || mod === null) {
      throw new Error(`loadConfig: module[${i}] must be an object`);
    }
    if (!mod.id || typeof mod.id !== 'string') {
      throw new Error(`loadConfig: module[${i}] missing valid id`);
    }
    if (!mod.covers || !Array.isArray(mod.covers)) {
      throw new Error(`loadConfig: module[${i}] (${mod.id}) missing valid covers array`);
    }
    if (mod.ignore !== undefined && !Array.isArray(mod.ignore)) {
      throw new Error(`loadConfig: module[${i}] (${mod.id}) ignore must be an array`);
    }
    result.push(mod);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Glob matching (minimatch-lite): * and ** expansion
// ---------------------------------------------------------------------------

function globToRegex(glob) {
  // Process character by character to handle ** correctly
  let regex = '';
  let i = 0;
  while (i < glob.length) {
    if (glob[i] === '*' && glob[i + 1] === '*') {
      // ** matches zero or more directories (including zero)
      regex += '(?:.*\\/)?';
      i += 2;
      // Skip trailing / if present (it's part of the ** semantics)
      if (glob[i] === '/') i++;
    } else if (glob[i] === '*') {
      // * matches anything except /
      regex += '[^/]*';
      i++;
    } else if (/[.+?^${}()|[\]\\]/.test(glob[i])) {
      // Escape regex special chars
      regex += '\\' + glob[i];
      i++;
    } else {
      regex += glob[i];
      i++;
    }
  }
  return new RegExp('^' + regex + '$');
}

function matchGlob(glob, filePath) {
  const re = globToRegex(glob);
  return re.test(filePath);
}

// ---------------------------------------------------------------------------
// discoverCoverage — map files to modules by glob
// ---------------------------------------------------------------------------

function discoverCoverage(modules, fileList) {
  if (!Array.isArray(modules)) {
    throw new Error('discoverCoverage: modules must be an array');
  }
  if (!Array.isArray(fileList)) {
    throw new Error('discoverCoverage: fileList must be an array');
  }
  const fileToModule = new Map();
  const uncovered = [];
  const multiplyCovered = [];
  const fileModuleCount = new Map();

  for (const file of fileList) {
    const matchingModules = [];
    for (const mod of modules) {
      if (!mod.covers || !Array.isArray(mod.covers)) continue;
      for (const glob of mod.covers) {
        if (matchGlob(glob, file)) {
          matchingModules.push(mod.id);
          break; // Stop at first matching glob for this module
        }
      }
    }
    fileModuleCount.set(file, matchingModules.length);
    if (matchingModules.length === 0) {
      uncovered.push(file);
    } else if (matchingModules.length === 1) {
      fileToModule.set(file, matchingModules[0]);
    } else {
      multiplyCovered.push(file);
      // Use first module for the map (but flag as multiply covered)
      fileToModule.set(file, matchingModules[0]);
    }
  }

  return { fileToModule, uncovered, multiplyCovered };
}

// ---------------------------------------------------------------------------
// queryByFiles — find modules covering given files
// ---------------------------------------------------------------------------

function queryByFiles(modules, filePaths) {
  if (!Array.isArray(modules)) {
    throw new Error('queryByFiles: modules must be an array');
  }
  if (!Array.isArray(filePaths)) {
    throw new Error('queryByFiles: filePaths must be an array');
  }
  const ids = new Set();
  const paths = new Set();
  let stale = false;

  for (const mod of modules) {
    if (!mod.id || !mod.covers || !Array.isArray(mod.covers)) continue;
    for (const file of filePaths) {
      for (const glob of mod.covers) {
        if (matchGlob(glob, file)) {
          ids.add(mod.id);
          for (const g of mod.covers) {
            paths.add(g);
          }
          if (mod.stale === true) {
            stale = true;
          }
          break;
        }
      }
    }
  }

  return {
    ids: Array.from(ids),
    paths: Array.from(paths),
    stale,
  };
}

// ---------------------------------------------------------------------------
// diffToModules — parse unified git diff and map to modules
// ---------------------------------------------------------------------------

function diffToModules(modules, diffText, options) {
  if (!Array.isArray(modules)) {
    throw new Error('diffToModules: modules must be an array');
  }
  if (typeof diffText !== 'string') {
    throw new Error('diffToModules: diffText must be a string');
  }
  options = options || {};
  const largeThreshold = options.largeThreshold || { files: 5, lines: 200 };

  // Parse unified diff: lines starting with "+++" or "---" indicate file changes
  const diffLines = diffText.split('\n');
  const changedFiles = [];
  const fileLineCounts = new Map();
  let currentFile = null;
  let currentAction = null;

  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];
    if (line.startsWith('+++ b/')) {
      const prevFile = currentFile;
      currentFile = line.slice(6); // After "+++ b/"
      if (prevFile && currentAction === 'added') {
        // File was added
      }
      // Determine action from previous lines
      if (line.startsWith('+++ /dev/null')) {
        currentAction = 'added';
        currentFile = null; // Skip /dev/null lines
      } else if (prevFile) {
        // Look at the --- line before this +++ line
        for (let j = i - 1; j >= 0; j--) {
          if (diffLines[j].startsWith('--- a/')) {
            if (diffLines[j] === '--- /dev/null') {
              currentAction = 'added';
            } else {
              currentAction = 'modified';
            }
            break;
          }
        }
      } else {
        currentAction = 'modified';
      }
    } else if (line.startsWith('--- a/') && currentFile) {
      // Previous file block ended
      // Already handled above
    }

    // Count lines in hunk
    if (currentFile && line.startsWith('+') && !line.startsWith('+++')) {
      const count = fileLineCounts.get(currentFile) || 0;
      fileLineCounts.set(currentFile, count + 1);
    }
  }

  // Collect unique files
  const seenFiles = new Set();
  const fileActions = new Map();
  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];
    if (line.startsWith('+++ b/') && !line.startsWith('+++ /dev/null')) {
      const fileName = line.slice(6);
      if (!seenFiles.has(fileName)) {
        seenFiles.add(fileName);
        changedFiles.push(fileName);
        // Determine action
        let action = 'modified';
        for (let j = i - 1; j >= 0; j--) {
          if (diffLines[j].startsWith('--- ')) {
            if (diffLines[j].startsWith('--- /dev/null')) {
              action = 'added';
            } else {
              action = 'modified';
            }
            break;
          }
        }
        fileActions.set(fileName, action);
      }
    }
  }

  // Also detect deletions (--- a/ file but +++ /dev/null)
  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];
    if (line.startsWith('--- a/') && !line.startsWith('--- /dev/null')) {
      const fileName = line.slice(6);
      // Check next non-empty line
      for (let j = i + 1; j < diffLines.length; j++) {
        if (diffLines[j].trim() === '') continue;
        if (diffLines[j].startsWith('+++ /dev/null')) {
          if (!seenFiles.has(fileName)) {
            seenFiles.add(fileName);
            changedFiles.push(fileName);
            fileActions.set(fileName, 'deleted');
          }
        }
        break;
      }
    }
  }

  // Map files to modules
  const affected = [];
  const uncoveredFiles = [];
  const totalFiles = changedFiles.length;
  let totalLines = 0;

  for (const file of changedFiles) {
    totalLines += fileLineCounts.get(file) || 0;
    let matched = false;
    for (const mod of modules) {
      if (!mod.covers || !Array.isArray(mod.covers)) continue;
      for (const glob of mod.covers) {
        if (matchGlob(glob, file)) {
          affected.push({
            id: mod.id,
            files: [file],
            lines: fileLineCounts.get(file) || 0,
            action: fileActions.get(file) || 'modified',
          });
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      uncoveredFiles.push(file);
    }
  }

  const isLarge = totalFiles > largeThreshold.files || totalLines > largeThreshold.lines;

  return {
    affected,
    uncoveredFiles: isLarge ? uncoveredFiles : [],
    totalFiles,
    totalLines,
    isLarge,
  };
}

// ---------------------------------------------------------------------------
// markStale — find module covering a file, mark it stale, write back doc
// ---------------------------------------------------------------------------

function markStale(modules, filePath, reason) {
  if (!Array.isArray(modules)) {
    throw new Error('markStale: modules must be an array');
  }
  if (typeof filePath !== 'string') {
    throw new Error('markStale: filePath must be a string');
  }
  if (typeof reason !== 'string') {
    throw new Error('markStale: reason must be a string');
  }

  // Find the module that covers this file
  let targetMod = null;
  for (const mod of modules) {
    if (!mod.covers || !Array.isArray(mod.covers)) continue;
    for (const glob of mod.covers) {
      if (matchGlob(glob, filePath)) {
        targetMod = mod;
        break;
      }
    }
    if (targetMod) break;
  }

  if (!targetMod) {
    throw new Error(`markStale: no module covers file: ${filePath}`);
  }

  // Build updated module doc
  const doc = {
    id: targetMod.id,
    title: targetMod.title || '',
    type: targetMod.type || 'module',
    covers: targetMod.covers || [],
    ignore: targetMod.ignore || [],
    depends_on: targetMod.depends_on || [],
    last_synced_commit: targetMod.last_synced_commit || '',
    stale: true,
    stale_reason: reason,
    auto_update: targetMod.auto_update !== undefined ? targetMod.auto_update : false,
    schema_version: targetMod.schema_version !== undefined ? targetMod.schema_version : 1,
    owner_notes_frozen: targetMod.owner_notes_frozen !== undefined ? targetMod.owner_notes_frozen : false,
  };

  // If module has a docPath, write the updated doc
  if (targetMod.docPath) {
    const docPath = path.resolve(targetMod.docPath);
    const dir = path.dirname(docPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const frontMatter = writeFrontMatter(doc, '');
    fs.writeFileSync(docPath, frontMatter, 'utf8');
  }

  return doc;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  loadConfig,
  discoverCoverage,
  parseModuleDoc,
  writeFrontMatter,
  queryByFiles,
  diffToModules,
  markStale,
  validateDoc,
};
