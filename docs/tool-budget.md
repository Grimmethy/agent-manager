# Tool-call budget

A per-run guard that stops a local-model worker from looping forever on tool calls. Implemented in `src/tool-budget.js`, with per-role numbers in `src/tool-budget-profiles.json`.

## Verdicts

- `ok`: call count is within `budget`.
- `soft`: the first call past `budget`. A one-time reminder to wrap up. It fires once per run.
- `over`: a later call past `budget` but not yet past `budget * multiple`. No further nudge.
- `hard`: a call past `budget * multiple`. The caller should stop the run.

## Roles

The numbers are provisional placeholders for local models. Sample size: 0 runs.

| Role | budget | multiple | soft at call | hard after call |
| --- | --- | --- | --- | --- |
| reviewer | 8 | 2 | 9 | 16 |
| drafter | 24 | 2 | 25 | 48 |
| apply | 16 | 2 | 17 | 32 |

Reviewers get the tightest budget. Drafters get the widest. Apply sits between them.

## Re-deriving the numbers

Measure real local-model runs for each role, then update `src/tool-budget-profiles.json` and the `measurement` note with the actual sample size.
