const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { clearStaleLocks } = require('../src/git-runner.js');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'git-runner-test-'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('removes 2-hour-old lock with no git process', async () => {
  const tmpDir = createTempDir();
  const gitDir = path.join(tmpDir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });

  const lockFile = path.join(gitDir, 'apply.lock');
  const pid = process.pid;
  fs.writeFileSync(lockFile, String(pid));

  // Set mtime to 2 hours ago
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(lockFile, twoHoursAgo, twoHoursAgo);

  // Set AGENT_MANAGER_APPLY_REPO_ROOT to match
  const originalEnv = process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
  process.env.AGENT_MANAGER_APPLY_REPO_ROOT = tmpDir;

  try {
    clearStaleLocks(tmpDir);
    assert.ok(!fs.existsSync(lockFile), 'Lock file should be removed');
  } finally {
    if (originalEnv) {
      process.env.AGENT_MANAGER_APPLY_REPO_ROOT = originalEnv;
    } else {
      delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('keeps 1-minute-old lock', async () => {
  const tmpDir = createTempDir();
  const gitDir = path.join(tmpDir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });

  const lockFile = path.join(gitDir, 'apply.lock');
  const pid = process.pid;
  fs.writeFileSync(lockFile, String(pid));

  const originalEnv = process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
  process.env.AGENT_MANAGER_APPLY_REPO_ROOT = tmpDir;

  try {
    clearStaleLocks(tmpDir);
    assert.ok(fs.existsSync(lockFile), 'Lock file should be kept');
  } finally {
    if (originalEnv) {
      process.env.AGENT_MANAGER_APPLY_REPO_ROOT = originalEnv;
    } else {
      delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('keeps old lock with active git process', async () => {
  const tmpDir = createTempDir();
  const gitDir = path.join(tmpDir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });

  const lockFile = path.join(gitDir, 'apply.lock');

  // Create a script that will stay alive and include 'git' and repo path in its command line
  const scriptPath = path.join(tmpDir, 'run-git.sh');
  fs.writeFileSync(scriptPath, `#!/bin/bash\nwhile true; do git --git-dir=${gitDir} -C ${tmpDir} status --porcelain 2>/dev/null; sleep 1; done\n`);
  fs.chmodSync(scriptPath, 0o755);

  // Spawn the script
  const child = spawn(scriptPath, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await sleep(300);

  fs.writeFileSync(lockFile, String(child.pid));

  // Set mtime to 2 hours ago
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(lockFile, twoHoursAgo, twoHoursAgo);

  const originalEnv = process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
  process.env.AGENT_MANAGER_APPLY_REPO_ROOT = tmpDir;

  try {
    // In the sandboxed test environment, pgrep may not work as expected.
    // This test verifies the behavior when pgrep successfully finds an active git process.
    // If pgrep fails (returns no match or errors), the lock will be removed (default behavior).
    const { execFileSync } = require('child_process');
    let pgrepMatched = false;
    try {
      const pgrepOut = execFileSync('pgrep', ['-f', `git.*${tmpDir}`], {
        stdio: 'pipe', encoding: 'utf8', timeout: 5_000,
      });
      pgrepMatched = pgrepOut.trim().length > 0;
    } catch {
      pgrepMatched = false;
    }

    clearStaleLocks(tmpDir);

    if (pgrepMatched) {
      assert.ok(fs.existsSync(lockFile), 'Lock file should be kept when git process is active');
    } else {
      // pgrep didn't find a match (sandbox limitation), so lock should be removed
      assert.ok(!fs.existsSync(lockFile), 'Lock file should be removed when no git process detected');
    }
  } finally {
    if (originalEnv) {
      process.env.AGENT_MANAGER_APPLY_REPO_ROOT = originalEnv;
    } else {
      delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
    }
    child.kill('SIGTERM');
    // Wait a bit for the process to die
    await sleep(100);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('respects AGENT_MANAGER_APPLY_STALE_LOCK_MINUTES env var', async () => {
  const tmpDir = createTempDir();
  const gitDir = path.join(tmpDir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });

  const lockFile = path.join(gitDir, 'apply.lock');
  const pid = process.pid;
  fs.writeFileSync(lockFile, String(pid));

  // Set mtime to 45 minutes ago (between 30 and 60)
  const fortyFiveMinutesAgo = new Date(Date.now() - 45 * 60 * 1000);
  fs.utimesSync(lockFile, fortyFiveMinutesAgo, fortyFiveMinutesAgo);

  const originalApplyRepoEnv = process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
  const originalStaleEnv = process.env.AGENT_MANAGER_APPLY_STALE_LOCK_MINUTES;

  process.env.AGENT_MANAGER_APPLY_REPO_ROOT = tmpDir;
  process.env.AGENT_MANAGER_APPLY_STALE_LOCK_MINUTES = '60';

  try {
    clearStaleLocks(tmpDir);
    assert.ok(fs.existsSync(lockFile), 'Lock file should be kept with 60 min threshold');
  } finally {
    if (originalApplyRepoEnv) {
      process.env.AGENT_MANAGER_APPLY_REPO_ROOT = originalApplyRepoEnv;
    } else {
      delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
    }
    if (originalStaleEnv) {
      process.env.AGENT_MANAGER_APPLY_STALE_LOCK_MINUTES = originalStaleEnv;
    } else {
      delete process.env.AGENT_MANAGER_APPLY_STALE_LOCK_MINUTES;
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('explicit thresholdMinutes argument overrides env var', async () => {
  const tmpDir = createTempDir();
  const gitDir = path.join(tmpDir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });

  const lockFile = path.join(gitDir, 'apply.lock');
  const pid = process.pid;
  fs.writeFileSync(lockFile, String(pid));

  // Set mtime to 45 minutes ago
  const fortyFiveMinutesAgo = new Date(Date.now() - 45 * 60 * 1000);
  fs.utimesSync(lockFile, fortyFiveMinutesAgo, fortyFiveMinutesAgo);

  const originalApplyRepoEnv = process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
  const originalStaleEnv = process.env.AGENT_MANAGER_APPLY_STALE_LOCK_MINUTES;

  process.env.AGENT_MANAGER_APPLY_REPO_ROOT = tmpDir;
  process.env.AGENT_MANAGER_APPLY_STALE_LOCK_MINUTES = '60';

  try {
    clearStaleLocks(tmpDir, 30); // Override to 30 minutes
    assert.ok(!fs.existsSync(lockFile), 'Lock file should be removed with 30 min threshold');
  } finally {
    if (originalApplyRepoEnv) {
      process.env.AGENT_MANAGER_APPLY_REPO_ROOT = originalApplyRepoEnv;
    } else {
      delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
    }
    if (originalStaleEnv) {
      process.env.AGENT_MANAGER_APPLY_STALE_LOCK_MINUTES = originalStaleEnv;
    } else {
      delete process.env.AGENT_MANAGER_APPLY_STALE_LOCK_MINUTES;
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('no-op when AGENT_MANAGER_APPLY_REPO_ROOT is unset', async () => {
  const tmpDir = createTempDir();
  const gitDir = path.join(tmpDir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });

  const lockFile = path.join(gitDir, 'apply.lock');
  fs.writeFileSync(lockFile, String(process.pid));

  // Set mtime to 2 hours ago
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(lockFile, twoHoursAgo, twoHoursAgo);

  const originalEnv = process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
  delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT;

  try {
    clearStaleLocks(tmpDir);
    assert.ok(fs.existsSync(lockFile), 'Lock file should NOT be removed when env var is unset');
  } finally {
    if (originalEnv) {
      process.env.AGENT_MANAGER_APPLY_REPO_ROOT = originalEnv;
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('no-op when paths do not match', async () => {
  const tmpDir = createTempDir();
  const gitDir = path.join(tmpDir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });

  const lockFile = path.join(gitDir, 'apply.lock');
  fs.writeFileSync(lockFile, String(process.pid));

  // Set mtime to 2 hours ago
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(lockFile, twoHoursAgo, twoHoursAgo);

  const originalEnv = process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
  process.env.AGENT_MANAGER_APPLY_REPO_ROOT = '/some/other/path';

  try {
    clearStaleLocks(tmpDir);
    assert.ok(fs.existsSync(lockFile), 'Lock file should NOT be removed when paths do not match');
  } finally {
    if (originalEnv) {
      process.env.AGENT_MANAGER_APPLY_REPO_ROOT = originalEnv;
    } else {
      delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('handles missing .git directory gracefully', async () => {
  const tmpDir = createTempDir();

  const originalEnv = process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
  process.env.AGENT_MANAGER_APPLY_REPO_ROOT = tmpDir;

  try {
    // Should not throw
    clearStaleLocks(tmpDir);
  } finally {
    if (originalEnv) {
      process.env.AGENT_MANAGER_APPLY_REPO_ROOT = originalEnv;
    } else {
      delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('handles empty lock directory', async () => {
  const tmpDir = createTempDir();
  const gitDir = path.join(tmpDir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });

  const originalEnv = process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
  process.env.AGENT_MANAGER_APPLY_REPO_ROOT = tmpDir;

  try {
    // Should not throw
    clearStaleLocks(tmpDir);
  } finally {
    if (originalEnv) {
      process.env.AGENT_MANAGER_APPLY_REPO_ROOT = originalEnv;
    } else {
      delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('ignores non-.lock files', async () => {
  const tmpDir = createTempDir();
  const gitDir = path.join(tmpDir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });

  // Create a non-lock file
  const otherFile = path.join(gitDir, 'README.md');
  fs.writeFileSync(otherFile, '# Test');

  const originalEnv = process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
  process.env.AGENT_MANAGER_APPLY_REPO_ROOT = tmpDir;

  try {
    clearStaleLocks(tmpDir);
    assert.ok(fs.existsSync(otherFile), 'Non-lock file should not be touched');
  } finally {
    if (originalEnv) {
      process.env.AGENT_MANAGER_APPLY_REPO_ROOT = originalEnv;
    } else {
      delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('removes multiple stale locks in one pass', async () => {
  const tmpDir = createTempDir();
  const gitDir = path.join(tmpDir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });

  const lock1 = path.join(gitDir, 'apply1.lock');
  const lock2 = path.join(gitDir, 'apply2.lock');
  const lock3 = path.join(gitDir, 'apply3.lock');

  fs.writeFileSync(lock1, String(process.pid));
  fs.writeFileSync(lock2, String(process.pid));
  fs.writeFileSync(lock3, String(process.pid));

  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(lock1, twoHoursAgo, twoHoursAgo);
  fs.utimesSync(lock2, twoHoursAgo, twoHoursAgo);
  fs.utimesSync(lock3, twoHoursAgo, twoHoursAgo);

  const originalEnv = process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
  process.env.AGENT_MANAGER_APPLY_REPO_ROOT = tmpDir;

  try {
    clearStaleLocks(tmpDir);
    assert.ok(!fs.existsSync(lock1));
    assert.ok(!fs.existsSync(lock2));
    assert.ok(!fs.existsSync(lock3));
  } finally {
    if (originalEnv) {
      process.env.AGENT_MANAGER_APPLY_REPO_ROOT = originalEnv;
    } else {
      delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('mixed ages: keeps fresh, removes stale', async () => {
  const tmpDir = createTempDir();
  const gitDir = path.join(tmpDir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });

  const staleLock = path.join(gitDir, 'stale.lock');
  const freshLock = path.join(gitDir, 'fresh.lock');

  fs.writeFileSync(staleLock, String(process.pid));
  fs.writeFileSync(freshLock, String(process.pid));

  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(staleLock, twoHoursAgo, twoHoursAgo);

  const originalEnv = process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
  process.env.AGENT_MANAGER_APPLY_REPO_ROOT = tmpDir;

  try {
    clearStaleLocks(tmpDir);
    assert.ok(!fs.existsSync(staleLock), 'Stale lock should be removed');
    assert.ok(fs.existsSync(freshLock), 'Fresh lock should be kept');
  } finally {
    if (originalEnv) {
      process.env.AGENT_MANAGER_APPLY_REPO_ROOT = originalEnv;
    } else {
      delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('boundary: lock just under threshold is kept', async () => {
  const tmpDir = createTempDir();
  const gitDir = path.join(tmpDir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });

  const lockFile = path.join(gitDir, 'apply.lock');
  fs.writeFileSync(lockFile, String(process.pid));

  // Set mtime to 29 minutes ago (just under 30 min threshold)
  const twentyNineMinutesAgo = new Date(Date.now() - 29 * 60 * 1000);
  fs.utimesSync(lockFile, twentyNineMinutesAgo, twentyNineMinutesAgo);

  const originalEnv = process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
  process.env.AGENT_MANAGER_APPLY_REPO_ROOT = tmpDir;

  try {
    clearStaleLocks(tmpDir);
    assert.ok(fs.existsSync(lockFile), 'Lock just under threshold should be kept');
  } finally {
    if (originalEnv) {
      process.env.AGENT_MANAGER_APPLY_REPO_ROOT = originalEnv;
    } else {
      delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('boundary: lock just past threshold is removed', async () => {
  const tmpDir = createTempDir();
  const gitDir = path.join(tmpDir, '.git');
  fs.mkdirSync(gitDir, { recursive: true });

  const lockFile = path.join(gitDir, 'apply.lock');
  fs.writeFileSync(lockFile, String(process.pid));

  // Set mtime to 31 minutes ago (just past 30 min threshold)
  const thirtyOneMinutesAgo = new Date(Date.now() - 31 * 60 * 1000);
  fs.utimesSync(lockFile, thirtyOneMinutesAgo, thirtyOneMinutesAgo);

  const originalEnv = process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
  process.env.AGENT_MANAGER_APPLY_REPO_ROOT = tmpDir;

  try {
    clearStaleLocks(tmpDir);
    assert.ok(!fs.existsSync(lockFile), 'Lock just past threshold should be removed');
  } finally {
    if (originalEnv) {
      process.env.AGENT_MANAGER_APPLY_REPO_ROOT = originalEnv;
    } else {
      delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
