# A-02 Implementation Report

Date: 2026-09-19

## 1. Scope delivered

A-02 was implemented on top of the existing A-01 event-sourced core. The authoritative boundary is section 15 of `docs/spec-source/A_CORE_SPEC_v1.0.md`: rules registry, phase/session, base night intents and resources, no NPC.

Delivered:

- A code-owned WB12 role/ability/handler whitelist registry.
- `GameStarted` and `RuntimeState` initialization.
- Typed `PlayerRuntime`, ability states, phase state and action session state.
- Trusted player action authorization using matching `PLAYER` principal, `actorPlayerId`, and opaque `windowToken`.
- First-night collection flow:
  - Guard target/pass.
  - Four wolf ballots, including self/team/pass, followed by deterministic locked knife target; tied highest options become `NO_KILL` (`null`).
  - Wolf Beauty `CHARM`/`KEEP` intent.
  - Witch single complete `PASS` / `HEAL` / `POISON` decision.
  - Atomic `AbilityResourceSpent` for valid Witch HEAL/POISON.
  - Seer target/pass intent.
- A-02 terminal phase: `NIGHT_READY_FOR_RESOLUTION`.
- Multi-event command receipts and import validation for sequence ranges/batch shapes.
- Reducer-side replay hardening against skipped phases, forged action-session snapshots, premature wolf-window close and Witch resource-spend omission.
- A-01 regression suite retained.

Deliberately not implemented in A-02:

- Protection/charm/heal/poison effect resolution.
- Seer result calculation/private observation.
- `StatusApplied` / `StatusExpired`.
- Death waves, Hunter reactions, resolution groups or win conditions.
- Dawn announcements, sheriff election, speech, day voting, PK, self-explosion, last words.
- Player View, NPC/LLM, UI/API, database/snapshot persistence.

## 2. Changed / added files

Core:

- `src/core/domain/schemas.ts`
- `src/core/domain/errors.ts`
- `src/core/domain/reducer.ts`
- `src/core/rulesets/registry.ts` — new
- `src/core/rulesets/wb12.ts`
- `src/core/application/gameService.ts`
- `src/core/serialization/bundle.ts`
- `src/index.ts`

Tests:

- `tests/core/a01.test.ts` — retained; T23 updated because `StartGame` is now a valid A-02 command.
- `tests/core/a02.test.ts` — new; A02-01 through A02-20.

Repository / documentation:

- `README.md`
- `AGENTS.md`
- `docs/architecture.md`
- `docs/DECISIONS.md`
- `docs/PROMPT_02_IMPLEMENTED.md` — records the A-02 boundary because the supplied source package did not contain a separate executable A-02 prompt.
- `.github/workflows/core-ci.yml`
- `package.json` version updated to `0.2.0`.

## 3. A-02 event / command model

New commands:

- `StartGame`
- `CommitGuardAction`
- `CommitWolfBallot`
- `CommitBeautyAction`
- `CommitWitchAction`
- `CommitSeerAction`

New A-02 events:

- `GameStarted`
- `PhaseOpened`
- `PhaseClosed`
- `ActionWindowOpened`
- `ActionWindowClosed`
- `NightActionCommitted`
- `AbilityResourceSpent`
- `WolfBallotCommitted`
- `WolfTargetCommitted`

A successful command can now atomically append multiple events. The command receipt stores `firstSequence` and `lastSequence`; bundle import requires receipt ranges to cover every event exactly once and validates the permitted command-specific event shape.

## 4. A-02 test mapping

| ID | Coverage |
|---|---|
| A02-01 | registry: 7 roles, 11 abilities, handler whitelist, unknown IDs rejected |
| A02-02 | StartGame runtime initialization and first Guard window |
| A02-03 | StartGame idempotency / distinct second start rejected |
| A02-04 | matching player principal + current window token required |
| A02-05 | Guard self-protect/pass semantics and advance to Wolf |
| A02-06 | Wolf target self/team/pass and immutable committed ballot |
| A02-07 | unique wolf plurality locks target and advances |
| A02-08 | highest-vote tie resolves to NO_KILL |
| A02-09 | Beauty self-charm rejected; teammate charm / KEEP supported |
| A02-10 | Witch HEAL only actual knife target; heal resource atomically spent |
| A02-11 | Witch poison cannot self; poison-only spend; PASS spends nothing |
| A02-12 | Seer cannot self-target; target/pass accepted |
| A02-13 | complete A-02 night stops before effects/deaths/outcome |
| A02-14 | successful player command retry adds no duplicate intent/resource |
| A02-15 | same commandId changed request/principal rejected |
| A02-16 | multi-event export/import round-trip preserves exact runtime/receipts |
| A02-17 | corrupt multi-event receipt range import rejected atomically |
| A02-18 | forged action-session eligibility rejected by replay |
| A02-19 | forged phase skip rejected by replay |
| A02-20 | Witch HEAL stream cannot close window if resource-spend event is missing |

