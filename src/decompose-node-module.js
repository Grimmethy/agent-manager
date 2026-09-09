'use strict';

// decompose-node-module.js (2026-09-09, [[hub-task-integration]] / concept-hub-task-integration-549f09).
//
// The CommonJS analogue of decompose-one-pass.js. Until now file-decompose only knew two
// extraction shapes: browser <script> (shared globals + a <script src> tag) and Flask
// blueprint (@bp.route + register_blueprint). A plain src/*.js module -- require() +
// module.exports -- had NO mechanism, so every src/*.js decompose fell through to a fully
// model-authored move + wiring, which is exactly the non-deterministic path this project
// keeps getting burned by.
//
// A CJS extraction is fully mechanical when the moved symbols are a SELF-CONTAINED set of
// top-level function declarations: they reference only each other, names bound by a
// top-level require(), and JS globals -- nothing else from the source's module scope.
// Then the whole split is three deterministic string ops:
//
//   new file  =  <source's require prelude>
//                <moved function bodies, verbatim>
//                module.exports = { ...moved names }
//
//   source    =  <moved functions deleted>
//                + `const { ...moved names } = require('./<newbase>.js')` right after the
//                  require prelude
//                module.exports  --  UNCHANGED. It still lists the same names; they are
//                just re-imported now instead of defined here. Any other code in the file
//                that called them (a `require.main === module` CLI block, a sibling
//                function) keeps working for the same reason: same names, same scope.
//
// If the moved code touches ANY other module-scope name of the source (a shared const, a
// non-moved helper), it is not self-contained -- bail with the exact names. The plan
// author includes those in the move, or they belong in a third shared module. This is the
// same bar staticCheckMove already holds .py moves to ("still referenced elsewhere -- not
// a self-contained move").

const path = require('path');
const { buildExtraction } = require('./script-extract.js');

// Names always in scope in a Node module without being declared.
const JS_GLOBALS = new Set([
  'require', 'module', 'exports', '__dirname', '__filename', 'process', 'console',
  'Buffer', 'global', 'globalThis', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'structuredClone',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal',
  'fetch', 'Math', 'JSON', 'Date', 'Array', 'Object', 'String', 'Number', 'Boolean',
  'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'EvalError', 'URIError', 'AggregateError', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef',
  'Promise', 'Symbol', 'Proxy', 'Reflect', 'BigInt', 'Function', 'Infinity', 'NaN',
  'undefined', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'Intl', 'ArrayBuffer', 'SharedArrayBuffer',
  'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'DataView', 'Atomics',
  'performance', 'arguments', 'this', 'true', 'false', 'null', 'void', 'typeof', 'new',
  'delete', 'in', 'instanceof', 'return', 'if', 'else', 'for', 'while', 'do', 'switch',
  'case', 'break', 'continue', 'throw', 'try', 'catch', 'finally', 'function', 'const',
  'let', 'var', 'class', 'extends', 'super', 'yield', 'await', 'async', 'of', 'get', 'set',
  'static', 'default', 'from', 'as', 'export', 'import',
]);

