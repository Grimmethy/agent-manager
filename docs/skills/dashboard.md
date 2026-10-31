# Dashboard Skill

Apply verdicts to Unmerged Branches cards in the agent-manager dashboard.

## Endpoints

### Single Branch Verdict

```
POST /api/git/branches/<branch>/verdict
```

Records a verdict (merge / hold / needs-work / discard) for a single branch.

### Batch Verdicts

```
POST /api/git/branches/batch
```

Applies the same verdict to multiple branches atomically. Accepts `{"branches": [...], "verdict": "...", "reasons": [...], "source": "..."}` in the body. Every branch is conflict-checked up front; any conflict rejects the whole batch with no side effects.

The transactional wrapper `_apply_verdicts_batch` in `python/dashboard/branch_verdicts.py` validates all inputs before applying.

## Verdicts

- **merge**: branch is ready to merge
- **hold**: hold for review or waiting on something
- **needs-work**: branch has issues that need fixing
- **discard**: branch should be deleted

## Sources

- **manual**: human applied the verdict
- **chat**: LLM suggested the verdict
- **deterministic**: computed by automated checks
