# 2026-09-19 gated-main incident

Gated main, RESTATED: main changes only through ONE path, the merge gate, and only with a recorded READY evidence record for that exact head SHA (branch equals reviewed diff, merges cleanly, tests pass on the trial merge, mutants rejected, diff does only what the task asked). Nothing else may push to main: no worker, no plugin, no hand git push. The Kernel enforces the single-path rule; the merge plugin supplies the gate. A human merge is just another caller of the same path. This REPLACES the old "the only way onto main is a human merge".
