# nc-autoanswer rule: the grillBot contract

The needs-clarification autoanswer feature (`src/nc-autoanswer.js`) lets a
grill bot (FF-5 / FF-5a) offer a clarifying answer when a task enters
`queue/needs-clarification/`. The grill bot is the only source of truth for
what an autoanswer looks like; `src/nc-autoanswer.js` does not invent one.

This file is the **contract** between the grill bot implementation and the
autoanswer consumer. Either side may change only by updating this doc first and
keeping both sides in sync. The contract is also the acceptance criteria for
the grill bot's unit tests and for the review of any change to
`src/nc-autoanswer.js`'s consumption of a grill bot result.

## The grillBot function

The grill bot exposes one entry point:

```
grillBot(task) -> {answer: string, level: number, hardStop?: boolean}
```

| Return key | Type | Required | Meaning |
|---|---|---|---|
| `answer` | `string` | yes | The autoanswer text. Must be non-empty after trimming. Sent back to the user as the bot reply. |
| `level` | `number` | yes | Confidence level of the answer. Whole number >= 0. The autoanswer consumer compares this against `ncAutoAnswerMinLevel` (see below) before deciding whether to actually post the answer. |
| `hardStop` | `boolean` | no | When `true`, the autoanswer consumer must **not** requeue the task for human review even if posting the answer would otherwise be allowed. Use for answers that resolve the clarification definitively (e.g. "I can do X, Y, Z" when the user asked "can you do X?"). Default `false`. |

### Constraints on `answer`

- Must be a non-empty string after trimming whitespace.
- Must not contain raw markdown that would break the queue UI (no unescaped `<`, no bare URLs without context).
- Must fit in a single chat message from the grill bot's channel (under 4000 characters).

### Constraints on `level`

- Must be a non-negative integer (`Math.floor(level) === level && level >= 0`).
- The autoanswer consumer rejects (logs and skips) any result with `level < 0` or non-integer `level` without posting.

### When to set `hardStop: true`

Set `hardStop: true` only when the answer **fully resolves** the user's
clarification question. Examples:

- User asks "Can you do X?" and the bot answers "Yes, I can do X by ..."
- User asks "Will this take more than 5 minutes?" and the bot answers "No, it will take about 2 minutes because ..."

Do **not** set `hardStop: true` for:

- Partial answers ("I can do X, but not Y").
- Clarifications that still require user input ("Could you clarify what you mean by Z?").
- Answers that include a follow-up question.

## Settings

The autoanswer consumer reads two keys from `dashboard-settings.json`:

| Key | Type | Allowed values | Default | Meaning |
|---|---|---|---|---|
| `ncAutoAnswer` | `string` | `'off'`, `'shadow'`, `'live'` | `'off'` | Feature gate. `'off'` disables autoanswer entirely. `'shadow'` runs the grill bot and records the result but never posts. `'live'` posts the answer. |
| `ncAutoAnswerMinLevel` | `number` | non-negative integer | `0` | Minimum `level` the grill bot must return for the answer to be posted (in `'live'` mode). Answers below this level are logged and skipped. |

### Behaviour per mode

- **`'off'`**: Skip the grill bot call entirely. No task state is written.
- **`'shadow'`**: Call the grill bot, record the result in `data.ncAutoAnswer` with `mode: 'shadow'`, but never post. Useful for tuning `ncAutoAnswerMinLevel` without affecting users.
- **`'live'`**: Call the grill bot. If `level >= ncAutoAnswerMinLevel`, post the answer and write `data.ncAutoAnswer` with `mode: 'live'`. If `level < ncAutoAnswerMinLevel`, skip posting and write `data.ncAutoAnswer` with `mode: 'live', skipped: 'below-level'`. If `hardStop: true` and the answer is posted, write `data.ncAutoAnswer` with `mode: 'live', skipped: 'hard-stop'`.

## Task record field

The autoanswer consumer writes `data.ncAutoAnswer` on the task record. The shape depends on what happened:

### Answer posted successfully

```json
{
  "mode": "live",
  "answer": "<the answer text>",
  "level": 5,
  "category": "<grill bot category slug>",
  "at": "2026-01-15T10:30:00Z"
}
```

