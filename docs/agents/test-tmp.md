# Test temp directory (RAM-backed)

`/tmp` on this machine is on the shared spinning disk, and test suites create thousands of throwaway git repos and temp dirs there. Every `git init` and `git clone` fsyncs: one 150 s sample on 2026-11-03 showed the disk at 100% busy with about 4,600 write IOPS, which stalled every lane (ADR-0024).

`scripts/with-test-tmp.js` runs a command with `TMPDIR`, `TEMP` and `TMP` pointing at a run directory on `/dev/shm` (RAM). Node's `os.tmpdir()` and Python's `tempfile` both read `TMPDIR`, so the suites need no edits.

```
npm test                                                          # already goes through it
node scripts/with-test-tmp.js node --test src/foo.test.js         # a single suite
node scripts/with-test-tmp.js python3 -m unittest test_foo        # python works too
```

Measured on `src/branch-*` (3 suites, 45 tests): 33 s and about 3,900 disk writes on `/tmp`; 17 s and about 900 on `/dev/shm`; the same 45 tests pass.

| Setting | Default | Meaning |
|---|---|---|
| `AGENT_MANAGER_TEST_TMP` | `/dev/shm/agent-manager-test` | base directory; `off` runs the command unchanged |
| `AGENT_MANAGER_TEST_TMP_MAX_MB` (or `--max-mb`) | 1024 | one run's cap; over it the command is stopped with exit code 3 |
| `AGENT_MANAGER_TEST_TMP_MIN_FREE_MB` | 1024 | free space required on the base filesystem, else the command runs unchanged with a notice |
| `AGENT_MANAGER_TEST_TMP_POLL_MS` | 10000 | how often the cap is checked |

`/dev/shm` is RAM (half of the machine's memory is the tmpfs limit, but only what is used counts), so the cap matters. The run directory is removed when the command ends, is interrupted, or exceeds the cap; run directories left by a crashed launcher (pid gone, older than 5 minutes) are removed at the next start.

To redirect any other test run without the launcher: `export TMPDIR=/dev/shm/my-run && mkdir -p $TMPDIR` and remove it afterwards.
