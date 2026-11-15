# Research loop (design)

Status: design only. Nothing here is built yet. This document covers how 'look into X' brain-dump entries and link stashes would become short, sourced research briefs, where that loop should live, and a phased backlog. Owner request 2026-10-22: research should be a separate step from the journal forge.

## 1. What the loop does

An entry or a link goes in. A short brief comes out: a summary, the claims it rests on, and a source list. The brief is delivered two ways: a dashboard card, and a note filed in the SecondBrain References/Research folder (exact vault location is an open question, see section 7). The owner answers each brief with one of three actions: useful, dig deeper, or drop. 'Dig deeper' re-queues the same entry with the prior brief as context. 'Drop' closes the entry. 'Useful' keeps the note and marks the entry actioned.

Every brief carries a basis label: either 'looked up' (with the source URLs or files it read) or 'from model's own knowledge, not looked up'. The second label is mandatory whenever no fetch succeeded.

## 2. Source kinds

- Plain question or topic (for example 'what is the CyberPower CP1500AVRLCDTAA?'): no fetch is possible today, so the first brief is model-only and labelled as such.
- Web article or doc: needs a fetch. Not available to local workers today (see section 3).
- YouTube or other video presenting a concept: the owner notes these are often concepts, not repos. Needs transcript access. Local tools present: yt-dlp and ffmpeg (verified this run). Transcript retrieval has not been run. Would need owner approval first. Nothing downloaded or installed.
- Social post with a claim: treated like an article. The claim is extracted and checked only if a fetch works.
- GitHub repo: handled by the separate scouted-repos router task. This loop references that task and does not redo it.
- PDF or doc link: same as article, plus a text-extraction step that does not exist yet.

## 3. Local capability table

Each row says whether it was checked in this run. 'Verified this run' means a grep, read, or command in this session showed it.

| Capability | Status | Evidence |
|---|---|---|
| Sorter writes research entries to queue/research/ | Verified this run | src/apply-group-a-brain-dump.js: queueResearchTask (line 348), branch at line 701 (requiresResearch and no belongsToProject) |
| Research task source reads queue/research/ | Verified this run | src/task-sources.js: nextResearchTask |
| Research drafting uses WebSearch/WebFetch | Verified this run | src/lib/draft-lifecycle.js lines 26-32: research drafting requires the Claude Code CLI and CLAUDE_CODE_OAUTH_TOKEN; there is no local web-research path (src/local-draft.js line 194 comment) |
| Local worker model calls | Verified this run | src/local-client.js: callOnce (line 317), exported call and callOnce |
| project_search source (lead discovery, not per-entry research) | Verified this run | src/task-sources.js: nextProjectSearchTask; src/config.js and src/apply-task.js reference it |
| Local worker page fetch (curl from worker environment) | Not verified | No URL was named by the owner, so no request was made |
| yt-dlp present on host | Verified this run | command -v yt-dlp returned /usr/bin/yt-dlp |
| ffmpeg present on host | Verified this run | command -v ffmpeg returned /usr/bin/ffmpeg |
| youtube-dl present on host | Verified this run | not installed |
| Transcript fetch for one video through yt-dlp | Not verified | Not run. Needs owner approval before any network request for a video |
| Chrome browser tools | Not verified | Brief says only an interactive session has them; not checked here |
| Model's own knowledge | Always available | Labelled as such in every brief |

What must be added for real lookups: a fetch path a worker can call (either a local HTTP fetch with a size cap and a text extractor, or a rule that research entries go through the Claude path that already exists), and a transcript path for video.

Source-existing caveat: the research stage today requires Claude and is off unless AGENT_MANAGER_CLAUDE_SOURCES includes it. So the loop cannot assume looked-up briefs on local hardware.

## 4. Where it lives

(a) A stage inside agent-manager core. Reuses task selection (nextResearchTask), model access (src/local-client.js), and the no-poll rule. Fewest moving parts.

(b) A plugin source like project_search. Lives in the plugin contract. Good for discovery-style work, awkward for a per-entry request with a dashboard card and feedback actions.

(c) Its own repo like JournalForge or SparForge: standalone Flask app, own tab, own queue and data dir. Port 7449 is free (7448 JournalForge, 7447 uxforge).

Recommendation: start with (a) for R1 to R3, and decide on a split at a gate after R3. Reasons:
- Lifecycle independence and a separate tab are real benefits, but they only pay off once the loop has proven useful. Splitting first would duplicate the model-access rules.
- GPU use on an idle lane depends on core's existing scheduling. Keeping it in core keeps the no-poll rule in one place.
- Data privacy does not decide this on its own: notes land in the SecondBrain folder either way.
- The owner leans to a separate repo called ResearchForge. This is a trade-off, not a rejection. The owner decides at the R3 gate with evidence from R1 to R3.

## 5. Interfaces

- Sorter handover: a research outcome sits beside the sorter's existing outcomes (queueResearchTask, queueProjectTask, filePassiveNote). The brief's keep-style outcome has no code identifier in src, so the new outcome is defined fresh, not reused.
- Trigger: the sorter's queue write is the only trigger. No timer, no interval, no cron. The research lane picks up the file on its normal claim pass.
- Result return: the brief is written as a dashboard card record and a SecondBrain note. Owner feedback writes back into the same record.
- JournalForge J10 (topic research, back-burner): to be retired in favour of this loop. The change lives in the JournalForge repo and is an owner action. Not touched here.
- Review list 'Research this' button: calls the same entry point as the sorter handover (R7).

No direct calls to Ollama /api/generate or /api/chat. All model calls go through src/local-client.js call or callOnce.

## 6. Phased backlog

- R1. Question or topic entries become model-only briefs with the mandatory label. Path: sorter outcome, queue write, one local-client call. Trigger: sorter queue write.
- R2. Owner feedback actions (useful, dig deeper, drop) written back to the record. Handled on request, not on a schedule.
- R3. Fetchable article and doc links: one fetch with a size cap, one summary through local-client, basis label 'looked up'. Decision gate for placement (section 4).
- R4. Dashboard card and SecondBrain References/Research note output.
- R5. Video transcripts, only if a transcript path is approved by the owner.
- R6. Retire JournalForge J10 in the JournalForge repo (owner action).
- R7. Review list 'Research this' button calling the R1 entry point.

Each item is small enough for one task.

## 7. Open questions for the owner

1. Where does the References/Research folder live in the SecondBrain vault?
2. May a transcript tool be used for R5 (yt-dlp is already on the host), and is a network request to a video page acceptable for testing?
3. Should R3 fetch through a new local path, or through the existing Claude research path?
4. Should placement be decided now, or at the R3 gate?
5. Which public URL should be used for the worker page-fetch check?
6. Is the Chrome tools path wanted for interactive use, or out of scope?
