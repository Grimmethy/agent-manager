# Poll detector

ADR-0024 ("triggers, not polls", `docs/adr/0024-triggers-not-polls.md`) says new work must name the event that would remove a poll and its measured idle cost. Until now that was advisory text. This detector is the shared, deterministic DEFINITION of a poll, a baseline of today's polls, and a calibration report. **Foundation only: nothing calls it yet.** A later hub wires the pre-merge gate (shadow mode first), the code-generation prompt lines, a periodic scout lane, the idle-cost steward and the merge-ready checker. One definition, defined once, here.

## What counts as a poll

An idle agent-manager pipeline should cost almost nothing, so a poll is code that wakes up on a clock and looks, whether or not anything changed:

- an UNBOUNDED loop that sleeps (`while (true)`, `for (;;)`, `while True`, `while :`, `until <command>`, `while ($true)`, a `:label` closed by a backwards `goto`);
- a timer that re-arms itself or fires on a schedule (`setInterval`, a `setTimeout` that calls its own function, `schedule.every`, a systemd timer, cron).

NOT polls: a loop bounded by an attempt counter or a range (a retry wait), a sleep outside any loop (a one-shot wait), a child-process wait with a timeout, systemd crash supervision (`Restart=on-failure`, `Restart=always` on a long-running service), and every test file (`isTestPath`). Where a loop is nested, the NEAREST enclosing loop decides.

Severity: `poll` is an idle poll (what a future gate counts). `info` is listed but never fails a gate (compose healthcheck intervals, interval-like config keys, watch scripts).

## The annotation

A poll that has no event to replace it is allowed when it says why, in a comment on the same line or the line directly above:

```
// poll-ok: the dashboard has no event source for stale timers
setInterval(updateStaleTimers, 1000);
```

`#` (py, sh, ps1, systemd, yaml, toml), `//` and `/* */` and `<!-- -->` (js, html), `REM` and `::` (bat) and `--` (sql) all work. An EMPTY reason (`// poll-ok:`) does not count.

## Languages and kinds

| Language | Files | Kinds (severity) |
|---|---|---|
| js | .js .mjs .cjs .jsx .ts .tsx, `<script>` blocks of .html | set-interval, self-rearming-timeout, sleep-loop, listing-in-tick (poll) |
| py | .py | sleep-loop, schedule-every, timer-rearm, wait-loop (poll) |
| sh | .sh .bash, extensionless files with a bash/sh shebang | sleep-loop, watch-command (poll) |
| ps1 | .ps1 | sleep-loop, scheduled-task (poll) |
| bat | .bat .cmd | delay-loop, scheduled-task (poll) |
| systemd | .service .timer | timer-unit, restart-loop (poll) |
| yaml | .yml .yaml | cron-schedule (poll), healthcheck-interval (info) |
| sql | .sql | sleep-loop, cron-schedule (poll) |
| config | plugins.json, task-domains.json, package.json, .toml | config-interval, watch-script (info) |

Data and queue JSON, Markdown, text and images are never read. Vendor and generated directories are skipped (`node_modules`, `.venv`, `venv`, `vendor`, `dist`, `build`, `graphify-out`, `task-logs`, `queue`, `__pycache__`).

## The commands

All from the repo root; `node src/poll-detector.js <command>`. Exit 0 ok, 1 an unexpected error (or `--fail-on-new` found a NEW poll), 2 a usage error.

| Command | What it does |
|---|---|
| `scan --root <dir> [--baseline <file>] [--json]` | every finding in the tracked files of the git repo at `<dir>`; with a baseline each is marked `known` |
| `scan --diff <file> [--baseline <file>] [--fail-on-new]` | reads a unified diff, looks at ADDED lines only, prints `{ new, known, annotated }`; with `--fail-on-new` exits 1 when a NEW, un-annotated `poll` exists |
| `baseline --root <dir> --out <file> [--repo <name>]` | writes the baseline of today's un-annotated findings |
| `calibrate [--projects <projects.json>] [--sample 30] [--repos a,b] [--out <file>] [--json]` | scans every `pool: true` project and prints counts per language and per repo plus up to `--sample` findings per language with the matching source line. It reads a few thousand files: expect minutes on this disk (about 30 seconds for agent-manager alone). Progress goes to stderr |

A check of a branch, the way a gate would do it:

```
git diff origin/master...HEAD > /tmp/branch.diff
node src/poll-detector.js scan --diff /tmp/branch.diff --baseline docs/poll-baseline.json --fail-on-new
```

## The baseline

`docs/poll-baseline.json` holds `{ version: 1, repo, findings: [ { signature, path, kind, language } ] }` for agent-manager, sorted by path, kind, signature, so two runs give identical bytes. A finding is KNOWN when its `signature` is in the baseline. The signature is `sha1(path | kind | the snippet with comments stripped and whitespace collapsed)`: it has NO line number, so moving a poll to another line does not make it new, while changing its code does.

One limit to know: identical code lines in the same file share a signature, so the baseline holds ONE entry for them (agent-manager's `scripts/local-worker.sh` has several identical `sleep` lines) and a NEW copy of an already-known line in that file reads as known. The `scan` output still lists every line.

Refresh it after a deliberate change (a poll removed, or one accepted without an annotation):

```
node src/poll-detector.js baseline --root . --repo agent-manager --out docs/poll-baseline.json
git diff docs/poll-baseline.json     # added entries are new polls, removed entries are polls that went away
```

Review the diff before committing it: a baseline that only grows is a baseline that stopped meaning anything.

## Adding a language or a rule

1. Add `src/lib/poll-rules/<language>.rules.js` exporting `{ languages: ['<language>'], rules: [ { kind, severity, test(ctx) } ] }`. `ctx` is `{ lines, index, language, path }` (the whole file split on newlines and the line under test); `test` returns `false` or a short snippet string. The loader (`loadRules`) LISTS that directory, so adding the file is enough for the rules; a rule file that throws on load is skipped and its error is reported in `loadErrors`.
2. If the language has new file extensions, map them in `languageOf` in `src/lib/poll-detector.js`.
3. Write `<language>.rules.test.js` next to it: a positive fixture per kind (a real line from a pooled repo when one exists, labelled SYNTHETIC when not), negatives for every false positive you can think of, and a check that fails if the rule is removed from the table. Run `scripts/mutate_strict.py`-style mutants over the rule file before you trust it.

## The provisional gate rule

**This is the author's default, changeable by the owner. This work sets no threshold.** The owner could not choose one from the data available, so the calibration report prints counts and samples only. The future pre-merge gate stays in SHADOW mode (it logs `would block` and blocks nothing) until a labelled sample of at least 50 flagged hits shows under 10% false positives. To label a sample: run `calibrate`, read each sampled line with its surrounding code, and mark it a real idle poll or not. Only then does the owner decide whether the gate may block.

## Files

`src/lib/poll-detector.js` (the contract and the scanner), `src/lib/poll-rules/*.rules.js` (one table per language), `src/lib/poll-calibrate.js` (the summary), `src/poll-detector.js` (the command line), `docs/poll-baseline.json`. The two library files import nothing from the rest of agent-manager, so they can move into the Grimmethy/triggers repo unchanged, like `src/queue-events.js`.
