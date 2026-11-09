'use strict';

// io-churn-detector.js (command line) -- scan a diff or a repository for the model-reload mistakes defined in src/lib/io-churn-detector.js (operator doc: docs/agents/io-churn-detector.md).
//
//   node src/io-churn-detector.js scan --diff <file> [--fail-on-new]
//   node src/io-churn-detector.js scan --root <dir> [--json]
//
// --diff prints { new, known, annotated } like src/poll-detector.js (known is always [] in this version: a diff only has added lines, so nothing needs a baseline).
// Exit codes: 0 ok, 1 an unexpected error (or --fail-on-new found a NEW un-annotated finding), 2 a usage error.

const fs = require('fs');
const { execFileSync } = require('child_process');
const detector = require('./lib/io-churn-detector.js');
const { languageOf, shebangLanguage } = require('./lib/poll-detector.js');

const USAGE = ['usage: io-churn-detector.js scan --diff <file> [--fail-on-new]', '       io-churn-detector.js scan --root <dir> [--json]'].join('\n');
const MAX_FILE_BYTES = 1024 * 1024;

class UsageError extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opt = {};
  for (let i = 0; i < rest.length; i += 1) {
    const m = /^--([\w-]+)$/.exec(rest[i]);
    if (!m) throw new UsageError(`unexpected argument: ${rest[i]}`);
    if (m[1] === 'json' || m[1] === 'fail-on-new') opt[m[1]] = true;
    else if (m[1] === 'diff' || m[1] === 'root') {
      if (i + 1 >= rest.length || rest[i + 1].startsWith('--')) throw new UsageError(`--${m[1]} needs a value`);
      opt[m[1]] = rest[i + 1]; i += 1;
    } else throw new UsageError(`unknown option: --${m[1]}`);
  }
  return { command, opt };
}

function scanRoot(root) {
  let files;
  try { files = execFileSync('git', ['-C', root, 'ls-files', '-z'], { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').split('\0').filter(Boolean); }
  catch { throw new UsageError(`cannot list tracked files in --root ${root} (not a directory or not a git repository)`); }
  const out = [];
  for (const file of files) {
    let text;
    try { if (fs.statSync(`${root}/${file}`).size > MAX_FILE_BYTES) continue; text = fs.readFileSync(`${root}/${file}`, 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue;
    const language = languageOf(file) || shebangLanguage(text.split('\n', 1)[0]);
    out.push(...detector.scanText({ language, path: file, text }));
  }
  return out;
}

function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  try {
    const { command, opt } = parseArgs(argv);
    if (command !== 'scan') throw new UsageError(command ? `unknown command: ${command}` : 'a command is required');
    if (!!opt.root === !!opt.diff) throw new UsageError('scan needs exactly one of --root and --diff');
    if (opt['fail-on-new'] && !opt.diff) throw new UsageError('--fail-on-new belongs to scan --diff');
    if (opt.diff) {
      let diff;
      try { diff = fs.readFileSync(opt.diff, 'utf8'); } catch (e) { throw new UsageError(`cannot read diff ${opt.diff}: ${e.message}`); }
      const findings = detector.scanDiff(diff);
      const result = { new: findings.filter((f) => !f.annotated), known: [], annotated: findings.filter((f) => f.annotated) };
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return opt['fail-on-new'] && result.new.length > 0 ? 1 : 0;
    }
    const findings = scanRoot(opt.root);
    if (opt.json) io.stdout.write(`${JSON.stringify({ root: opt.root, count: findings.length, findings }, null, 2)}\n`);
    else { for (const f of findings) io.stdout.write(`${f.path}:${f.line}  ${f.kind}${f.annotated ? '  [annotated]' : ''}  ${f.snippet}\n`); io.stdout.write(`${findings.length} finding(s)\n`); }
    return 0;
  } catch (e) {
    if (e instanceof UsageError) { io.stderr.write(`io-churn-detector: ${e.message}\n${USAGE}\n`); return 2; }
    io.stderr.write(`io-churn-detector: ${e.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, parseArgs, scanRoot, UsageError };