### Answer skipped because `level < ncAutoAnswerMinLevel`

```json
{
  "mode": "live",
  "skipped": "below-level",
  "level": 2
}
```

### Answer skipped because `hardStop: true` (answer posted, but task not requeued)

```json
{
  "mode": "live",
  "skipped": "hard-stop",
  "level": 5
}
```

### Shadow mode (never posted)

```json
{
  "mode": "shadow",
  "answer": "<the answer text>",
  "level": 5,
  "category": "<grill bot category slug>",
  "at": "2026-01-15T10:30:00Z"
}
```

### Field meanings

| Field | Type | Required | Meaning |
|---|---|---|---|
| `mode` | `string` | yes | `'live'` or `'shadow'`. Indicates which mode was active. |
| `answer` | `string` | yes, when posted | The answer text. Omitted when skipped. |
| `level` | `number` | yes | The grill bot's confidence level. Always present. |
| `category` | `string` | yes, when posted | The grill bot's category slug (e.g. `'clarification'`, `'confirmation'`). Omitted when skipped. |
| `at` | `string` (ISO 8601) | yes, when posted | When the grill bot was called. Omitted when skipped. |
| `skipped` | `string` | yes, when skipped | `'below-level'` or `'hard-stop'`. Omitted when posted. |

## Requeue text

When the autoanswer consumer posts an answer and requeues the task (i.e. `hardStop` is falsy or absent), it writes the following text to the task's activity log:

```
bot answer (level N): <answer>
```

Where `N` is the grill bot's `level` and `<answer>` is the `answer` string. This text is visible in the queue UI and in the task's activity history.

### Example

If the grill bot returns `{answer: "I can export your data as CSV", level: 4}` and `ncAutoAnswerMinLevel` is `3`:

1. The answer is posted to the user.
2. The task is requeued with text: `bot answer (level 4): I can export your data as CSV`
3. `data.ncAutoAnswer` is written with `mode: 'live'`, `answer`, `level: 4`, `category`, `at`.

## Consumer behaviour (`src/nc-autoanswer.js`)

The autoanswer consumer is implemented as `handleNeedsClarificationEntered(task, deps)` in `src/nc-autoanswer.js`. It is invoked when a task enters `queue/needs-clarification/` and does the following:

1. Read `ncAutoAnswer` from `dashboard-settings.json`. If `'off'`, return immediately.
2. Call `grillBot(task)` from the grill bot module.
3. Validate the result:
   - If the call throws, log and skip. Do not post.
   - If the result is not an object with `answer` (non-empty string) and `level` (non-negative integer), log and skip.
   - If `level < ncAutoAnswerMinLevel`, skip posting. Write `data.ncAutoAnswer` with `skipped: 'below-level'`.
4. If `'shadow'` mode, write `data.ncAutoAnswer` with `mode: 'shadow'` and return. Do not post.
5. If `'live'` mode:
   - Post the answer to the user.
   - If `hardStop` is truthy, write `data.ncAutoAnswer` with `skipped: 'hard-stop'` and do not requeue.
   - Otherwise, requeue the task with the requeue text `bot answer (level N): <answer>` and write `data.ncAutoAnswer` with `mode: 'live'`, `answer`, `level`, `category`, `at`.

## Testing

The grill bot's unit tests must cover:

- Returning a valid result with `level >= ncAutoAnswerMinLevel` and no `hardStop`.
- Returning a valid result with `level < ncAutoAnswerMinLevel`.
- Returning a valid result with `hardStop: true`.
- Returning an invalid result (missing `answer`, negative `level`, non-integer `level`).
- Throwing an error.

The autoanswer consumer's tests must cover:

- Each mode (`'off'`, `'shadow'`, `'live'`).
- Each skip reason (`'below-level'`, `'hard-stop'`).
- Invalid grill bot results.
- Grill bot errors.

## History

- 2026-01-15: Initial contract definition. Split from parent task HUB0918 into this subtask (HUB0919-1) and `src/nc-autoanswer.js` (HUB0919-2).
