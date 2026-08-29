# Function Length Decomposition Candidates

### AC-1 · Split onboarding side-effect from candidate selection in nextCandidateFulfillmentTask
Strength: Strong
Files: src/task-sources.js
Snippet:
```
  // lead that was actually discovered FOR this project. Without this, deep_dive treated
  // every Strong lead in the shared ledger as fair game for whichever project's pipeline
  // happened to be running.
  const strongLeads = parseStrongLeadsFromIndex(readIfExists(projectSearchIndexPath))
    .filter((lead) => lead.relevantTo === projectTag);
  // Onboarding (below) does a real `git clone` of the lead's URL -- same offline failure
  // mode as project_search's search calls, just via git instead of https directly. Only
  // guards the clone step, not the whole function: drafting from ALREADY-onboarded
  // communities (the candidates loop further down) is pure local filesystem work and
  // stays available offline.
  const onboardingOnline = strongLeads.some((lead) => !coverage.projects[slugifyForId(lead.name)]) ? isOnline() : true;
  let coverageChanged = false;
  for (const lead of strongLeads) {
    if (!onboardingOnline) break;
    const slug = slugifyForId(lead.name);
    if (coverage.projects[slug]) continue; // already onboarded (or a prior onboarding attempt failed and will retry below)
    try {
      const onboarded = onboardDeepDiveProject(lead, deepDiveClonesDir);
      coverage.projects[slug] = {
        sourceUrl: lead.url,
        clonePath: onboarded.clonePath,
        clonedAt: new Date().toISOString(),
        communities: onboarded.communities,
        // Stamped at onboarding time so arch_import's own filter (nextArchImportTask) can
        // trace a promoted item back to which consumer project it was ever relevant to,
        // without needing to re-parse INDEX.md itself.
        relevantToProject: projectTag,
      };
      coverageChanged = true;
    } catch (e) {
      // Clone/graph-build failures (bad URL, network, python not on PATH, etc.) must never
      // crash the worker loop -- log and skip this lead for this tick; since it's still
```

Problem:
`nextCandidateFulfillmentTask` is 137 lines (37 over the project limit) because it bundles two responsibilities with different I/O profiles and failure modes into a single body. The first half is an onboarding loop: it filters strong leads, checks `isOnline()`, iterates with per-lead try/catch around `git clone` and `onboardDeepDiveProject`, and mutates `coverage.projects` / `coverageChanged`. The second half (the "candidates loop further down" the in-source comments reference) is pure local-file selection and drafting over already-onboarded communities, available offline. Because both halves share the function's parameter list and mutate the same `coverage` object, a reader must hold the entire 137-line body in mind to reason about either concern in isolation, and a change to offline behavior or to the clone/retry logic forces a review of the other half.

Solution:
Extract the online-gated onboarding phase into a private helper, e.g. `onboardPendingLeads(strongLeads, coverage, deepDiveClonesDir)`, which encapsulates the `isOnline()` guard, the per-lead try/catch loop, the `git clone` / `onboardDeepDiveProject` calls, and the `coverage.projects` / `coverageChanged` mutations, returning a boolean or the updated coverage so the caller can proceed. The remaining body of `nextCandidateFulfillmentTask` then contains only the local candidate-selection and draft-task-construction logic, which can itself be tightened or further split if it still exceeds the limit. The public signature of `nextCandidateFulfillmentTask` stays the same; the helper is module-private and called at the top of the function before the selection loop.

Benefits:
Each extracted piece becomes independently unit-testable: the onboarding helper can be tested with a mocked network layer and a stubbed `onboardDeepDiveProject` without exercising the selection path, and the selection logic can be tested with a pre-populated `coverage` object and no network at all. Code review diffs are scoped to one concern at a time, reducing the chance that a change to clone-retry semantics silently affects candidate ordering or vice versa. The main function shrinks to roughly 60–70 lines of single-purpose selection logic, bringing it back under the project's length budget and making the "return a task descriptor" contract visible at a glance.
