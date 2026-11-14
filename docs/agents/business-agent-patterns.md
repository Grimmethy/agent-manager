# Business-agent patterns (from markfulton/ai-employees), and which repo owns each

Read this before designing a scheduled or "employee-style" agent, a daily list, or a held-outbound rule. It records what we took from one outside project and, more usefully, **which of our repos each idea belongs in**, so the ideas are not all piled into one place.

**Source:** [markfulton/ai-employees](https://github.com/markfulton/ai-employees) (MIT, 797 stars on 2026-10-26, Reinventing.AI): eight "AI employees", each a folder of scheduled routines that read and write plain files and produce one morning brief. Read on 2026-10-26: the docs (`docs/HOW-EMPLOYEES-WORK.md`, `docs/GUARDRAILS.md`, `docs/BEHAVIOR-EVALUATION.md`), the sales and chief-of-staff charters and schedules, and one full routine (the sales follow-up sweep). **Not read:** its scripts. Nothing from it was run.

**Caveats, before adopting anything:** most of its routines drive the owner's signed-in browser through a frontier cloud model, which conflicts with our rule that local models do the work; its own evaluation doc says no model-behaviour tests were run on real models; the README mainly funnels to a paid club. We take design patterns, not software.

## Which repo owns which pattern

| Pattern | Owner | Status on 2026-10-26 |
|---|---|---|
| Append-only event log; state (streak, XP, "which touch is next") is computed from it, never stored | questforge | In `questforge/Docs/DESIGN.md` sections 4 and 5 |
| Day boundaries and a once-per-day key for streaks | questforge | Designed (`dayKey`), task filed |
| Time window + period key for scheduled jobs: a job runs only inside its window and once per period (day, ISO week, month), so a late or duplicate fire does nothing | pf-backend (generic helper, reusable) | Task filed |
| Read before write: check replies, do-not-call and recent calls before building a list | pf-backend (daily list) | In the daily-list task text |
| Evidence on every row: the tests passed, the exact text, the source, the date, so the list is auditable in seconds | pf-backend (hot-list reasons) | Partly there (`hotlistReason`); extend with the daily list |
| Outbound actions held by default; the owner releases one channel at a time in a file | Agent Manager policy, lead-call-desk | We already hold: no auto-dialing, no sends without a yes |
| Owner "corrections" file that outranks any instruction file; a pause switch; a changelog of self-edits that keeps the replaced text | Agent Manager | Pause exists (per-worker off switch); the rest is a gap, not filed |
| Run-log statuses that separate "ran" from "delivered", including "ran fine, produced nothing new" | Agent Manager | Task filed |
| A read-only watcher over the whole fleet: what ran yesterday, what did not, three moves argued both ways | Agent Manager (pipeline forensics / a new plugin) | Concept only |
| Never repeat a message shape on the same channel within the last three runs | whichever repo drafts outreach (not built) | Note only |

## The patterns, briefly

1. **Ledger and fold.** Several writers append to one file; nothing holds a mutable "current state". This is what lets two jobs and a person share a file without locks.
2. **Windows, not fire times.** The scheduler's fire time is only a wake-up. The routine checks its own window and its period key, then exits cheaply if it should not run. A late catch-up fire is harmless. No weekly job is scheduled on a Sunday (it would share a week key with the next week).
3. **Read before write where order is a safety property.** Drafting a second message to someone who already answered is worse than drafting none; the reply search runs first and, if the budget is short, drafting is dropped, never the search.
4. **Evidence on the row.** A verdict with no evidence is a guess with a date on it.
5. **Honest empty days.** A job that found nothing says so in one line instead of reporting a count that flatters.
6. **Verify before you block.** Spend a bounded time observing a gate before reporting the owner as the blocker.
7. **Held outbound, per-channel release.** The only two things an agent stops for: an outward action and a credential.
8. **A human override outranks the file it sits in,** and a self-edit always records what it replaced.
9. **Delivery is not process health.** A job can succeed every day and produce nothing new; report that separately.

## Rules for using this doc

- Add a row when a new pattern is adopted, naming its owner repo and the task or doc that carries it.
- A pattern that only one repo needs stays in that repo's docs; link it here, do not copy it.
