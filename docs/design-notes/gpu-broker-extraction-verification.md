# GPU broker extraction: verification note

Map path (canonical): `docs/design-notes/gpu-broker-extraction-map.md`. The `Docs/gpu-broker-extraction-map.md` path does not exist.

The map header says the broker is built and live as of 2026-10-23. This note records what was checked against the map in this pass. It does not re-verify the broker repo, PromptForge or VideoForge directly, and the grep below covered only the primary repo.

## G0 to G8 status (map section 3 and its state line, 2026-10-23)

| G | Status | Blocking dependency or decision |
|---|---|---|
| G0 | DONE: scaffold `agent-manager-gpu-broker` (broker `ffc8946`), port 7449 | none |
| G1 | DONE: session core moved into the broker (broker `3081330`) | none |
| G2 | DONE: broker `1c2adf4`, PromptForge `3cd9d52`, VideoForge `2b2340d`; cutover live 2026-10-22/23 | none |
| G3 | G3a DONE (core `a0c104dc`); tool-loop fix DONE (core `37411512`); G3b open and optional (flip default yield URL to the broker) | G3b is optional and not blocking |
| G4 | G4a DONE (PromptForge `c67b380`, card-scoped lease). Map state line: G4 is probably retired | owner call; blocks nothing |
| G5 | RETIRED. Map section 5: G5 had nothing left to change (`scripts/stop.sh` already keeps plugins) | none |
| G6 | DONE, rebuilt as the broker card page (map section 3 state line) | none |
| G7 | G7a, G7b, G7c DONE (G7c pointer added 2026-10-23) | none |
| G8 | DONE (owner direction 2026-10-22/23): card registry, preferences, Chat card selection | none |

The tracker's "NOT YET FILED" wording for G0, G1, G2, G4, G6 and G7 predates the map's 2026-10-23 status update. The map is the newer record.

## Section 4 decisions (map section 4)

All five are answered. The map records that the owner took the recommended defaults on 2026-10-22.

1. Name and port: answered. Repo `agent-manager-gpu-broker`, plugin `gpu-broker`, port 7449.
2. Registration: answered. A plain plugin in `plugins.json`, not a dashboard tab at first.
3. Pipeline start/stop: answered. Lease and ComfyUI only until G4 proves out. Pipeline pause/resume stays a core API the broker calls.
4. Lease file: answered. It stays at the same path and schema.
5. ComfyUI lifecycle: answered. The broker owns it.

Map section 5 open questions are answered except one new question from 2026-10-22: whether PromptForge's `/api/comfy/start` should go through the broker. That question is open.

## AGENT_MANAGER_GPU_BROKER_URL hits

The grep returned 20 matching lines. An earlier draft of this note said 21; that was a counting error.

Classification key: configurable-in-core (core reads the variable at runtime), hard-coded (a literal broker URL in source), in-app (inside PromptForge or VideoForge), doc or test (not runtime code).

| File | Line | Classification |
|---|---|---|
| `docs/design-notes/gpu-broker-extraction-map.md` | 42 | doc reference |
| `docs/design-notes/gpu-broker-extraction-map.md` | 70 | doc reference |
| `docs/design-notes/gpu-broker-extraction-map.md` | 76 | doc reference |
| `docs/design-notes/initiative-record-design.md` | 739 | doc reference |
| `scripts/agent-manager-common.sh` | 106 | comment |
| `scripts/agent-manager-common.sh` | 109 | configurable-in-core (shell default chain) |
| `scripts/gpu-broker-url.test.js` | 19 | test fixture key |
| `scripts/gpu-broker-url.test.js` | 37 | test fixture |
| `scripts/gpu-broker-url.test.js` | 38 | test fixture |
| `scripts/gpu-broker-url.test.js` | 39 | test fixture |
| `scripts/gpu-broker-url.test.js` | 40 | test fixture |
| `scripts/gpu-broker-url.test.js` | 41 | test fixture |
| `src/chat-card.js` | 71 | configurable-in-core (Chat broker URL, fallback `http://localhost:7449`) |
| `src/chat-card.test.js` | 94 | test title |
| `src/chat-card.test.js` | 96 | test fixture |
| `src/chat-card.test.js` | 97 | test fixture |
| `src/gpu-guard.js` | 141 | comment |
| `src/gpu-guard.js` | 146 | configurable-in-core (yield URL, fallback `http://localhost:7430`) |
| `src/gpu-guard.test.js` | 428 | test fixture |
| `src/gpu-guard.test.js` | 430 | test fixture |

No hit is hard-coded. No hit is in-app in this repo. The G3a claim that the URL is configurable in core holds for `scripts/agent-manager-common.sh:109`, `src/gpu-guard.js:146` and `src/chat-card.js:71`.

## Criteria check

- Map path cited correctly: yes.
- G0 to G8 each have a status and blocker: yes.
- All hits listed with file and line: yes, 20 rows.
- Section 4 decision status recorded: yes, all five answered.
- No source files outside `docs/design-notes/` modified: yes. This pass wrote only this file.
