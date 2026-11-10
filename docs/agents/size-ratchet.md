# Size ratchet

A hard-fail test that keeps source files and functions from growing past the repository's
size limits, while letting today's oversized code stay until someone splits it. The limits
are the ones the hygiene scanners already advised on; this makes them a gate.

- **File limit:** `AGENT_MANAGER_MAX_FILE_LINES`, default **500** lines.
- **Function limit:** `AGENT_MANAGER_MAX_FUNCTION_LINES`, default **100** lines.
- **What counts:** source files with the extensions `.js .mjs .cjs .jsx .ts .tsx .py`.
  Documents, JSON and other data files are never counted. `node_modules`, `.git`, `.venv`,
  `__pycache__`, `dist`, `build`, `.next` and `.turbo` are skipped.
- **Test files count.** A 900-line test file costs an agent the same context as a 900-line
  module, and the reason for the limits is how much an agent can hold in mind at once, so
  tests get no exemption.

## The four parts

| Part | Role |
|---|---|
| `src/sdk/size-limits.js` | Pure detection: `findLongFiles`, `findLongFunctions`, plus the tokenizer and function-span helpers. Reports every violation; it knows nothing about the allowlist. |
| `config/size-ratchet-allowlist.json` | The frozen list of existing offenders, each with its current line count as a cap. |
| `scripts/size-ratchet-regen.js` | Scans the repository (`scanOffenders`), writes or lowers the allowlist (`lowerOnly`). |
| `src/size-ratchet.test.js` | The gate. Plain `node --test src/size-ratchet.test.js`, no flags. |

## Allowlist format

```json
{
  "files":     { "src/big.js": 812 },
  "functions": { "src/big.js::buildThing": 143 }
}
```

`files` maps a repo-relative path to its line count. `functions` maps `path::name` to the
function's line count (an unnamed function is `<anonymous>`; two functions with the same
name in one file share one entry at the larger count). Both maps are sorted by key.

## What fails the test

1. A file over the file limit that is **not** on the allowlist.
2. A function over the function limit that is **not** on the allowlist.
3. A listed entry whose current size is **above its cap**.

A listed entry at or below its cap passes, and so does a file exactly at the limit. The
last test in `src/size-ratchet.test.js` runs the real check on this repository; the other
tests demonstrate each failure mode on temporary trees.

## Workflows

**You made a big file bigger (test fails: "grew to ...").** Split it or shorten it. A cap is
never raised by hand: the whole point is that an oversized file can only get smaller.

**You added a new oversized file or function (test fails: "not on the allowlist").** Split
it below the limit. Adding it to the allowlist is not a fix.

**You shrank an offender, or split it below the limit.** Lower the cap and drop the entries
that are fixed:

```bash
node scripts/size-ratchet-regen.js
```

With no flag the script keeps each listed entry only while it is still an offender, at
`min(old cap, current lines)`, and rewrites the allowlist. It exits 1 and lists any offender
that is not on the allowlist (it never adds one). Commit the changed JSON with your change.

**Re-baselining on purpose (an owner decision, not a fix).**

```bash
node scripts/size-ratchet-regen.js --init
```

`--init` writes a fresh allowlist from the current offenders. It is the only way entries are
added, and it can raise caps, so use it only to freeze a known tree, for example when this
system is first introduced. Run it on the tree the merge will produce (the base branch with
your branch merged in), not on a stale checkout: a file that grew on the base branch since
your checkout would otherwise get a cap below its real size and the merged tree fails.

## Test hooks

`AGENT_MANAGER_SIZE_RATCHET_ROOT` points the scan at another tree and
`AGENT_MANAGER_SIZE_RATCHET_ALLOWLIST` at another allowlist file; the script's own tests use
them to run against temporary trees. The two limit variables above are honoured by both the
script and the test.

## Why the test takes no flag

An earlier plan had the test read an `--allowlist-check` flag from `process.argv`. Node
strips its own flags before the test file sees them, so that test could never fail. The
test is now unconditional.