// Blank out string/comment noise BUT keep the code inside template-literal ${...}
// interpolations -- those hold live identifier references (a moved function that only
// calls its dependency from inside a `${dep(x)}` must still be seen to reference `dep`).
function stripStringsAndComments(code) {
  let out = code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:/])\/\/[^\n]*/g, '$1 ');
  out = out.replace(/`(?:\\.|\$\{(?:[^{}]|\{[^{}]*\})*\}|[^`\\])*`/g, (lit) => {
    const inners = [];
    lit.replace(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g, (_, expr) => { inners.push(expr); return ''; });
    return ` ${inners.join(' ')} `;
  });
  return out
    .replace(/'(?:\\.|[^'\\\n])*'/g, ' ')
    .replace(/"(?:\\.|[^"\\\n])*"/g, ' ');
}

// Names declared at column 0 of `src` (function/class NAME, const/let/var NAME, and
// destructured `const { a, b: c } = ...`). Column-0 only == genuinely module scope.
function topLevelBindingNames(src) {
  const names = new Set();
  for (const raw of src.split('\n')) {
    if (!/^(?:async\s+function|function|const|let|var|class)\b/.test(raw)) continue;
    let m;
    if ((m = raw.match(/^(?:async\s+function|function)\s*\*?\s*([A-Za-z_$][\w$]*)/))) { names.add(m[1]); continue; }
    if ((m = raw.match(/^class\s+([A-Za-z_$][\w$]*)/))) { names.add(m[1]); continue; }
    if ((m = raw.match(/^(?:const|let|var)\s*\{([^}]+)\}/))) {
      for (const part of m[1].split(',')) {
        const nm = part.split(':').pop().trim().replace(/\s*=[\s\S]*$/, '').replace(/\.\.\./, '');
        if (/^[A-Za-z_$][\w$]*$/.test(nm)) names.add(nm);
      }
      continue;
    }
    if ((m = raw.match(/^(?:const|let|var)\s*\[([^\]]+)\]/))) {
      for (const part of m[1].split(',')) {
        const nm = part.trim().replace(/\s*=[\s\S]*$/, '').replace(/\.\.\./, '');
        if (/^[A-Za-z_$][\w$]*$/.test(nm)) names.add(nm);
      }
      continue;
    }
    if ((m = raw.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/))) names.add(m[1]);
  }
  return names;
}

// Names *locally* bound inside a slice of code: any `const/let/var NAME`, `function NAME`,
// and parameter lists. Used to keep the self-containment check from flagging a moved
// function's own locals that happen to share a name with a source module-scope binding.
function locallyBoundNames(code) {
  const clean = stripStringsAndComments(code);
  const names = new Set();
  let m;
  const declRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = declRe.exec(clean))) names.add(m[1]);
  const destructRe = /\b(?:const|let|var)\s*[{[]([^}\]]+)[}\]]/g;
  while ((m = destructRe.exec(clean))) {
    for (const part of m[1].split(',')) {
      const nm = part.split(':').pop().trim().replace(/\s*=[\s\S]*$/, '').replace(/\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(nm)) names.add(nm);
    }
  }
  // Parameter lists: `function name(...)` and `(...) =>`. Pull EVERY identifier out of the
  // param group (including destructured `{ a, b: c }` / `[d]` and defaults) -- being
  // generous here only ever suppresses a false external-ref flag for a genuine local.
  const paramGroups = [];
  const fnRe = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(([\s\S]*?)\)/g;
  while ((m = fnRe.exec(clean))) { if (m[1]) names.add(m[1]); paramGroups.push(m[2]); }
  const arrowRe = /\(([\s\S]*?)\)\s*=>/g;
  while ((m = arrowRe.exec(clean))) paramGroups.push(m[1]);
  for (const g of paramGroups) {
    let pm;
    const idRe = /[A-Za-z_$][\w$]*/g;
    while ((pm = idRe.exec(g))) names.add(pm[0]);
  }
  const singleArrowRe = /(?:^|[^\w$)."'`])\s*([A-Za-z_$][\w$]*)\s*=>/g;
  while ((m = singleArrowRe.exec(clean))) names.add(m[1]);
  // for/catch bindings
  const forRe = /\bfor\s*\(\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)/g;
  while ((m = forRe.exec(clean))) names.add(m[1]);
  const catchRe = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g;
  while ((m = catchRe.exec(clean))) names.add(m[1]);
  return names;
}

// Identifiers *read* in a slice of code -- word tokens not preceded by `.` and not an
// object-literal key. Over-reports (locals, params) -- callers filter those out.
function referencedIdentifiers(code) {
  const clean = stripStringsAndComments(code);
  const out = new Set();
  const re = /(\.)?\b([A-Za-z_$][\w$]*)\b(\s*:(?![:=]))?/g;
  let m;
  while ((m = re.exec(clean))) {
    if (m[1] === '.') continue;
    if (m[3]) continue;
    out.add(m[2]);
  }
  return out;
}

