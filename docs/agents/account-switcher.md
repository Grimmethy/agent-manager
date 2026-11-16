# Account switcher across Claude subscriptions (design)

Status: design only. No code, no credentials. The goal: run the Max account's weekly allowance down on the Haiku swarm, switch the swarm to the Pro account while the Max account is on cooldown, and switch back automatically. Related: `docs/agents/cloud-lane.md`, `docs/agents/node-cloud-worker.md`. Feature Forge entries: `gateway-limit-signal`, `token-burn-sprint`, `account-switcher-across-claude-subscriptions`.

## 1. The signal that an account is out

The gateway is the cloud-providers repo's process (`bin/cloud-providers.js`). One runs per Haiku lane: wok runs ten (ports 7450 and 7480-7488), grimm runs two (7450 and 7451). Each calls `claude -p` on the Claude login of the machine it runs on. There is no API key on this path.

In cloud-providers, `detectPlanLimit(text)` (`src/plan-limit.js`) returns `{ matched: true, message, resetsAt: string|null }` or `null`. The claude-subscription adapter calls it on a non-zero exit and answers `{ error: 'plan-limit', message, resetsAt }`.

Important: `detectPlanLimit` exists only on an UNMERGED cloud-providers branch (`agent/decompose-adhoc-ff-1-1a-detect-the-weekly-plan-limit...`). It is not on cloud-providers main. So grimm's gateway does not have it, and grimm is currently blind to this signal. Any switch design depends on merging it first.

## 2. Where an account identity lives

An account identity is a machine's `claude` login. Wok has one login (believed to be the Max login; to be confirmed by the owner). Grimm has its own Pro login. Accounts are named by label only (for example `max` and `pro`). This document names no token, no login file path, and no copy step. How logins are stored or moved between machines is an owner decision (section 7).

## 3. The switch rule

- **Trigger.** A `plan-limit` response from the active account starts a cooldown on that account. The cooldown ends at `resetsAt`. If `resetsAt` is null, a default cooldown applies (value: owner decision).
- **Arming.** The switch arms one one-shot timer at the moment of the switch, for the cooldown end. The timer is an event, not a poll. Nothing re-arms itself. If the process restarts, the next request re-checks the clock instead.
- **Return.** The next request after the cooldown end switches back to the recovered account. A hysteresis margin after `resetsAt` and a minimum dwell time stop flapping (values: owner decision).
- **Exclusivity.** On one machine, exactly one account is active at a time. Two machines may run different accounts, but no machine ever runs both.
- **In-flight drafts.** A draft already running finishes or fails on the account it started with. It is not silently retried on the other account (see section 7).
- **Reset-time parsing.** Reuse the pattern of `parseResetTime(text, eventTs)` in `budget-monitor.js:196-209`, which returns `null` when no reset text matches. Whether the cloud-side `resetsAt` format matches it is unverified.

## 4. What is recorded

A ledger of switches, one line per switch: timestamp, machine, from-account label, to-account label, reason (`plan-limit` or `cooldown-ended`). The ledger never records prompts, responses, tokens, or login paths. Its location is an owner decision.

## 5. Failure modes

- **Both accounts out.** The swarm stops and reports. It does not loop between accounts.
- **Switch loop.** Hysteresis and the minimum dwell time prevent rapid back-and-forth.
- **Missed reset time.** When `resetsAt` is null or already in the past, the default cooldown applies and the state is logged.
- **One machine switches, the other does not.** State is per machine. The ledger shows the split.
- **Gateway without the detector (grimm today).** The switch does not run. Traffic is not silently re-routed.
- **Existing Claude-side limit logic is not a switcher.** `budget-monitor.js` reads Claude Code transcripts and `src/claude-pause.js` is a manual global pause flag. Neither selects or switches between logins, so neither can stand in for this design.

## 6. Atomic buildable pieces

Each piece is a separate change.

- (a) Prerequisite, owner action: bring the unmerged `src/plan-limit.js` from the cloud-providers branch onto cloud-providers main. No git step is planned here.
- (b) Create `src/account-switch-state.js` in cloud-providers: a pure state machine (active label, cooldownUntil, dwell, ledger append). No timers.
- (c) Change the cloud-providers claude-subscription adapter: on `{ error: 'plan-limit' }`, call (b) and arm one one-shot timer for the cooldown end.
- (d) Create `test/account-switch.test.js` in cloud-providers, using node:test, covering cooldown, hysteresis, null `resetsAt`, and both-accounts-out.
- (e) Update `docs/agents/cloud-lane.md` in this repo with a pointer to this document and the grimm detector gap.
- (f) Create the ledger file at the location chosen in section 7.

## 7. Design decisions for the owner

- Design decision: how logins are stored or copied between machines. This document does not decide it.
- Design decision: the default cooldown when `resetsAt` is null.
- Design decision: the hysteresis margin and the minimum dwell time.
- Design decision: whether switching is per machine or fleet-wide.
- Design decision: whether in-flight drafts are failed or retried on the other account.
- Design decision: the ledger location.
- Design decision: whether to enable switching on grimm before the detector is merged.
