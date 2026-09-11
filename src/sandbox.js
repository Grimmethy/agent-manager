'use strict';

// Bubblewrap-backed filesystem sandbox for the one real Bash-capable, unattended tool-use
// call in this codebase (adhoc-agentic-draft.js's agentic Claude Code CLI invocation, see
// that file's own header). Grimmethy, 2026-08-24: "Sandbox abstraction... What are the
// tangible benefits we could gain for agent manager?" -> "Ok, let's build it now" --
// discussed alongside nullclaw's 4-backend Sandbox vtable (Landlock/Firejail/Bubblewrap/
// Docker), but this host only actually has bwrap installed (confirmed live: no firejail,
// no docker, and Landlock has no CLI wrapper or Node binding available here even though
// the kernel supports it) -- one real usable backend doesn't need a plugin registry yet,
// so this is a single function, not a vtable. Add a registry when a second backend is
// genuinely needed, not before (see model-provider.js's own header on model-strategies.js
// shipping unused abstraction the same way).
//
// Scope: filesystem containment ONLY. Network stays open -- Claude's own subscription API
// calls need it to function at all, and domain-scoped egress filtering (allow
// api.anthropic.com, block everything else a Bash-invoked curl could reach) needs a real
// proxy, out of scope for this pass. Documented here, not silently dropped.
//
// Confirmed live before writing this: a real `claude -p` call runs successfully inside a
// minimal bwrap profile with NO access to ~/.claude at all (headless -p mode needs nothing
// from there beyond CLAUDE_CODE_OAUTH_TOKEN, passed via env); a prompt directly asking
// Claude to read the real ~/.claude/.credentials.json file correctly got "No such file or
// directory" inside the sandbox -- the containment actually holds, not just "the CLI runs
// under bwrap."

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let cachedBwrapPath;
// One-shot check, cached at first call -- mirrors git-runner.js's own detectDefaultBranch()
// style for a similarly cheap, rarely-changing environment fact. clearBwrapPathCache is
// test-only (sandbox.test.js), so a test can force a fresh `which` lookup against a
// deliberately bwrap-less PATH to exercise the available:false branch without depending
// on whether the real test-runner host happens to have bwrap installed.
function bwrapPath() {
  if (cachedBwrapPath !== undefined) return cachedBwrapPath;
  try {
    cachedBwrapPath = execFileSync('which', ['bwrap'], { encoding: 'utf8' }).trim() || null;
  } catch (e) {
    cachedBwrapPath = null;
  }
  return cachedBwrapPath;
}
function clearBwrapPathCache() {
  cachedBwrapPath = undefined;
}

// If workDir is a linked git worktree (its .git is a FILE containing a "gitdir:" line,
// not a directory), returns the two binds git needs to actually work inside a sandbox:
// the main <repoRoot>/.git as read-only (objects/refs are shared with the main checkout
// and must not be mutated by a worktree-local status/diff), and the worktree's own
// .git/worktrees/<name> gitdir as writable (HEAD, index, and other worktree-local state
// live there and git status/diff must be able to refresh them). Returns empty bind lists
// for a normal repo (.git directory), a workDir with no .git at all, or a .git file that
// somehow lacks a "gitdir:" line (malformed -- nothing safe to derive from). buildBwrapArgs
// then skips any of these paths that does not exist on the host, as with all other binds.
function linkedWorktreeBinds(workDir) {
  const gitFile = path.join(workDir, '.git');
  let stat;
  try {
    stat = fs.statSync(gitFile);
  } catch (e) {
    return { readOnlyBinds: [], writableBinds: [] };
  }
  if (!stat.isFile()) return { readOnlyBinds: [], writableBinds: [] };
  const gitdirLine = fs.readFileSync(gitFile, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('gitdir:'));
  if (!gitdirLine) return { readOnlyBinds: [], writableBinds: [] };
  const worktreeGitDir = gitdirLine.slice('gitdir:'.length).trim();
  // e.g. /repo/.git/worktrees/feat-x -> /repo/.git (the two path segments above the name)
  const mainGitDir = path.dirname(path.dirname(worktreeGitDir));
  return { readOnlyBinds: [mainGitDir], writableBinds: [worktreeGitDir] };
}

// Builds a bwrap argv from a bind list. Read-only binds are applied first, writable binds
// second -- bwrap applies binds in argv order, so a writable bind whose path is NESTED
// inside an already-bound read-only tree correctly overrides just that subpath (this is
// how <repoRoot>/.git/worktrees/<name> gets to be writable while the rest of
// <repoRoot>/.git stays read-only -- see adhoc-agentic-draft.js's own comment on why that
// specific split is needed). Silently skips any bind path that doesn't exist on disk
// (e.g. /lib64 isn't present on every distro) rather than erroring -- a missing optional
// path is not a reason to fail the whole sandbox. Also auto-adds the linked-worktree .git
// split (see linkedWorktreeBinds) when workDir is a worktree, so git status/diff have
// read access to the shared main .git and write access to the worktree-local gitdir --
// without that, git inside the sandbox errors "not a git repository" or fails to refresh
// the worktree's index/HEAD (adhoc-brain-dump-bd-1788863683714 acceptance criterion 4).
function buildBwrapArgs({ workDir, readOnlyBinds = [], writableBinds = [], env = {} }) {
  const wt = linkedWorktreeBinds(workDir);
  readOnlyBinds = [...readOnlyBinds, ...wt.readOnlyBinds];
  writableBinds = [...writableBinds, ...wt.writableBinds];
  const args = [];
  for (const p of readOnlyBinds) {
    if (fs.existsSync(p)) args.push('--ro-bind', p, p);
  }
  for (const p of writableBinds) {
    if (fs.existsSync(p)) args.push('--bind', p, p);
  }
  args.push(
    '--tmpfs', '/tmp/sandbox-home',
    '--proc', '/proc',
    '--dev', '/dev',
    '--unshare-pid',
    '--die-with-parent',
    '--chdir', workDir,
    // Without --clearenv, bwrap inherits the FULL parent environment by default -- every
    // explicit --setenv below would then just be adding to whatever secrets already sat
    // in the calling process's env, not replacing them. Cleared first so the sandboxed
    // child's env is exactly and only what's passed here, nothing inherited.
    '--clearenv',
    '--setenv', 'HOME', '/tmp/sandbox-home',
  );
  for (const [key, value] of Object.entries(env)) {
    if (value != null) args.push('--setenv', key, String(value));
  }
  return args;
}

/**
 * Wraps `bin`/`args` to run under bwrap with the given bind list, or reports the sandbox
 * unavailable so the caller can decide whether to fail open or closed (see adhoc-agentic-
 * draft.js: this pipeline fails open with a loud, visible warning -- a hardening layer on
 * top of existing behavior should never become a new single point of failure that halts
 * real work if bwrap is missing on a given host).
 * @returns {{available: true, command: string, args: string[]} | {available: false}}
 */
function wrapWithSandbox(bin, binArgs, opts) {
  const bwrap = bwrapPath();
  if (!bwrap) return { available: false };
  const sandboxArgs = buildBwrapArgs(opts);
  return { available: true, command: bwrap, args: [...sandboxArgs, '--', bin, ...binArgs] };
}

module.exports = { wrapWithSandbox, buildBwrapArgs, clearBwrapPathCache, linkedWorktreeBinds };
