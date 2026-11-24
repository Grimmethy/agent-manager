import { after, before } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const FIXTURE_IDENTITY = {
  name: 'fixture',
  email: 'fixture@example.invalid',
};
const FIXED_DATE = '2020-01-01T00:00:00Z';

function git(args, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...process.env, ...extraEnv }, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function isDaemonNotRunning(error) {
  const text = `${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message ?? ''}`;
  return /not running/i.test(text);
}

/**
 * Registers node:test before/after hooks that create a scoped temporary git
 * repository (with one empty root commit) and remove it afterwards.
 * Call inside a describe block. Returns a getter for the workspace path.
 */
export function useTmpGitWorkspace(options) {
  let workspace;

  before(async () => {
    const raw = await mkdtemp(path.join(os.tmpdir(), 'agent-manager-fixture-'));
    workspace = await realpath(raw);
    await git(['init'], workspace);
    await git(['config', 'core.fsmonitor', 'false'], workspace);
    await git(['config', 'commit.gpgsign', 'false'], workspace);
    await git(['config', 'user.name', FIXTURE_IDENTITY.name], workspace);
    await git(['config', 'user.email', FIXTURE_IDENTITY.email], workspace);
    await git(['commit', '--allow-empty', '-m', 'root'], workspace, {
      GIT_AUTHOR_DATE: FIXED_DATE,
      GIT_COMMITTER_DATE: FIXED_DATE,
    });
  });

  after(async () => {
    if (!workspace) return;
    try {
      await git(['fsmonitor--daemon', 'stop'], workspace);
    } catch (error) {
      if (!isDaemonNotRunning(error)) throw error;
    }
    await rm(workspace, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  return () => workspace;
}
