<!-- HUB-BRANCH-ASSUMPTIONS:START -->
```text
python/dashboard/app.py:2236  hub_for_branch  def _hub_for_branch(qdir, branch, commit_task_ids):
python/dashboard/app.py:2279  hub_for_branch  (used only by _hub_for_branch / tests), not something a caller reaches directly."""
python/dashboard/app.py:2281  hub_for_branch  hub_for_branch = staticmethod(_hub_for_branch)
python/dashboard/app.py:2328  agent/decompose-  # A stacked file-decompose branch (agent/decompose-<slug>) carries N tasks, not
python/dashboard/app.py:2331  hub_for_branch  hub = get_hub_data_provider().hub_for_branch(qdir, f"agent/{task_id}", [])
python/dashboard/app.py:2344  readyToMerge  + (" -- ready to merge" if hub["readyToMerge"] and hub["state"] != "done" else "" if hub["readyToMerge"] else " -- not ready to merge")
python/dashboard/app.py:2470  hub_for_branch  hub = get_hub_data_provider().hub_for_branch(qdir, branch, list(dict.fromkeys([task_id, *trailers])))
python/dashboard/app.py:2494  readyToMerge  # integration-gate status + a `readyToMerge` flag the UI uses to warn before a
python/dashboard/app.py:2511  hub_for_branch  branch_verdicts.enrich_branches_with_verdicts(qdir, repo_root, branches, _run_git, hub_lookup=get_hub_data_provider().hub_for_branch)
python/dashboard/app.py:2521  hub_for_branch  branch_verdicts.enrich_branches_with_verdicts(qdir, repo_root, branches, _run_git, hub_lookup=get_hub_data_provider().hub_for_branch)
python/dashboard/app.py:2548  hub_for_branch  bv.enrich_branches_with_verdicts(qdir, repo_root, branches, _run_git, hub_lookup=get_hub_data_provider().hub_for_branch)
python/dashboard/app_branch_helpers.py:168  hubSiblingConflicts  """Mutates `branches` in place, adding `hubSiblingConflicts: [branch, ...]` to any
python/dashboard/app_branch_helpers.py:186  hubSiblingConflicts  b["hubSiblingConflicts"] = []
python/dashboard/app_branch_helpers.py:201  hubSiblingConflicts  b["hubSiblingConflicts"] = conflicts_with
python/dashboard/app_branch_helpers.py:441  readyToMerge  "readyToMerge": bool(state == "done" or (all_children_built and gate_clear and abandon_clear)),
python/dashboard/app_branch_helpers.py:449  readyToMerge  # readyToMerge, so the whole hub reaches verification together. Held: hubs whose children a model decomposed (manual / derived_task, in ANY domain: a
python/dashboard/app_branch_helpers.py:463  readyToMerge  if hub.get("state") != "coordinating" or hub.get("readyToMerge") or hub.get("branch"):
python/dashboard/app_branch_helpers.py:494  agent/decompose-  (agent/decompose-<hub> carries HUB0113-01-...), so the trailers are what let the listing find the owning hub -- the same join
python/dashboard/branch_verdicts.py:282  hub_for_branch  (app.py's hub_for_branch, via get_hub_data_provider) names the hub. The branch NAME is not that id for
python/dashboard/branch_verdicts.py:283  agent/decompose-  hub sub-task branches (agent/decompose-function-length-fix-ac-12 carries task HUB0063-02-...), so it is
python/dashboard/branch_verdicts.py:406  hubSiblingConflicts  if b.get("hubSiblingConflicts"):
python/dashboard/branch_verdicts.py:407  hubSiblingConflicts  extra.append("would conflict with unmerged hub sibling(s): " + ", ".join(b["hubSiblingConflicts"]))
python/dashboard/hub_index.py:2  hub_for_branch  list still cost ~9 s of CPU on the core repo because _hub_for_branch globbed the coordinating/done/superseded folders and parsed EVERY hub record, once per bran
python/dashboard/routes/branch_verdicts.py:87  hub_for_branch  get_hub_data_provider().hub_for_branch, match.get("taskId"))
python/dashboard/routes/branch_verdicts.py:201  hub_for_branch  get_hub_data_provider().hub_for_branch, match.get("taskId"))
python/dashboard/routes/pipeline_1_more.py:565  hub_for_branch  hub = get_hub_data_provider().hub_for_branch(qdir, branch, commit_task_ids)
python/dashboard/routes/pipeline_1_more.py:618  hubSiblingConflicts  sibling_conflicts = [s for s in (match.get("hubSiblingConflicts") or [])
python/dashboard/routes/pipeline_1_more.py:633  readyToMerge  if hub and not hub.get("readyToMerge") and not force:
python/dashboard/routes/task.py:260  readyToMerge  readyToMerge; before this route nothing could set the flag. The hub worker uses it after it has either replaced the abandoned piece (the
python/dashboard/routes/task.py:298  readyToMerge  A hub's piece list is fixed when it is decomposed, and `_summarize_hub` computes readyToMerge from it, so a corrective piece filed by hand
python/dashboard/static/js/branches-joblist-hardware-tabs.js:30  readyToMerge  const hubMidFlight = b.hub && !b.hub.readyToMerge;
python/dashboard/static/js/branches-joblist-hardware-tabs.js:330  readyToMerge  if (!hub.readyToMerge) {
python/dashboard/static/js/held-hubs-toggle.test.js:12  agent/decompose-  const hub = (n, extra = {}) => ({ hubId: 'h' + n, title: `HUB000${n} · feature ${n}`, progress: { built: 1, done: 0, total: 3 }, waitingOn: [`HUB000${n}-02`], b
python/dashboard/test_branch_verdict_endpoint.py:93  agent/decompose-  # The real shape: branch agent/decompose-function-length-fix-ac-12 carries task HUB0063-02-..., owned by hub function-length-fix-ac-12.
python/dashboard/test_branch_verdict_endpoint.py:99  agent/decompose-  branch = {"branch": "agent/decompose-function-length-fix-ac-12", "taskId": "decompose-function-length-fix-ac-12",
python/dashboard/test_branch_verdict_endpoint.py:118  agent/decompose-  branch = {"branch": "agent/decompose-hub-x", "taskId": "decompose-hub-x", "headSha": "sha-D", "hub": None, "mainBranch": "master"}
python/dashboard/test_branch_verdict_endpoint.py:127  agent/decompose-  self.assertEqual(pv["branch"], "agent/decompose-hub-x")
python/dashboard/test_branch_verdicts.py:383  agent/decompose-  self._branch_with_trailer("agent/decompose-x", "Task: HUB0001-02-real-id (adhoc/manual)")
python/dashboard/test_branch_verdicts.py:384  agent/decompose-  ids, hub = bv.resolve_owner(self.fx.work, "master", "agent/decompose-x", run_git, self.fx.queue, None, "decompose-x")
python/dashboard/test_branch_verdicts.py:389  agent/decompose-  self._branch_with_trailer("agent/decompose-x", "Task: HUB0001-02-real-id (adhoc/manual)")
python/dashboard/test_branch_verdicts.py:395  agent/decompose-  ids, hub = bv.resolve_owner(self.fx.work, "master", "agent/decompose-x", run_git, self.fx.queue, lookup, "decompose-x")
python/dashboard/test_branch_verdicts.py:397  agent/decompose-  self.assertEqual((seen["branch"], seen["ids"]), ("agent/decompose-x", ["HUB0001-02-real-id", "decompose-x"]))
python/dashboard/test_git_merge_endpoint_gates.py:44  readyToMerge  return {"id": "hub-x", "readyToMerge": False, "progress": {"done": 1, "total": 3}, "integrationGate": {"status": "failed"}}
python/dashboard/test_git_merge_endpoint_gates.py:83  hubSiblingConflicts  self._setup([_branch(hubSiblingConflicts=[SIBLING]), {"branch": SIBLING}])
python/dashboard/test_git_merge_endpoint_gates.py:93  hubSiblingConflicts  self._setup([_branch(hubSiblingConflicts=[SIBLING])], lock={"side_effect": RuntimeError("busy")})
python/dashboard/test_git_merge_endpoint_gates.py:99  hubSiblingConflicts  self._setup([_branch(hubSiblingConflicts=[SIBLING], hub=_unfinished_hub()), {"branch": SIBLING}])
python/dashboard/test_git_merge_endpoint_gates.py:114  hubSiblingConflicts  self._setup([_branch(hubSiblingConflicts=[SIBLING], hub=_unfinished_hub()), {"branch": SIBLING}],
python/dashboard/test_held_hub_branches.py:72  agent/decompose-  hub = two_child_hub("open", branch="agent/decompose-x")
python/dashboard/test_held_hub_branches.py:73  agent/decompose-  listed, _ = app.partition_held_hub_branches([branch("agent/decompose-x", hub)])
python/dashboard/test_hold_all_hubs.py:57  agent/decompose-  listed, _ = partition(hub("manual", "default", branch="agent/decompose-x"))
python/dashboard/test_hold_all_hubs.py:70  readyToMerge  self.assertFalse(h["readyToMerge"])
python/dashboard/test_hold_all_hubs.py:75  readyToMerge  self.assertTrue(h["readyToMerge"])
python/dashboard/test_hold_all_hubs.py:79  readyToMerge  self.assertFalse(h["readyToMerge"])
python/dashboard/test_hold_all_hubs.py:83  readyToMerge  self.assertTrue(h["readyToMerge"])
python/dashboard/test_hold_all_hubs.py:89  readyToMerge  self.assertTrue(h["readyToMerge"])
python/dashboard/test_hub_add_piece_route.py:20  agent/decompose-  BRANCH = "agent/decompose-adhoc-big-task-111"
python/dashboard/test_hub_add_piece_route.py:59  readyToMerge  self.assertTrue(before["readyToMerge"])
python/dashboard/test_hub_add_piece_route.py:65  readyToMerge  self.assertFalse(after["readyToMerge"], "the hub must wait for the added piece")
python/dashboard/test_hub_add_piece_route.py:86  readyToMerge  self.assertFalse(app._summarize_hub(self.hub_now(), "coordinating")["readyToMerge"])
python/dashboard/test_hub_data_route.py:3  hub_for_branch  split-coverage-judging-route.js). Default = today's file-based _hub_for_branch /
python/dashboard/test_hub_data_route.py:23  hub_for_branch  self.assertIs(provider.hub_for_branch, app._hub_for_branch)
python/dashboard/test_hub_data_route.py:28  hub_for_branch  def hub_for_branch(self, qdir, branch, commit_task_ids):
python/dashboard/test_hub_data_route.py:37  hub_for_branch  self.assertEqual(app.get_hub_data_provider().hub_for_branch(None, "x", []), {"fake": True})
python/dashboard/test_hub_data_route.py:43  hub_for_branch  self.assertIs(provider.hub_for_branch, app._hub_for_branch)
python/dashboard/test_hub_data_route.py:48  hub_for_branch  get_hub_data_provider().hub_for_branch -- this proves an override actually reaches it,
python/dashboard/test_hub_data_route.py:63  hub_for_branch  def hub_for_branch(self, qdir, branch, commit_task_ids):
python/dashboard/test_hub_data_route.py:70  readyToMerge  "readyToMerge": False,
python/dashboard/test_hub_data_route.py:80  agent/decompose-  self.assertEqual(fake.seen_branch, "agent/decompose-x")
python/dashboard/test_hub_index.py:52  agent/decompose-  self.put("coordinating/a.json", self.hub("A", branch="agent/decompose-a", subs=["A-01"]))
python/dashboard/test_hub_index.py:54  agent/decompose-  self.assertEqual(self.find("agent/decompose-a"), ("A", "coordinating"))
python/dashboard/test_hub_index.py:179  hub_for_branch  """_hub_for_branch answers identically with the index and with the old file scan."""
python/dashboard/test_hub_index.py:183  hub_for_branch  fast = app._hub_for_branch(self.q, branch, ids)
python/dashboard/test_hub_index.py:185  hub_for_branch  slow = app._hub_for_branch(self.q, branch, ids)
python/dashboard/test_hub_index.py:189  agent/decompose-  self.put("coordinating/a.json", self.hub("A", branch="agent/decompose-a", subs=["A-01", "A-02"]))
python/dashboard/test_hub_index.py:195  agent/decompose-  probes = [("agent/decompose-a", []), ("agent/t-9", []), ("agent/t-9", ["T-9"]), ("agent/x", ["T-9"]), ("agent/x", ["T-9", "D-01"]), ("agent/x", ["B-01"]), ("age
python/dashboard/test_hub_index.py:204  hub_for_branch  self.assertIsNone(app._hub_for_branch(None, "agent/x", []))
python/dashboard/test_hub_sibling_conflict.py:9  hubSiblingConflicts  `hubSiblingConflicts` on each branch, and a merge-endpoint gate that blocks (unless
python/dashboard/test_hub_sibling_conflict.py:131  hubSiblingConflicts  self.assertEqual(branches[task_a]["hubSiblingConflicts"], [f"agent/{task_b}"])
python/dashboard/test_hub_sibling_conflict.py:132  hubSiblingConflicts  self.assertEqual(branches[task_b]["hubSiblingConflicts"], [f"agent/{task_a}"])
python/dashboard/test_hub_sibling_conflict.py:196  hubSiblingConflicts  self.assertEqual(branches[task_b]["hubSiblingConflicts"], [],
python/dashboard/test_hub_summary.py:5  readyToMerge  `progress.built` adds finished-but-awaiting-merge; readyToMerge = every piece built (+ integration gate clear). The phase per piece comes from
python/dashboard/test_hub_summary.py:32  readyToMerge  self.assertFalse(h["readyToMerge"], "one piece is still open")
python/dashboard/test_hub_summary.py:41  readyToMerge  self.assertTrue(h["readyToMerge"])
python/dashboard/test_hub_summary.py:47  readyToMerge  self.assertEqual(h["readyToMerge"], ready, status)
python/dashboard/test_hub_summary.py:50  readyToMerge  self.assertTrue(app._summarize_hub(hub([{"id": "a", "status": "merged", "phase": "merged"}]), "done")["readyToMerge"])
python/dashboard/test_hub_summary.py:51  readyToMerge  self.assertFalse(app._summarize_hub(hub([]), "coordinating")["readyToMerge"])
python/dashboard/test_hub_waive_abandoned.py:54  readyToMerge  self.assertEqual([before["readyToMerge"], after["readyToMerge"]], [False, True])
python/dashboard/test_requeue_keeps_shared_branch.py:21  agent/decompose-  SHARED = "agent/decompose-adhoc-token-sync-1791297583352"
python/dashboard/test_requeue_preserves_coordination_fields.py:60  agent/decompose-  stacked = {"branch": "agent/decompose-hub-x", "seq": 2, "total": 5}
python/dashboard/test_task_project_scope.py:106  agent/decompose-  self.put(self.other_q, "blocked", "r1", stacked={"branch": "agent/decompose-x", "seq": 2, "total": 3}, dependsOn=["r0"])
python/dashboard/test_unmerged_branch_task_log.py:47  agent/decompose-  {"stage": "applied", "at": "3", "detail": "agent/decompose-x"},
python/dashboard/test_unmerged_branch_task_log.py:90  agent/decompose-  "branch": "agent/decompose-decompose-app-py-01",
python/dashboard/test_unmerged_branch_task_log.py:98  agent/decompose-  hub = app._hub_for_branch(self.q, "agent/decompose-decompose-app-py-01", [])
python/dashboard/test_unmerged_branch_task_log.py:98  hub_for_branch  hub = app._hub_for_branch(self.q, "agent/decompose-decompose-app-py-01", [])
python/dashboard/test_unmerged_branch_task_log.py:101  readyToMerge  self.assertFalse(hub["readyToMerge"])
python/dashboard/test_unmerged_branch_task_log.py:105  agent/decompose-  "id": "file-decompose-hub-x", "branch": "agent/decompose-x", "mode": "stacked",
python/dashboard/test_unmerged_branch_task_log.py:109  agent/decompose-  hub = app._hub_for_branch(self.q, "agent/decompose-x", [])
python/dashboard/test_unmerged_branch_task_log.py:109  hub_for_branch  hub = app._hub_for_branch(self.q, "agent/decompose-x", [])
python/dashboard/test_unmerged_branch_task_log.py:110  readyToMerge  self.assertTrue(hub["readyToMerge"])
python/dashboard/test_unmerged_branch_task_log.py:118  hub_for_branch  hub = app._hub_for_branch(self.q, "agent/child-42", ["child-42"])
python/dashboard/test_unmerged_branch_task_log.py:120  readyToMerge  self.assertFalse(hub["readyToMerge"])  # a child is blocked
python/dashboard/test_unmerged_branch_task_log.py:123  hub_for_branch  self.assertIsNone(app._hub_for_branch(self.q, "agent/adhoc-some-normal-task", ["adhoc-some-normal-task"]))
python/test_discard_stats_compute.py:28  agent/decompose-  "agent/decompose-parent-1": verdict("discard", ["inert"]),
scripts/hub-branch-assumptions-report.js:11  agent/decompose-  const PATTERNS = ['agent/decompose-', 'hubSiblingConflicts', 'readyToMerge', 'hub_for_branch'];
scripts/hub-branch-assumptions-report.js:11  hubSiblingConflicts  const PATTERNS = ['agent/decompose-', 'hubSiblingConflicts', 'readyToMerge', 'hub_for_branch'];
scripts/hub-branch-assumptions-report.js:11  hub_for_branch  const PATTERNS = ['agent/decompose-', 'hubSiblingConflicts', 'readyToMerge', 'hub_for_branch'];
scripts/hub-branch-assumptions-report.js:11  readyToMerge  const PATTERNS = ['agent/decompose-', 'hubSiblingConflicts', 'readyToMerge', 'hub_for_branch'];
scripts/hub-branch-assumptions-report.test.js:39  readyToMerge  const root = mkTree({ 'src/a.js': 'x\n   const y = readyToMerge(1);   \nz\n' });
scripts/hub-branch-assumptions-report.test.js:42  readyToMerge  assert.ok(section(r, 'readyToMerge').includes('- src/a.js:2 -- const y = readyToMerge(1);\n'));
scripts/hub-branch-assumptions-report.test.js:47  readyToMerge  'src/node_modules/p/i.js': 'readyToMerge\n',
scripts/hub-branch-assumptions-report.test.js:48  readyToMerge  'src/.git/c': 'readyToMerge\n',
scripts/hub-branch-assumptions-report.test.js:49  readyToMerge  'scripts/node_modules/q.js': 'readyToMerge\n',
scripts/hub-branch-assumptions-report.test.js:50  readyToMerge  'src/ok.js': 'readyToMerge\n',
scripts/hub-branch-assumptions-report.test.js:55  readyToMerge  assert.ok(r.includes('- src/ok.js:1 -- readyToMerge'));
scripts/hub-branch-assumptions-report.test.js:60  readyToMerge  const root = mkTree({ 'src/bin.dat': Buffer.from('readyToMerge\0\nreadyToMerge\n') });
scripts/hub-branch-assumptions-report.test.js:65  readyToMerge  const head = 'readyToMerge\n';
scripts/hub-branch-assumptions-report.test.js:70  readyToMerge  assert.ok(r.includes('- src/exact.js:1 -- readyToMerge'));
scripts/hub-branch-assumptions-report.test.js:77  hub_for_branch  'scripts/z.js': 'hub_for_branch\nreadyToMerge\n',
scripts/hub-branch-assumptions-report.test.js:77  readyToMerge  'scripts/z.js': 'hub_for_branch\nreadyToMerge\n',
scripts/hub-branch-assumptions-report.test.js:78  hubSiblingConflicts  'src/b.js': 'a\nreadyToMerge\nhubSiblingConflicts\nreadyToMerge\n',
scripts/hub-branch-assumptions-report.test.js:78  readyToMerge  'src/b.js': 'a\nreadyToMerge\nhubSiblingConflicts\nreadyToMerge\n',
scripts/hub-branch-assumptions-report.test.js:79  agent/decompose-  'python/a.py': 'agent/decompose-1\nhub_for_branch\n',
scripts/hub-branch-assumptions-report.test.js:79  hub_for_branch  'python/a.py': 'agent/decompose-1\nhub_for_branch\n',
scripts/hub-branch-assumptions-report.test.js:80  readyToMerge  'src/a.js': 'readyToMerge\n',
scripts/hub-branch-assumptions-report.test.js:83  readyToMerge  assert.deepEqual(section(r, 'readyToMerge').trim().split('\n').filter((l) => l.startsWith('- ')), [
scripts/hub-branch-assumptions-report.test.js:84  readyToMerge  '- scripts/z.js:2 -- readyToMerge',
scripts/hub-branch-assumptions-report.test.js:85  readyToMerge  '- src/a.js:1 -- readyToMerge',
scripts/hub-branch-assumptions-report.test.js:86  readyToMerge  '- src/b.js:2 -- readyToMerge',
scripts/hub-branch-assumptions-report.test.js:87  readyToMerge  '- src/b.js:4 -- readyToMerge',
scripts/hub-branch-assumptions-report.test.js:89  readyToMerge  assert.ok(section(r, 'readyToMerge').includes('Total: 4 rows'));
scripts/hub-branch-assumptions-report.test.js:90  hub_for_branch  assert.ok(section(r, 'hub_for_branch').includes('Total: 2 rows'));
scripts/hub-branch-assumptions-report.test.js:91  hub_for_branch  assert.ok(section(r, 'hub_for_branch').indexOf('python/a.py:2') < section(r, 'hub_for_branch').indexOf('scripts/z.js:1'));
scripts/hub-branch-assumptions-report.test.js:92  hubSiblingConflicts  assert.ok(section(r, 'hubSiblingConflicts').includes('- src/b.js:3 -- hubSiblingConflicts'));
scripts/hub-branch-assumptions-report.test.js:93  agent/decompose-  assert.ok(section(r, 'agent/decompose-').includes('Total: 1 rows'));
scripts/hub-branch-assumptions-report.test.js:98  readyToMerge  const root = mkTree({ 'src/l.js': 'readyToMerge' + 'a'.repeat(300) + '\n' });
scripts/hub-branch-assumptions-report.test.js:104  readyToMerge  const root = mkTree({ 'src/a.js': 'readyToMerge\n' });
scripts/hub-branch-assumptions-report.test.js:106  hub_for_branch  assert.equal(section(r, 'hub_for_branch').trim(), '## hub_for_branch\n\nTotal: 0 rows');
scripts/hub-branch-assumptions-report.test.js:110  hub_for_branch  const root = mkTree({ 'src/c.js': 'a\r\n  readyToMerge x  \r\nhub_for_branch\r\n' });
scripts/hub-branch-assumptions-report.test.js:110  readyToMerge  const root = mkTree({ 'src/c.js': 'a\r\n  readyToMerge x  \r\nhub_for_branch\r\n' });
scripts/hub-branch-assumptions-report.test.js:112  readyToMerge  assert.ok(r.includes('- src/c.js:2 -- readyToMerge x\n'));
scripts/hub-branch-assumptions-report.test.js:113  hub_for_branch  assert.ok(r.includes('- src/c.js:3 -- hub_for_branch\n'));
scripts/hub-branch-assumptions-report.test.js:118  readyToMerge  const root = mkTree({ 'src/l.js': 'readyToMerge' + 'a'.repeat(300) + '\r\n' });
scripts/hub-branch-assumptions-report.test.js:126  readyToMerge  const root = mkTree({ 'src/a.js': 'readyToMerge\n' });
scripts/hub-branch-assumptions-report.test.js:152  readyToMerge  const root = mkTree({ 'src/a.js': 'readyToMerge\n' });
scripts/hub-branch-assumptions-report.test.js:160  readyToMerge  const root = mkTree({ 'src/a.js': 'readyToMerge\n' });
scripts/hub-branch-assumptions.js:12  agent/decompose-  const PATTERNS = ['agent/decompose-', 'hubSiblingConflicts', 'readyToMerge', 'hub_for_branch'];
scripts/hub-branch-assumptions.js:12  hubSiblingConflicts  const PATTERNS = ['agent/decompose-', 'hubSiblingConflicts', 'readyToMerge', 'hub_for_branch'];
scripts/hub-branch-assumptions.js:12  hub_for_branch  const PATTERNS = ['agent/decompose-', 'hubSiblingConflicts', 'readyToMerge', 'hub_for_branch'];
scripts/hub-branch-assumptions.js:12  readyToMerge  const PATTERNS = ['agent/decompose-', 'hubSiblingConflicts', 'readyToMerge', 'hub_for_branch'];
src/abandoned-recheck.test.js:11  agent/decompose-  const BR = 'agent/decompose-hub-1791297583352';
src/apply-adhoc-diff.js:213  agent/decompose-  const chainBranch = nested ? nested.branch : `agent/decompose-${slugify(parentTaskId)}`;
src/apply-adhoc-diff.test.js:531  agent/decompose-  const parent = { id: 'piece-two', stacked: { branch: 'agent/decompose-outer-hub', seq: 2, total: 3 } };
src/apply-adhoc-diff.test.js:536  agent/decompose-  assert.equal(n1.stacked.branch, 'agent/decompose-outer-hub', 'no second branch: the ancestor hub still ends as one');
src/apply-branch-prep-route.test.js:38  agent/decompose-  const task = { id: 'adhoc-decompose-x-01', stacked: { branch: 'agent/decompose-x', seq: 1 } };
src/apply-branch-prep-route.test.js:40  agent/decompose-  assert.equal(out.branchName, 'agent/decompose-x');
src/apply-branch-prep-route.test.js:47  agent/decompose-  const task = { id: 'adhoc-decompose-x-01', stacked: { branch: 'agent/decompose-x', seq: 1 } };
src/apply-branch-prep-route.test.js:49  agent/decompose-  assert.equal(out.branchName, 'agent/decompose-x');
src/apply-branch-prep-route.test.js:55  agent/decompose-  const task = { id: 'adhoc-decompose-x-02', stacked: { branch: 'agent/decompose-x', seq: 2 } };
src/apply-branch-prep-route.test.js:62  agent/decompose-  const task = { id: 'adhoc-x', stacked: { branch: 'agent/decompose-x', seq: 1 } };
src/apply-branch-prep-route.test.js:79  agent/decompose-  const task = { id: 'adhoc-decompose-x-02', stacked: { branch: 'agent/decompose-x', seq: 2 } };
src/apply-task.test.js:1445  agent/decompose-  const result = applyTask(baseTask({ id: 'adhoc-decompose-x-01-a', stacked: { branch: 'agent/decompose-x', seq: 1 } }),
src/apply-task.test.js:1448  agent/decompose-  assert.equal(result.branch, 'agent/decompose-x');
src/apply-task.test.js:1457  agent/decompose-  const gitRunner = createFakeGitRunner({ remoteBranches: ['agent/decompose-x'], isAncestorFn: () => false });
src/apply-task.test.js:1458  agent/decompose-  const result = applyTask(baseTask({ id: 'adhoc-decompose-x-01-a', stacked: { branch: 'agent/decompose-x', seq: 1 } }),
src/apply-task.test.js:1468  agent/decompose-  const gitRunner = createFakeGitRunner({ remoteBranches: ['agent/decompose-x'], isAncestorFn: () => true });
src/apply-task.test.js:1469  agent/decompose-  const result = applyTask(baseTask({ id: 'adhoc-decompose-x-01-a', stacked: { branch: 'agent/decompose-x', seq: 1 } }),
src/apply-task.test.js:1484  agent/decompose-  const gitRunner = createFakeGitRunner({ existingBranches: ['agent/decompose-x'], remoteBranches: ['agent/decompose-x'], isAncestorFn: () => true });
src/apply-task.test.js:1485  agent/decompose-  const result = applyTask(baseTask({ id: 'adhoc-decompose-x-02-b', stacked: { branch: 'agent/decompose-x', seq: 2 } }),
src/apply-task.test.js:1496  agent/decompose-  const gitRunner = createFakeGitRunner({ existingBranches: ['agent/decompose-x'], remoteBranches: ['agent/decompose-x'], isAncestorFn: () => true });
src/apply-task.test.js:1498  agent/decompose-  baseTask({ id: 'adhoc-decompose-x-02-b', stacked: { branch: 'agent/decompose-x', seq: 2 },
src/apply-task.test.js:1513  agent/decompose-  const gitRunner = createFakeGitRunner({ dirtyTree: 'Docs/ARCH_REVIEW_CANDIDATES.md', existingBranches: ['agent/decompose-x'], remoteBranches: ['agent/decompose-
src/apply-task.test.js:1514  agent/decompose-  const result = applyTask(baseTask({ id: 'adhoc-decompose-x-02-b', stacked: { branch: 'agent/decompose-x', seq: 2 } }), { repoRoot: REPO_ROOT, pipelineDir: PIPEL
src/chat-branch-verdict.test.js:155  agent/decompose-  const d = fakeDashboard({ rows: [row({ branch: 'agent/decompose-adhoc-x y#1' })] });
src/chat-branch-verdict.test.js:156  agent/decompose-  await recordBranchVerdictTool({ branch: 'agent/decompose-adhoc-x y#1', sha: SHA, verdict: 'merge', reasons: ['x'] }, { request: d.request, ...withCheck() });
src/get-grounding-source.test.js:541  agent/decompose-  g(['checkout', '-b', 'agent/decompose-hub'], repo);
src/get-grounding-source.test.js:543  agent/decompose-  g(['add', '.'], repo); g(['commit', '-m', 'step 1'], repo); g(['push', 'origin', 'agent/decompose-hub'], repo);
src/get-grounding-source.test.js:553  agent/decompose-  const atRef = extractLiveRepoGrounding(text, repo, 'agent/decompose-hub');
src/get-grounding-source.test.js:558  agent/decompose-  assert.deepEqual(extractLiveRepoGrounding('see src/nope.ts', repo, 'agent/decompose-hub'), []);
src/get-grounding-source.test.js:560  agent/decompose-  const refreshed = refreshFetchedFileContent([{ path: 'src/view.js', content: 'frozen' }], repo, 'agent/decompose-hub');
src/git-runner.test.js:274  agent/decompose-  assert.equal(runner.branchExists('agent/decompose-x'), false);
src/git-runner.test.js:275  agent/decompose-  runner.createBranch('agent/decompose-x');
src/git-runner.test.js:279  agent/decompose-  git(['push', '-u', 'origin', 'agent/decompose-x'], repoDir);
src/git-runner.test.js:282  agent/decompose-  assert.equal(runner.branchExists('agent/decompose-x'), true);
src/git-runner.test.js:283  agent/decompose-  assert.doesNotThrow(() => runner.checkoutBranch('agent/decompose-x'));
src/git-runner.test.js:284  agent/decompose-  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir).trim(), 'agent/decompose-x');
src/git-runner.test.js:289  agent/decompose-  git(['branch', '-D', 'agent/decompose-x'], repoDir);
src/git-runner.test.js:290  agent/decompose-  assert.equal(runner.branchExists('agent/decompose-x'), false);
src/git-runner.test.js:291  agent/decompose-  runner.fetchBranch('agent/decompose-x');
src/git-runner.test.js:292  agent/decompose-  assert.doesNotThrow(() => runner.checkoutTracking('agent/decompose-x'));
src/git-runner.test.js:299  agent/decompose-  assert.doesNotThrow(() => runner.fetchBranch('agent/decompose-does-not-exist'));
src/git-runner.test.js:316  agent/decompose-  runner.createBranch('agent/decompose-x');
src/git-runner.test.js:320  agent/decompose-  git(['push', '-u', 'origin', 'agent/decompose-x'], repoDir);
src/git-runner.test.js:322  agent/decompose-  git(['branch', '-D', 'agent/decompose-x'], repoDir);
src/git-runner.test.js:324  agent/decompose-  assert.doesNotThrow(() => runner.prepareStackedBranch('agent/decompose-x'));
src/git-runner.test.js:325  agent/decompose-  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir).trim(), 'agent/decompose-x');
src/git-runner.test.js:332  agent/decompose-  runner.createBranch('agent/decompose-x');
src/git-runner.test.js:336  agent/decompose-  git(['push', '-u', 'origin', 'agent/decompose-x'], repoDir);
src/git-runner.test.js:342  agent/decompose-  git(['fetch', 'origin', 'agent/decompose-x'], otherClone);
src/git-runner.test.js:343  agent/decompose-  git(['checkout', 'agent/decompose-x'], otherClone);
src/git-runner.test.js:347  agent/decompose-  git(['push', 'origin', 'agent/decompose-x'], otherClone);
src/git-runner.test.js:350  agent/decompose-  assert.doesNotThrow(() => runner.prepareStackedBranch('agent/decompose-x'));
src/git-runner.test.js:357  agent/decompose-  runner.createBranch('agent/decompose-x');
src/git-runner.test.js:361  agent/decompose-  git(['push', '-u', 'origin', 'agent/decompose-x'], repoDir);
src/git-runner.test.js:369  agent/decompose-  assert.doesNotThrow(() => runner.prepareStackedBranch('agent/decompose-x'));
src/git-runner.test.js:370  agent/decompose-  assert.equal(git(['rev-parse', 'agent/decompose-x'], repoDir).trim(), localTip, 'the unpushed commit must not be discarded');
src/git-runner.test.js:377  agent/decompose-  runner.createBranch('agent/decompose-x');
src/git-runner.test.js:381  agent/decompose-  git(['push', '-u', 'origin', 'agent/decompose-x'], repoDir);
src/git-runner.test.js:392  agent/decompose-  git(['fetch', 'origin', 'agent/decompose-x'], otherClone);
src/git-runner.test.js:393  agent/decompose-  git(['checkout', 'agent/decompose-x'], otherClone);
src/git-runner.test.js:397  agent/decompose-  git(['push', 'origin', 'agent/decompose-x'], otherClone);
src/git-runner.test.js:398  agent/decompose-  const otherTip = git(['rev-parse', 'agent/decompose-x'], otherClone).trim();
src/git-runner.test.js:401  agent/decompose-  assert.doesNotThrow(() => runner.prepareStackedBranch('agent/decompose-x'));
src/git-runner.test.js:403  agent/decompose-  assert.equal(git(['rev-parse', 'agent/decompose-x'], repoDir).trim(), otherTip, 'agent/decompose-x resets to origin\'s tip');
src/git-runner.test.js:405  agent/decompose-  const rescueBranches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/agent/decompose-x-rescued-*'], repoDir).trim().split('\n').filter(Boolean);
src/git-runner.test.js:419  agent/decompose-  runner.createBranch('agent/decompose-x');
src/git-runner.test.js:426  agent/decompose-  assert.doesNotThrow(() => runner.prepareStackedBranch('agent/decompose-x'));
src/git-runner.test.js:427  agent/decompose-  assert.equal(git(['rev-parse', 'agent/decompose-x'], repoDir).trim(), localTip, 'real never-pushed work must not be discarded');
src/git-runner.test.js:437  agent/decompose-  git(['branch', 'agent/decompose-x'], repoDir); // branches off the current (soon-to-be-stale) tip
src/git-runner.test.js:438  agent/decompose-  const staleTip = git(['rev-parse', 'agent/decompose-x'], repoDir).trim();
src/git-runner.test.js:447  agent/decompose-  assert.doesNotThrow(() => runner.prepareStackedBranch('agent/decompose-x'));
src/git-runner.test.js:448  agent/decompose-  const finalTip = git(['rev-parse', 'agent/decompose-x'], repoDir).trim();
src/git-runner.test.js:451  agent/decompose-  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir).trim(), 'agent/decompose-x');
src/git-runner.test.js:459  agent/decompose-  assert.doesNotThrow(() => runner.prepareStackedBranch('agent/decompose-brand-new'));
src/git-runner.test.js:460  agent/decompose-  assert.equal(git(['rev-parse', 'agent/decompose-brand-new'], repoDir).trim(), mainTip);
src/git-runner.test.js:461  agent/decompose-  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir).trim(), 'agent/decompose-brand-new');
src/git-runner.test.js:549  agent/decompose-  assert.equal(runner.remoteBranchExists('agent/decompose-x'), false);
src/git-runner.test.js:552  agent/decompose-  git(['branch', 'agent/decompose-x'], repoDir);
src/git-runner.test.js:553  agent/decompose-  assert.equal(runner.remoteBranchExists('agent/decompose-x'), false);
src/git-runner.test.js:555  agent/decompose-  git(['checkout', 'agent/decompose-x'], repoDir);
src/git-runner.test.js:556  agent/decompose-  git(['push', '-u', 'origin', 'agent/decompose-x'], repoDir);
src/git-runner.test.js:557  agent/decompose-  assert.equal(runner.remoteBranchExists('agent/decompose-x'), true);
src/git-runner.test.js:572  agent/decompose-  const B = 'agent/decompose-hub';
src/git-runner.test.js:605  agent/decompose-  const B = 'agent/decompose-hub';
src/git-runner.test.js:629  agent/decompose-  assert.equal(createRealGitRunner(repoDir).remoteHasUnmergedWork('agent/decompose-x'), false);
src/git-runner.test.js:635  agent/decompose-  runner.createBranch('agent/decompose-x');
src/git-runner.test.js:639  agent/decompose-  git(['push', '-u', 'origin', 'agent/decompose-x'], repoDir);
src/git-runner.test.js:641  agent/decompose-  git(['branch', '-D', 'agent/decompose-x'], repoDir);
src/git-runner.test.js:642  agent/decompose-  assert.equal(runner.remoteHasUnmergedWork('agent/decompose-x'), true);
src/git-runner.test.js:648  agent/decompose-  git(['push', 'origin', 'HEAD:refs/heads/agent/decompose-merged'], repoDir); // same commit as main: nothing main lacks
src/git-runner.test.js:649  agent/decompose-  assert.equal(runner.remoteHasUnmergedWork('agent/decompose-merged'), false);
src/hub-add-piece.js:7  readyToMerge  // sweep builds each hub's checklist from `subTasks`, and python/dashboard/app_branch_helpers.py `_summarize_hub` computes readyToMerge from the same
src/hub-add-piece.test.js:3  readyToMerge  // Tests for src/hub-add-piece.js (2026-10-31): a follow-up piece attached to an already-coordinating hub, so the hub's checklist (and readyToMerge)
src/hub-add-piece.test.js:16  agent/decompose-  const BRANCH = 'agent/decompose-adhoc-big-task-111';
src/hub-priority.test.js:296  agent/decompose-  function stackedHub(dir, { p1Status = 'pending-merge', p1Stacked = { branch: 'agent/decompose-hub-x', seq: 1, total: 2 }, writeP1 = true } = {}) {
src/hub-priority.test.js:302  agent/decompose-  const SAME = { branch: 'agent/decompose-hub-x', seq: 2, total: 2 };
src/hub-priority.test.js:322  agent/decompose-  assert.equal(hubHasUnmergedEarlierSibling(dir, p2({ branch: 'agent/decompose-some-other-hub', seq: 2, total: 2 }, ['p1'])).blocked, true);
src/hub-priority.test.js:346  agent/decompose-  const branch = 'agent/decompose-hub-x';
src/hub-status-grounding.test.js:33  agent/decompose-  git(['checkout', '-b', 'agent/decompose-fixture'], repoRoot);
src/hub-status-grounding.test.js:38  agent/decompose-  git(['push', 'origin', 'agent/decompose-fixture'], repoRoot);
src/hub-status-grounding.test.js:72  agent/decompose-  stacked: { branch: 'agent/decompose-fixture', seq: 2, total: 2 },
src/hub-status-grounding.test.js:92  agent/decompose-  stacked: { branch: 'agent/decompose-fixture', seq: 2, total: 2 },
src/hub-status-grounding.test.js:108  agent/decompose-  stacked: { branch: 'agent/decompose-fixture', seq: 2, total: 2 },
src/lib/shared-branch.test.js:11  agent/decompose-  const BR = 'agent/decompose-adhoc-token-sync-1791297583352';
src/local-draft.test.js:1541  agent/decompose-  git(['checkout', '-b', 'agent/decompose-stacked-test'], dir);
src/local-draft.test.js:1545  agent/decompose-  git(['push', 'origin', 'agent/decompose-stacked-test'], dir);
src/local-draft.test.js:1550  agent/decompose-  stacked: { branch: 'agent/decompose-stacked-test', seq: 2, total: 3 },
src/local-tool-client.js:446  agent/decompose-  branch: { type: 'string', description: 'The full branch name, e.g. agent/decompose-adhoc-...' },
src/local-tool-client.js:464  agent/decompose-  branch: { type: 'string', description: 'The full branch name, e.g. agent/decompose-adhoc-...' },
src/node-claim-widen.test.js:57  agent/decompose-  const base = { source: 'manual', domain: 'adhoc', stacked: { branch: 'agent/decompose-x', seq: 2, total: 4 } };
src/node-claim-widen.test.js:68  agent/decompose-  writeTask(pending, 'stacked-piece', { source: 'manual', domain: 'adhoc', stacked: { branch: 'agent/decompose-x', seq: 1, total: 3 } }, 200);
src/node-claim-widen.test.js:86  agent/decompose-  writeTask(pending, 'piece-1', { source: 'manual', domain: 'adhoc', stacked: { branch: 'agent/decompose-x', seq: 1, total: 2 } }, 300);
src/node-claim-widen.test.js:87  agent/decompose-  writeTask(pending, 'piece-2', { source: 'manual', domain: 'adhoc', stacked: { branch: 'agent/decompose-x', seq: 2, total: 2 }, dependsOn: ['piece-1'] }, 200);
src/pool-projects.test.js:331  agent/decompose-  ['a stacked branch', { stacked: { branch: 'agent/decompose-x', seq: 1, total: 3 } }],
src/queue-adhoc-task.test.js:299  agent/decompose-  const HUB_BRANCH = 'agent/decompose-adhoc-some-hub-1793475827469';
src/review-repro.test.js:209  agent/decompose-  for (const [label, overrides, env] of [['plain', { promptContext: {} }, undefined], ['hub', { stacked: { branch: 'agent/decompose-x', seq: 2, total: 2 }, depend
src/review-task.test.js:2278  agent/decompose-  git(['checkout', '-b', 'agent/decompose-hub-x'], work);
src/review-task.test.js:2280  agent/decompose-  git(['add', '-A'], work); git(['commit', '-m', 'sibling'], work); git(['push', 'origin', 'agent/decompose-hub-x'], work);
src/review-task.test.js:2284  agent/decompose-  const stacked = adhocImplementedTask({ id: 'ev-stacked', stacked: { branch: 'agent/decompose-hub-x', seq: 2, total: 2 } });
src/review-task.test.js:2291  agent/decompose-  assert.equal(seen.stacked, 'agent/decompose-hub-x');
src/review-task.test.js:2649  agent/decompose-  const task = adhocImplementedTask({ id: 'inert-hub', dependsOn: ['HUB0001-01-a'], stacked: { branch: 'agent/decompose-hub-x', seq: 2, total: 2 } });
src/review-task.test.js:3291  agent/decompose-  ['a hub slice (stacked)', { stacked: { branch: 'agent/decompose-hub-x', seq: 2, total: 3 } }],
src/shared-branch-restore.test.js:11  agent/decompose-  const BR = 'agent/decompose-hub-1791297583352';
src/stacked-grounding.js:28  agent/decompose-  // Returns the stacked branch's plain name (e.g. "agent/decompose-autodecomp-...") if
src/staleness-stacked-ref.test.js:20  agent/decompose-  const BRANCH = 'agent/decompose-chain';
src/task-disposition.js:296  agent/decompose-  //    record.stacked.branch, e.g. "agent/decompose-<plan-slug>" -- NOT agent/<own id>.
src/task-disposition.test.js:64  agent/decompose-  // "agent/decompose-<plan-slug>") across its WHOLE move sequence, never agent/<own id>.
src/task-disposition.test.js:72  agent/decompose-  stacked: { branch: 'agent/decompose-plan', seq: 1, total: 5 },
src/task-disposition.test.js:73  agent/decompose-  ...applied('agent/decompose-plan'),
src/task-disposition.test.js:86  agent/decompose-  stacked: { branch: 'agent/decompose-plan', seq: 2, total: 5 },
src/task-disposition.test.js:87  agent/decompose-  ...applied('agent/decompose-plan'),
src/task-disposition.test.js:97  agent/decompose-  stacked: { branch: 'agent/decompose-plan-gone', seq: 3, total: 5 },
src/task-disposition.test.js:98  agent/decompose-  ...applied('agent/decompose-plan-gone'),
src/task-disposition.test.js:444  agent/decompose-  recordBranchRemoval(d, { branch: 'agent/decompose-shared-plan', cause: 'hub-retired', detail: 'hub retired', actor: 'hub-retire' });
src/task-disposition.test.js:445  agent/decompose-  const r = { id: 'child-1', stacked: { branch: 'agent/decompose-shared-plan' }, ...applied('agent/child-1') };
src/task-disposition.test.js:472  agent/decompose-  id: 'HUB0018-01', stacked: { branch: 'agent/decompose-hub', seq: 1, total: 2 }, rawDiff: sibDiff(),
src/task-disposition.test.js:473  agent/decompose-  history: [{ stage: 'created' }, { stage: 'applied', detail: 'agent/decompose-hub' }], ...over,
src/task-disposition.test.js:484  agent/decompose-  const out = resolveStacked(stackedRec(), fakeGit({ files: { 'origin/agent/decompose-hub:src/StartPage.tsx': 'export function StartPage({ onLogin }: { onLogin?: 
src/task-disposition.test.js:491  agent/decompose-  const out = resolveStacked(stackedRec(), fakeGit({ files: { 'origin/master:src/StartPage.tsx': onMain, 'origin/agent/decompose-hub:src/StartPage.tsx': 'unrelate
src/task-disposition.test.js:498  agent/decompose-  assert.equal(resolveStacked(stackedRec(), fakeGit({ branchBodies: 'no trailer here\n', files: { 'origin/agent/decompose-hub:src/StartPage.tsx': half } })).stage
src/task-sources.test.js:1108  agent/decompose-  stacked: { branch: 'agent/decompose-hub-x', seq: 2, total: 3 },
src/task-sources.test.js:3775  agent/decompose-  const subHub = (statuses, stacked = { branch: 'agent/decompose-parent', seq: 1, total: 3 }) => ({
src/wire-decomposed-blueprints.js:94  agent/decompose-  * @param {string} opts.branch     the shared `agent/decompose-<slug>` branch
src/wire-decomposed-blueprints.test.js:95  agent/decompose-  repoRoot: '/repo', branch: 'agent/decompose-x', sourceFile: 'python/dashboard/app.py',
src/wire-decomposed-blueprints.test.js:102  agent/decompose-  assert.ok(calls.some((c) => c === 'push origin agent/decompose-x'));
src/wire-decomposed-blueprints.test.js:113  agent/decompose-  repoRoot: '/repo', branch: 'agent/decompose-x', sourceFile: 'python/dashboard/app.py',
src/wire-decomposed-blueprints.test.js:125  agent/decompose-  repoRoot: '/repo', branch: 'agent/decompose-x', sourceFile: 'python/dashboard/app.py',
src/wire-decomposed-blueprints.test.js:139  agent/decompose-  repoRoot: '/repo', branch: 'agent/decompose-x', sourceFile: 'python/dashboard/app.py',
src/wire-decomposed-blueprints.test.js:149  agent/decompose-  repoRoot: '/repo', branch: 'agent/decompose-x', sourceFile: 'x.html',
```
<!-- HUB-BRANCH-ASSUMPTIONS:END -->
