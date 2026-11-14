'use strict';

// scripts/memory-pressure-report.js over canned /proc text, and the pin that it only reads. Run: node --test scripts/memory-pressure-report.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const R = require('./memory-pressure-report.js');

const STATUS = (name, kb) => `Name:\t${name}\nVmPeak:\t${kb + 100} kB\nVmRSS:\t${kb} kB\nThreads:\t1\n`;
const PSI_MEM = 'some avg10=1.50 avg60=2.00 avg300=3.25 total=1000\nfull avg10=0.50 avg60=0.75 avg300=1.00 total=500\n';
const PSI_IO = 'some avg10=6.21 avg60=5.73 avg300=7.20 total=9\nfull avg10=4.17 avg60=4.17 avg300=3.95 total=8\n';
const MEMINFO = 'MemTotal:       20480000 kB\nMemFree:         1000 kB\nMemAvailable:    5120000 kB\nSwapTotal:       6144000 kB\nSwapFree:        102400 kB\n';

function fakeProc() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memrep-'));
  const proc = path.join(root, 'proc');
  const put = (rel, text) => { const f = path.join(proc, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  put('meminfo', MEMINFO); put('pressure/memory', PSI_MEM); put('pressure/io', PSI_IO);
  put('100/status', STATUS('qemu-system-x86', 4194304)); put('100/cmdline', '/usr/bin/qemu-system-x86_64\x00-name\x00guest=p40\x00');
  put('200/status', STATUS('llama-server', 3145728)); put('200/cmdline', '/usr/local/lib/ollama/llama-server\x00--model\x00/models/blobs/sha256-abc\x00--port\x00123\x00');
  put('300/status', STATUS('bash', 5120)); put('300/cmdline', 'bash\x00-c\x00echo ollama llama-server --model /fake\x00');
  put('400/status', STATUS('bash', 102400)); put('400/cmdline', 'bash\x00/x/agent-manager/scripts/local-worker.sh\x00worker-3090\x00');
  put('500/status', STATUS('ollama', 204800)); put('500/cmdline', '/usr/local/bin/ollama\x00serve\x00'); put('500/environ', 'HOME=/root\x00OLLAMA_KEEP_ALIVE=30m\x00');
  put('600/status', 'Name:\tkthreadd\n');                               // a kernel thread has no VmRSS: skipped
  put('700/status', STATUS('claude', 307200)); put('700/cmdline', 'claude\x00');
  const marker = path.join(root, 'marker.json'); fs.writeFileSync(marker, JSON.stringify({ state: 'critical', reason: 'holding until pressure eases' }));
  return { root, proc, marker };
}

test('parseStatusRssKb, parsePressure, parseMeminfo and parseMarker read the canned /proc text', () => {
  assert.equal(R.parseStatusRssKb(STATUS('x', 2048)), 2048);
  assert.equal(R.parseStatusRssKb('Name:\tkthreadd\n'), null);
  assert.deepEqual(R.parsePressure(PSI_IO), { some: { avg10: 6.21, avg60: 5.73, avg300: 7.2, total: 9 }, full: { avg10: 4.17, avg60: 4.17, avg300: 3.95, total: 8 } });
  assert.deepEqual(R.parsePressure(''), {});
  assert.deepEqual(R.parseMeminfo(MEMINFO), { memTotalMb: 20000, memAvailableMb: 5000, swapTotalMb: 6000, swapFreeMb: 100, swapUsedMb: 5900 });
  assert.deepEqual(R.parseMarker('{"state":"tight","reason":"r"}', 1000, 6000), { state: 'tight', reason: 'r', ageSeconds: 5 });
  assert.equal(R.parseMarker('not json', 0, 0), null);
});

test('classify groups pipeline commands apart from the rest; trimCmd cuts to 80 characters; modelOf only trusts a llama-server --model', () => {
  assert.equal(R.classify('bash /x/agent-manager/scripts/local-worker.sh worker-3090'), 'lane scripts');
  assert.equal(R.classify('/usr/local/lib/ollama/llama-server --model /m'), 'ollama / llama-server');
  assert.equal(R.classify('/usr/bin/qemu-system-x86_64 -name guest=p40'), 'qemu');
  assert.equal(R.classify('/opt/brave.com/brave/brave --type=renderer'), 'browsers');
  assert.equal(R.classify('claude'), null);
  assert.equal(R.trimCmd('a'.repeat(200)).length, 80);
  assert.equal(R.trimCmd('short  one'), 'short one');
  assert.equal(R.modelOf('/usr/local/lib/ollama/llama-server --model /blobs/sha256-x --port 1'), '/blobs/sha256-x');
  assert.equal(R.modelOf('bash -c echo ollama llama-server --model /fake'), null, 'text that merely mentions a model is not a model');
});

test('buildReport over a canned /proc tree: sorted by RSS, grouped, models and keep_alive, marker, pressure and swap', () => {
  const w = fakeProc();
  const now = fs.statSync(w.marker).mtimeMs + 4000;
  const r = R.buildReport({ procRoot: w.proc, markerPath: w.marker, nowMs: now, top: 3 });
  assert.deepEqual(r.marker, { state: 'critical', reason: 'holding until pressure eases', ageSeconds: 4 });
  assert.deepEqual(r.top.map((t) => [t.pid, t.rssMb, t.group]), [[100, 4096, 'qemu'], [200, 3072, 'ollama / llama-server'], [700, 300, 'other']]);
  assert.equal(r.models.length, 1);
  assert.deepEqual([r.models[0].pid, r.models[0].model], [200, '/models/blobs/sha256-abc']);
  assert.equal(r.groups['lane scripts'].rssMb, 100);
  assert.equal(r.groups['ollama / llama-server'].count, 3, 'the runner, the ollama server and the shell that mentions both match the ollama pattern');
  assert.equal(r.memory.swapUsedMb, 5900);
  assert.equal(r.pressure.io.full.avg10, 4.17);
  const text = R.format(r);
  assert.match(text, /broker marker: critical \(4s old\)/);
  assert.match(text, /top processes by RSS:/);
  assert.match(text, /swap used 5900 MB of 6000 MB/);
  assert.equal(R.buildReport({ procRoot: path.join(w.root, 'nope'), markerPath: path.join(w.root, 'nomarker') }).marker, null, 'a missing /proc or marker never throws');
});

test('the report performs no write and sends no signal: every write, delete, spawn and kill call throws while it runs', () => {
  const w = fakeProc();
  const boom = (name) => () => { throw new Error(`forbidden call: ${name}`); };
  const fsNames = ['writeFileSync', 'appendFileSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'mkdirSync', 'renameSync', 'copyFileSync', 'truncateSync', 'utimesSync', 'chmodSync', 'symlinkSync', 'writeSync', 'openSync'];
  const cpNames = ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'];
  const saved = [];
  const stub = (obj, k, label) => { const orig = obj[k]; saved.push([obj, k, orig]); if (k === 'openSync') { obj[k] = (p, flags, ...rest) => { if (flags && flags !== 'r') throw new Error(`forbidden open flags ${flags}`); return orig.call(obj, p, flags, ...rest); }; } else obj[k] = boom(label + k); };
  try {
    for (const k of fsNames) stub(fs, k, 'fs.');
    for (const k of cpNames) stub(childProcess, k, 'child_process.');
    stub(process, 'kill', 'process.');
    const r = R.buildReport({ procRoot: w.proc, markerPath: w.marker });
    assert.ok(R.format(r).length > 0);
  } finally { for (const [obj, k, orig] of saved.reverse()) obj[k] = orig; }
  // and the source itself names none of them
  const src = fs.readFileSync(path.join(__dirname, 'memory-pressure-report.js'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  for (const word of ['writeFile', 'appendFile', 'unlink', 'rmSync', 'child_process', 'process.kill', 'spawn', 'execSync', 'execFile', '.kill(']) assert.ok(!src.includes(word), `source must not contain ${word}`);
});
