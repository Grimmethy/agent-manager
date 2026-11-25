# BuilderIO/agent-native templates/slides/actions: adoption note

Source: `templates/slides/actions/import-code.ts` and `templates/slides/actions/import-code.spec.ts` in BuilderIO/agent-native. These files are NOT present in this checkout (`ls templates` fails here), so the content reviewed is the copy supplied with the task. Community files were not modified.

## Grep results (step 3)

- `grep -rn "readOnly\|mutates\|sideEffect" src/`: no action or job descriptor carries a readOnly, sideEffect or mutation flag. Hits were prose comments (for example "never mutates its input") and `readOnly: true` options on SQLite connections in `src/health-ledger-backfill.js` and `src/forensic-bundle.js`. None are descriptors.
- `grep -rln "defineAction\|register.*job" src/`: zero matches.
- `grep_codebase` for `defineAction` over the whole repo (`dir: "."`): zero matches.
- `docs/adoption/` did not exist before this note.

## Patterns

### a. Declared mutation flag (`readOnly: true` in `defineAction`)

Decision: SKIP.

Reason: agent-manager has no `defineAction` or job-descriptor layer (zero matches), so there is no descriptor to attach a flag to. Adding one now would be a speculative API. Revisit if a descriptor layer is introduced.

Reference: `templates/slides/actions/import-code.ts`, `export default defineAction({ ... readOnly: true ... })`.

### b. Thin entrypoint delegating to a shared analysis module

Decision: ADOPT (as a principle).

Reason: the `run` callback in `import-code.ts` only calls `analyzeCodeFiles(files)` from `@agent-native/core/brand-kit`, so the logic lives in one shared, testable module and the wrapper stays small. This matches how agent-manager keeps logic in `src/*.js` modules with thin callers.

Reference: `templates/slides/actions/import-code.ts`, `run: async ({ files }) => analyzeCodeFiles(files)`.

### c. Shape-asserting smoke test

Decision: ADOPT, translated to `node:test`.

Reason: `import-code.spec.ts` asserts a partial match on `source`, `fileCount` and `filesAnalyzed` against one minimal fixture. Vitest is not installed here, and agent-manager tests use `node:test`, so the same partial-shape check should be written with `assert` (for example `assert.equal` on each field).

Reference: `templates/slides/actions/import-code.spec.ts`, `toMatchObject({ source, fileCount, filesAnalyzed })`.

## Schema gap

`import-code.spec.ts` calls `action.run(...)` directly, so the zod `schema` in `import-code.ts` is never exercised. Invalid input (missing `files`, wrong types) is untested. If pattern c is adopted, the test should first call `schema.parse(input)` and assert that input missing `files` throws.

## Code changes

No source changes. No `readOnly` field was added (step 4 skipped because there is no descriptor layer), so no new test is needed for it.
