'use strict';

// scripts/idle-cost-audit.py is the repeatable form of the ADR-0024 S2 measurement. It reads /proc, so the test hands it a FAKE /proc
// tree (--proc-root) and adds processes to it while it samples:
//   - a node child of a local-worker.sh instance      -> counted under "local-worker.sh worker-x"
//   - a git child of a claude session                 -> counted under CLAUDE-SESSION
//   - a process that existed before sampling started  -> NOT counted (it is not a launch)
//   - a bash process (not node/python/git)            -> NOT counted
//   - disk counters move between the first and last read -> IOPS / MB/s / busy percent come out as computed
// It also asserts the script writes nothing when --out is not given.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, 'idle-cost-audit.py');

function addProc(root, pid, ppid, args, start) {
  const dir = path.join(root, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  // /proc/<pid>/stat: "pid (comm) S ppid ..." with the start time as field 22 overall (index 19 after the closing paren).
  const after = ['S', String(ppid), ...Array(16).fill('0'), String(start)];
  fs.writeFileSync(path.join(dir, 'stat'), `${pid} (x) ${after.join(' ')} 0 0\n`);
  fs.writeFileSync(path.join(dir, 'cmdline'), args.join('\0') + '\0');
}

function diskLine(reads, sectorsRead, writes, sectorsWritten, ioMs) {
  // major minor name reads merged sectors_read ms_read writes merged sectors_written ms_write inflight io_ms ...
  return `   8   16 sdb ${reads} 0 ${sectorsRead} 0 ${writes} 0 ${sectorsWritten} 0 0 ${ioMs} 0\n`;
}

test('counts launches by origin, ignores pre-existing and non-counted processes, and reports disk load', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idlecost-'));
  try {
    fs.writeFileSync(path.join(root, 'stat'), 'cpu 1 1 1 1\nprocesses 1000\n');
    fs.writeFileSync(path.join(root, 'diskstats'), diskLine(100, 2000, 200, 4000, 1000));
    addProc(root, 10, 1, ['bash', '/x/scripts/local-worker.sh', 'worker-x'], 1);        // lane loop, exists before sampling
    addProc(root, 20, 1, ['claude'], 2);                                                 // a claude session
    addProc(root, 30, 10, ['node', '/x/src/old-process.js'], 3);                         // pre-existing node child: not a launch

    const child = spawn('python3', ['-I', SCRIPT, '--duration', '1.2', '--interval', '0.05', '--disk', 'sdb', '--proc-root', root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    await new Promise((r) => setTimeout(r, 400));
    addProc(root, 40, 10, ['node', '/x/src/pool-projects.js', '--labels'], 4);           // counted: node under the lane
    addProc(root, 41, 10, ['bash', '-c', 'true'], 5);                                    // not counted: bash
    addProc(root, 50, 20, ['git', 'fetch', 'origin'], 6);                                // counted: git under claude
    fs.writeFileSync(path.join(root, 'stat'), 'cpu 1 1 1 1\nprocesses 1090\n');
    fs.writeFileSync(path.join(root, 'diskstats'), diskLine(220, 4000, 1400, 14000, 1600));
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 0);

    const r = JSON.parse(out);
    assert.deepEqual(Object.keys(r.launches_per_min_by_origin).sort(), ['CLAUDE-SESSION', 'local-worker.sh worker-x']);
    assert.ok(r.launches_per_min_by_origin['local-worker.sh worker-x'] > 0);
    assert.ok('node pool-projects.js' in r.launches_per_min_by_script['local-worker.sh worker-x']);
    assert.ok('git fetch origin' in r.launches_per_min_by_script['CLAUDE-SESSION']);
    assert.equal('node old-process.js' in (r.launches_per_min_by_script['local-worker.sh worker-x'] || {}), false);
    assert.equal(r.disk.name, 'sdb');
    assert.ok(r.disk.write_iops > r.disk.read_iops, 'writes dominate in the fixture');
    assert.ok(r.disk.busy_pct > 0 && r.disk.busy_pct <= 100, `busy ${r.disk.busy_pct}`);
    assert.ok(r.forks_per_min > 0);
    assert.equal(fs.existsSync(path.join(root, 'out.json')), false, 'no output file unless --out is given');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