A-01 T01–T24 remain present and were included in the offline regression run.

## 5. Declared runtime / dependency baseline

Repository target:

- Node.js 24.21.0 (`.nvmrc`; package engine `>=24 <25`)
- Zod 4.6.5
- Vitest 5.0.1
- Vite 8.3.0
- TypeScript 7.0.2
- `@types/node` 24.13.6

Actual artifact-generation environment:

- Node.js `v22.16.0`
- npm `10.9.2`
- npm registry DNS/network unavailable (`EAI_AGAIN`)

No hand-authored `package-lock.json` is included. A real lockfile must be generated by `npm install` in a network-enabled Node 24 environment.

## 6. Commands actually executed

### `npm install --ignore-scripts --fetch-retries=0 --fetch-timeout=5000 --no-audit --no-fund`

Exit code: **1**

```text
npm error code EAI_AGAIN
npm error syscall getaddrinfo
npm error errno EAI_AGAIN
npm error request to https://registry.npmjs.org/@types%2fnode failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org
```

### `npm run typecheck`

Exit code: **2** — dependencies/type packages were unavailable, so this is not a source-code failure verdict.

```text
> werewolf-a-core@0.2.0 typecheck
> tsc --noEmit

error TS2688: Cannot find type definition file for 'node'.
error TS2688: Cannot find type definition file for 'vitest/globals'.
```

### `npm test`

Exit code: **127** — Vitest could not be installed because dependency installation failed.

```text
> werewolf-a-core@0.2.0 test
> vitest run

sh: 1: vitest: not found
```

Formal Vitest result: **not executed**.

### `npm run build`

Exit code: **2** — `@types/node` was unavailable.

```text
> werewolf-a-core@0.2.0 build
> tsc -p tsconfig.build.json

error TS2688: Cannot find type definition file for 'node'.
```

## 7. Additional offline verification (non-formal)

To avoid claiming unexecuted tests as PASS, temporary compatibility modules/declarations were created only in the working environment and removed before packaging. They are not part of the repository.

A strict TypeScript pass against the temporary declarations completed with exit code 0.

The same compiled test source was then executed with the temporary synchronous test/Zod compatibility layer:

```text
A-01 Smoke summary: 24 passed, 0 failed
A-02 Smoke summary: 20 passed, 0 failed
Total: 44 passed, 0 failed
```

Source audit also found no `@ts-ignore`, `@ts-nocheck`, core `any`, `Math.random`, `Date.now`, or `eval(` use in `src/` / test implementation. The only textual `any` match was the English word “any” in an A-02 test title.

These checks increase confidence but do not replace the declared Node 24 + official Zod/Vitest verification.

## 8. Remaining acceptance step

Run in a network-enabled Node 24.21.0 environment:

```bash
npm install
npm run typecheck
npm test
npm run build
git add package-lock.json
```

GitHub Actions (`.github/workflows/core-ci.yml`) is configured to perform the same install → typecheck → test → build sequence on Node 24.21.0.

## 9. Stop point

A-02 is intentionally stopped at:

```text
GameState.status = IN_PROGRESS
runtime.phase.phaseType = NIGHT_READY_FOR_RESOLUTION
runtime.nightSession.status = READY_FOR_RESOLUTION
runtime.players = all still ALIVE
runtime.statusEffects = []
runtime.resolutionGroup = null
runtime.outcome = null
```

A-03 should consume these locked night intents and resources to perform typed effect resolution, status application, death waves, Wolf Beauty link handling, Hunter reactions and the resolution-group win checkpoint.
