#!/usr/bin/env python3
"""idle-cost-audit.py -- how much does the pipeline cost when nothing is happening? (ADR-0024 stage S2)

Samples /proc for DURATION seconds and prints, per minute: how many node / python / git processes were started, grouped by the lane or daemon
that started them (queue-watcher, each local-worker instance, review-runner, apply-loop, dashboard app.py, forge plugin servers, Claude
sessions, other) and by script; plus the shared disk's read/write IOPS, MB/s and busy percent (/proc/diskstats) and total forks per minute
(/proc/stat). Read-only, stdlib only, no root, writes nothing unless --out is given.

Counts are a LOWER BOUND: a process that starts and exits between two samples is missed (default interval 0.2 s). Use the same interval when
comparing a before and an after.

  python3 scripts/idle-cost-audit.py --duration 120 [--disk sdb] [--interval 0.2] [--out result.json] [--proc-root /proc]
"""
import argparse
import collections
import json
import os
import sys
import time

LANE_SCRIPTS = ('queue-watcher.sh', 'local-worker.sh', 'review-runner.sh', 'apply-loop.sh', 'ornith-worker.sh', 'launch.sh')


def read_bytes(root, pid, name):
    try:
        with open(os.path.join(root, str(pid), name), 'rb') as f:
            return f.read()
    except OSError:
        return b''


def ppid_and_start(root, pid):
    """(parent pid, start time ticks) from /proc/<pid>/stat, or (None, None) when the process is gone."""
    s = read_bytes(root, pid, 'stat').decode('utf8', 'replace')
    if ')' not in s:
        return None, None
    fields = s.rsplit(')', 1)[1].split()
    if len(fields) < 20:
        return None, None
    return int(fields[1]), fields[19]


def cmdline(root, pid):
    return [x.decode('utf8', 'replace') for x in read_bytes(root, pid, 'cmdline').split(b'\0') if x]


def script_label(args):
    """'git fetch origin' / 'node pool-projects.js' for the processes worth counting, else None."""
    if not args:
        return None
    exe = os.path.basename(args[0])
    if exe == 'git':
        return 'git ' + ' '.join(a for a in args[1:4] if not a.startswith('-'))[:30]
    if exe in ('node', 'python', 'python3') or exe.startswith('python'):
        for a in args[1:]:
            if not a.startswith('-'):
                return exe + ' ' + ' '.join(os.path.basename(a).split())[:45]
    return None


def origin_of(root, pid):
    """Which lane or daemon started this process, found by walking up its ancestors."""
    q = pid
    for _ in range(25):
        args = cmdline(root, q)
        joined = ' '.join(args)
        if args and os.path.basename(args[0]) == 'claude':
            return 'CLAUDE-SESSION'
        for name in LANE_SCRIPTS:
            if name in joined:
                inst = [a for a in args if a.startswith('worker-') or a.startswith('reviewer-')]
                return name + (' ' + inst[0] if inst else '')
        if 'dashboard/app.py' in joined:
            return 'dashboard app.py'
        if 'plugin' in joined and 'server' in joined:
            return 'forge plugin server'
        if 'ollama' in joined:
            return 'ollama'
        parent, _ = ppid_and_start(root, q)
        if not parent or parent <= 1:
            break
        q = parent
    return 'other'


def disk_counters(root, disk):
    """(reads, sectors read, writes, sectors written, io ms) for one disk, or None."""
    try:
        with open(os.path.join(root, 'diskstats')) as f:
            for line in f:
                p = line.split()
                if len(p) > 12 and p[2] == disk:
                    return int(p[3]), int(p[5]), int(p[7]), int(p[9]), int(p[12])
    except OSError:
        pass
    return None


def fork_counter(root):
    try:
        with open(os.path.join(root, 'stat')) as f:
            for line in f:
                if line.startswith('processes'):
                    return int(line.split()[1])
    except OSError:
        pass
    return None


def sample(root, duration, interval, disk):
    seen = set()
    by_origin = collections.Counter()
    by_script = collections.defaultdict(collections.Counter)
    d0, f0, t0 = disk_counters(root, disk), fork_counter(root), time.time()
    # Processes that already exist at the start are not launches: mark them seen first.
    for p in os.listdir(root):
        if p.isdigit():
            _, st = ppid_and_start(root, p)
            if st is not None:
                seen.add((p, st))
    while time.time() - t0 < duration:
        for p in os.listdir(root):
            if not p.isdigit():
                continue
            _, st = ppid_and_start(root, p)
            if st is None or (p, st) in seen:
                continue
            seen.add((p, st))
            label = script_label(cmdline(root, p))
            if not label:
                continue
            origin = origin_of(root, int(p))
            by_origin[origin] += 1
            by_script[origin][label] += 1
        time.sleep(interval)
    elapsed = max(time.time() - t0, 1e-9)
    d1, f1 = disk_counters(root, disk), fork_counter(root)
    per_min = 60.0 / elapsed
    result = {
        'seconds': round(elapsed, 1),
        'launches_per_min_by_origin': {k: round(v * per_min, 1) for k, v in by_origin.most_common()},
        'launches_per_min_by_script': {o: {k: round(v * per_min, 1) for k, v in c.most_common(12)} for o, c in by_script.items()},
    }
    if f0 is not None and f1 is not None:
        result['forks_per_min'] = round((f1 - f0) * per_min)
    if d0 and d1:
        result['disk'] = {
            'name': disk,
            'read_iops': round((d1[0] - d0[0]) / elapsed, 1),
            'read_MBps': round((d1[1] - d0[1]) * 512 / 1e6 / elapsed, 2),
            'write_iops': round((d1[2] - d0[2]) / elapsed, 1),
            'write_MBps': round((d1[3] - d0[3]) * 512 / 1e6 / elapsed, 2),
            'busy_pct': round((d1[4] - d0[4]) / (elapsed * 10), 1),
        }
    return result


def main(argv=None):
    ap = argparse.ArgumentParser(description='Idle-cost audit: process launches per minute by origin, plus shared-disk load.')
    ap.add_argument('--duration', type=float, default=120)
    ap.add_argument('--interval', type=float, default=0.2)
    ap.add_argument('--disk', default='sdb')
    ap.add_argument('--proc-root', default='/proc')
    ap.add_argument('--out', default=None, help='also write the JSON result to this file')
    a = ap.parse_args(argv)
    result = sample(a.proc_root, a.duration, a.interval, a.disk)
    text = json.dumps(result, indent=2)
    print(text)
    if a.out:
        with open(a.out, 'w') as f:
            f.write(text + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
