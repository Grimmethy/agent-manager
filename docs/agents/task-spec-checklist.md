# Task-spec checklist for Agent Manager tasks

For whoever writes an Agent Manager task: a person, the operator, or a script.

1. Before you write "keep every existing test unchanged", read the existing tests of every file the task touches, because a test may pin the exact shape of a result.
   - Failure (2026-11-16): the farm-trial-ledger task demanded an extra result key and unchanged tests, but an existing test deep-equals the whole result, so the drafter correctly stopped for a human decision.

2. List every state or value a record can have in the real data and say what each one does.
   - Failure (2026-11-16): node-status.js merged rows in state `expired` without counting them, so 4 real rows printed as 0.

3. Write one boundary test per bound: for a limit of N, name the N-valid case, the N+1-invalid case, and each character class.
   - Failure (2026-11-16): node-request-log.js had no test for a 31-character id or for an uppercase id.

4. A draft can read only the repo it is drafted in, so paste into the task text any facts it needs from other repos.
   - Failure (2026-11-16): the account-switcher design task named cloud-providers code and ended blocked as an infra-error.

5. Name the exact files and functions, give a `Files:` line, state the test command, and state how many tests exist today.
   - No single incident.

6. Ask the drafter to apply three mutants to its own code and confirm that a test fails for each one.
   - No single incident.

7. When real data exists, make the acceptance criteria include a real-data smoke run, with its command.
   - No single incident.

8. A task that adds a new file must say the file does not exist and must be created, and must name runtime output files (such as a manifest written into a caller-supplied directory) as NOT repo files.
   - Failure (2026-11-16): node-code-publish produced no diff twice because the plan-grounding gate treated the runtime file name as a missing repo file.