// One top-level statement starting at line index `i` (column 0). Accumulates continuation
// lines until the statement terminates with `;` at end-of-line (capped), so a multi-line
// `const {\n a,\n b\n} = require('x');` is one unit. Returns { text, endExclusive }.
function readTopLevelStatement(lines, i) {
  let j = i;
  let buf = lines[i];
  while (!/;\s*$/.test(buf.trimEnd()) && j < lines.length - 1 && j - i < 40) {
    // A new column-0 statement keyword on the next line means the current one had no
    // trailing `;` -- stop here rather than swallowing it.
    if (/^(?:const|let|var|function|class|async\s|module\.exports|if\b|for\b|while\b|return\b)/.test(lines[j + 1] || '')) break;
    j += 1;
    buf += `\n${lines[j]}`;
  }
  return { text: buf, endExclusive: j + 1 };
}

// The module prelude: the CONTIGUOUS run of `'use strict'`, comments, and top-level
// `require(...)` / `import` statements at the very top of the file -- STOPPING at the first
// real code (a `function`, a `class`, a non-require `const/let/var`, or executable code).
// A `require()` that appears LATER in the file (a lazy/local-ish import after real code) is
// deliberately NOT part of the prelude -- putting the back-require after it would splice it
// into the middle of the module (the 2026-09-09 staleness-audit.js / apply-group-a.js
// corruption). Returns { prelude, body }.
function splitRequirePrelude(src) {
  const lines = src.split('\n');
  let i = 0;
  let preludeEnd = 0; // exclusive
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    if (/^\s*['"]use strict['"];?\s*$/.test(line)) { preludeEnd = i + 1; i++; continue; }
    if (/^\s*\/\//.test(line)) { i++; continue; }
    if (/^\s*\/\*/.test(line)) {
      while (i < lines.length && !/\*\//.test(lines[i])) i++;
      i += 1;
      continue;
    }
    if (/^import\b/.test(line)) { preludeEnd = i + 1; i++; continue; }
    if (/^(?:const|let|var|require)\b/.test(line)) {
      const stmt = readTopLevelStatement(lines, i);
      if (/\brequire\s*\(/.test(stmt.text)) { preludeEnd = stmt.endExclusive; i = stmt.endExclusive; continue; }
      break; // a non-require declaration == real code
    }
    break; // function / class / executable == real code
  }
  return { prelude: lines.slice(0, preludeEnd).join('\n'), body: lines.slice(preludeEnd).join('\n') };
}

// EVERY top-level `require(...)` / `import` statement in the whole file, not just the
// prelude ones -- a module-scope `const { x } = require('./y')` that sits AFTER real code
// still binds `x` module-wide, so the self-containment check and the new module both need
// to know about it.
function allTopLevelRequireStatements(src) {
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^import\b/.test(line)) { out.push(line); i++; continue; }
    if (/^(?:const|let|var|require)\b/.test(line) && /\brequire\s*\(/.test(line.split('//')[0])) {
      const stmt = readTopLevelStatement(lines, i);
      if (/\brequire\s*\(/.test(stmt.text)) { out.push(stmt.text); i = stmt.endExclusive; continue; }
    }
    i++;
  }
  return out;
}

/**
 * Build the whole CJS split as a deterministic Group-B change set, or bail with the exact
 * reason.
 *
 * @returns {{ok:true, changes:Array, newContent:string, reduced:string}
 *   | {ok:false, reason:string, externalRefs?:string[], problems?:Array}}
 *   changes: [{mode:'create', file:newFile, content}, {mode:'edit', file:sourceFile, find, replace}]
 */
function buildNodeModuleExtraction(sourceText, sourceFile, newFile, symbols) {
  if (!/\.(js|mjs|cjs)$/.test(sourceFile || '')) return { ok: false, reason: 'source is not a .js/.mjs/.cjs file' };
  if (!/\.(js|mjs|cjs)$/.test(newFile || '')) return { ok: false, reason: 'target is not a .js/.mjs/.cjs file' };
  if (!Array.isArray(symbols) || symbols.length === 0) return { ok: false, reason: 'no symbols to move' };

  const ex = buildExtraction(sourceText, symbols, { isHtml: false });
  if (!ex.ok) {
    return {
      ok: false,
      reason: `not every symbol resolves as a top-level function declaration: ${(ex.problems || []).map((p) => `${p.name} (${p.status})`).join('; ')}`,
      problems: ex.problems || [],
    };
  }

  const moved = new Set(symbols);
  const sourceBindings = topLevelBindingNames(sourceText);
  const allRequires = allTopLevelRequireStatements(sourceText);
  const requireBound = topLevelBindingNames(allRequires.join('\n'));
  const locals = locallyBoundNames(ex.newFileContent);
  const refs = referencedIdentifiers(ex.newFileContent);

  const external = [...refs].filter((n) =>
    sourceBindings.has(n) && !moved.has(n) && !requireBound.has(n) && !locals.has(n) && !JS_GLOBALS.has(n));
  if (external.length) {
    return {
      ok: false,
      reason: `not a self-contained move -- the moved code references module-scope name(s) of ${sourceFile} that are not being moved: ${external.sort().join(', ')}. Include them in this move, or split them into a shared module first.`,
      externalRefs: external.sort(),
    };
  }

  const newBase = path.basename(newFile).replace(/\.(js|mjs|cjs)$/, '');
  const hadUseStrict = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use strict['"]/.test(sourceText);
  // Carry over only the `require(...)` statements whose bound name(s) the moved code
  // actually references (plus any bare side-effect `require('./x')`). NOT the source's
  // prose head comment (it describes the source, not this slice). A require whose binding
  // is never referenced would be dead in the new module, so it is dropped.
  const requireLines = allRequires.filter((rl) => {
    const bound = topLevelBindingNames(rl);
    if (bound.size === 0) return true; // bare `require('./side-effect')`
    for (const n of bound) if (refs.has(n)) return true;
    return false;
  });
  const parts = [];
  if (hadUseStrict) parts.push("'use strict';\n");
  parts.push(`// ${path.basename(newFile)} -- extracted from ${sourceFile} ([[hub-task-integration]] node-module decompose).\n`);
  if (requireLines.length) parts.push(requireLines.join('\n') + '\n');
  parts.push(ex.newFileContent.replace(/\s+$/, '') + '\n');
  parts.push(`module.exports = { ${symbols.join(', ')} };\n`);
  const newContent = parts.join('\n');

  const backRequire = `const { ${symbols.join(', ')} } = require('./${newBase}.js');`;
  const reduced = insertBackRequire(ex.newSource, backRequire);

  return {
    ok: true,
    newContent,
    reduced,
    changes: [
      { mode: 'create', file: newFile, content: newContent },
      { mode: 'edit', file: sourceFile, find: sourceText, replace: reduced },
    ],
  };
}

/**
 * The whole plan as ONE deterministic Group-B change set -- N new modules + the reduced
 * source -- chaining each move against the previous move's reduced output. The CJS analogue
 * of decompose-one-pass.js's buildOnePassGroupBChanges.
 *
 * @param {Array<{newFile:string, symbols:string[]}>} moves
 * @returns {{ok:true, changes:Array} | {ok:false, reason:string, externalRefs?:string[], problems?:Array}}
 */
function buildNodeModuleOnePassChanges(sourceText, sourceFile, moves) {
  if (!/\.(js|mjs|cjs)$/.test(sourceFile || '')) return { ok: false, reason: 'source is not a .js/.mjs/.cjs file' };
  if (!Array.isArray(moves) || moves.length < 1) return { ok: false, reason: 'need at least one move' };
  const creates = [];
  let cur = sourceText;
  for (const move of moves) {
    if (!move || !move.newFile || !Array.isArray(move.symbols) || !move.symbols.length) {
      return { ok: false, reason: `move for ${move && move.newFile} has no symbols` };
    }
    const one = buildNodeModuleExtraction(cur, sourceFile, move.newFile, move.symbols);
    if (!one.ok) {
      return { ok: false, reason: `${move.newFile}: ${one.reason}`, externalRefs: one.externalRefs, problems: one.problems };
    }
    creates.push({ mode: 'create', file: move.newFile, content: one.newContent });
    cur = one.reduced; // next move extracts from here; its back-require is already in the prelude
  }
  const changes = [...creates, { mode: 'edit', file: sourceFile, find: sourceText, replace: cur }];

  // Independent final guard (2026-09-09 incident): write every produced file and run the
  // REAL `node --check` on it -- not the vm oracle, not this module's own splice logic. A
  // corrupt splice that still happened to vm-parse (or that only broke once applied) can
  // never be returned as ok. Cheap: N+1 short-lived `node --check` spawns.
  const parseErr = firstNodeCheckError(changes);
  if (parseErr) return { ok: false, reason: `produced file does not pass \`node --check\` -- ${parseErr}` };

  return { ok: true, changes };
}

// Returns the first `node --check` failure across a change set (`<file>: <first stderr line>`),
// or null if every produced file parses.
function firstNodeCheckError(changes) {
  const os = require('os');
  const fs = require('fs');
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-nodecheck-'));
  try {
    for (const ch of changes) {
      const body = ch.mode === 'create' ? ch.content : ch.replace;
      if (typeof body !== 'string') continue;
      const fp = path.join(dir, `${path.basename(ch.file)}.__check__.js`);
      fs.writeFileSync(fp, body);
      try {
        execFileSync('node', ['--check', fp], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 15_000 });
      } catch (e) {
        const line = String((e && e.stderr) || (e && e.message) || e).split('\n').find((l) => /SyntaxError|Error:/.test(l)) || 'parse failed';
        return `${ch.file}: ${line.trim().slice(0, 200)}`;
      }
    }
    return null;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// Put the back-require on its own line immediately after the reduced source's require
// prelude (blank line already there most of the time).
function insertBackRequire(reducedSource, line) {
  const { prelude, body } = splitRequirePrelude(reducedSource);
  const head = prelude.replace(/\s+$/, '');
  const tail = body.replace(/^\n+/, '');
  return `${head}\n${line}\n\n${tail}`;
}

// Eligible for the deterministic one-pass path? Mirrors decompose-one-pass.js's
// planIsFullyMechanicalHtml. Caller passes file-decompose-to-hub.js's validatePlan result.
function planIsFullyMechanicalNodeModule(request, validation) {
  if (process.env.AGENT_MANAGER_DECOMPOSE_NODE_MODULE === 'false') return false;
  if (!request || !/\.(js|mjs|cjs)$/.test(request.sourceFile || '')) return false;
  const moves = request.moves || [];
  if (moves.length < 1) return false;
  if (!moves.every((m) => m.kind === 'module-extract' || m.kind === 'script-extract')) return false;
  const meta = (validation && validation.moveMeta) || [];
  return moves.every((_, i) => meta[i] && meta[i].nodeModuleApplyOk === true);
}

module.exports = {
  buildNodeModuleExtraction,
  buildNodeModuleOnePassChanges,
  planIsFullyMechanicalNodeModule,
  topLevelBindingNames,
  locallyBoundNames,
  referencedIdentifiers,
  splitRequirePrelude,
  firstNodeCheckError,
  allTopLevelRequireStatements,
  JS_GLOBALS,
};
