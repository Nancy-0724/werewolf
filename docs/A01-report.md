> Historical A-01 report. The current repository is A-02; see `docs/A02-report.md` for current verification status.

# A-01 Implementation Report

Date: 2026-09-19

## 1. Scope delivered

Implemented A-01 only:

- Create a game in `LOBBY`.
- Replace the complete 12-seat configuration.
- Validate the exact `wolf-beauty-12.app@1.0.0` ruleset snapshot.
- Assign the 12 roles once using Fisher–Yates through an injected RNG and atomically write `SetupLocked`.
- Stop playable progress at `GameState.status = LOCKED`, `runtime = null`.
- Append-only event stream, pure reducer/replay, command receipts/idempotency, optimistic concurrency and atomic append.
- Export/import protected SYSTEM_TRUTH JSON bundles.
- HOST may abort from `LOBBY` or `LOCKED`; locked identities/history remain preserved.

Not implemented: UI/PWA, API routes/authentication, `GameStarted`, night phases, skills, death resolution, sheriff/voting/speech, Player View, NPC/LLM, database/automatic persistence, snapshots, A-02+.

## 2. Files and architecture

Core implementation:

- `src/core/domain/errors.ts` — structured A-01 error codes.
- `src/core/domain/json.ts` — JSON-only cloning/checking and canonical key-order comparison.
- `src/core/domain/schemas.ts` — strict Zod schemas for seats, ruleset, commands, events, state, receipts and bundles.
- `src/core/domain/reducer.ts` — pure `reduceEvent` / `replay`; sequence/state/locked-assignment invariants.
- `src/core/rulesets/wb12.ts` — the single supported WB12 snapshot and whitelist validation.
- `src/core/application/ports.ts` — RNG/Clock/ID ports.
- `src/core/application/gameService.ts` — trusted command handling, idempotency, business validation and role assignment planning.
- `src/core/infrastructure/repository.ts` — multi-game in-memory event/receipt store with expected-sequence atomic append.
- `src/core/infrastructure/nodeAdapters.ts` — Node `crypto.randomInt`, UUID and system-clock adapters.
- `src/core/serialization/bundle.ts` — truth backup export/import and receipt/event correspondence validation.
- `src/index.ts` — package exports.
- `tests/core/a01.test.ts` — T01..T24 cases.
- `docs/architecture.md`, `docs/DECISIONS.md`, `AGENTS.md`, `README.md`.
- `docs/spec-source/` — supplied source specification and A-01 prompt retained for review.

## 3. Runtime/dependency baseline

Target declared by this repository:

- Node.js: 24.21.0 LTS (`.nvmrc`, package engine `>=24 <25`).
- Zod: 4.6.5 exact.
- Vitest: 5.0.1 exact.
- Vite: 8.3.0 exact (Vitest 5 peer dependency).
- TypeScript: 7.0.2 exact.
- `@types/node`: 24.13.6 exact.

Actual execution environment available while generating this artifact:

- Node.js: `v22.16.0`.
- npm: `10.9.2`.
- npm registry access: unavailable due DNS/network error `EAI_AGAIN`.

Because dependencies could not be fetched, a valid generated `package-lock.json` could not be produced in this environment. A broken hand-authored lockfile was intentionally not included. Run `npm install` once in a network-enabled Node 24 environment to generate the lockfile, then commit it before treating A-01 as fully accepted.

## 4. T01..T24 mapping

All cases are present in `tests/core/a01.test.ts`; they were **not successfully executed in this environment** because dependency installation failed before Vitest could be installed.

| ID | Test case |
|---|---|
| T01 | legal create/configure/lock; `LOCKED`, runtime null |
| T02 | 12 roles; exact role counts; WOLF/GOD/VILLAGER 4/4/4 |
| T03 | mixed HUMAN/NPC seats preserved |
| T04 | invalid seat count/IDs/numbers/name/controller rejected |
| T05 | no-seat lock rejected; PLAYER cannot issue HOST command |
| T06 | forged/unknown ruleset role/version/faction/ability/options rejected |
| T07 | post-lock seat change/second LockGame rejected; assignment unchanged |
| T08 | original input mutation cannot alter stored truth |
| T09 | returned state/event/export object mutation cannot alter repository truth |
| T10 | same command retry returns receipt; no extra event/RNG call |
| T11 | same command ID with changed request/principal rejected |
| T12 | sequences/event IDs and cross-game isolation |
| T13 | gap/duplicate/unknown type/version/contradictory replay rejected |
| T14 | replay non-mutating and deterministic |
| T15 | replay does not call RNG/Clock/ID ports |
| T16 | fixed RNG reproducible; invalid RNG produces zero partial lock writes |
| T17 | invalid event/receipt append is atomic zero-write |
| T18 | same expectedSequence race permits only one append |
| T19 | JSON round-trip recreates same state |
| T20 | imported old LockGame retry returns old receipt without reroll/event |
| T21 | corrupt/cross-game/missing/duplicate receipt imports rejected without pollution |
| T22 | Abort preserves locked assignments; new command rejected; retry idempotent |
| T23 | fake SetRole/PatchState/StartGame and extra SYSTEM field rejected |
| T24 | core outputs are JSON-serializable only |

## 5. Commands actually executed

### `npm install --ignore-scripts --fetch-retries=0 --fetch-timeout=5000`

Exit code: **1**

```text
npm error code EAI_AGAIN
npm error syscall getaddrinfo
npm error errno EAI_AGAIN
npm error request to https://registry.npmjs.org/@types%2fnode failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org
```

### `npm run typecheck`

Exit code: **2** — not a source-code PASS/FAIL result because dependencies/type packages were unavailable.

```text
> werewolf-a-core@0.1.0 typecheck
> tsc --noEmit

error TS2688: Cannot find type definition file for 'node'.
error TS2688: Cannot find type definition file for 'vitest/globals'.
```

### `npm test`

Exit code: **127** — Vitest was not installed because `npm install` failed.

```text
> werewolf-a-core@0.1.0 test
> vitest run

sh: 1: vitest: not found
```

Test count/result: **not executed**.

### `npm run build`

Exit code: **2** — not a source-code PASS/FAIL result because `@types/node` was unavailable.

```text
> werewolf-a-core@0.1.0 build
> tsc -p tsconfig.build.json

error TS2688: Cannot find type definition file for 'node'.
```

### Additional offline smoke check (non-formal)

Because npm dependencies were unavailable, an **external temporary compatibility shim** for the Zod/Vitest interfaces was created outside this repository only to exercise the compiled A-01 test logic. The shim is **not included in this artifact** and is not a substitute for the official dependency stack.

Result:

```text
Smoke summary: 24 passed, 0 failed
```

A strict TypeScript compile against the temporary declarations also completed with exit code 0. These results increase confidence in the source logic, but the acceptance status remains **formal npm/Vitest verification pending** until the repository is tested with its declared packages on Node 24.

## 6. Deviations / risks / incomplete verification

1. **Lockfile missing:** npm registry was unreachable; a real npm-generated lockfile could not be created. This is a specification deviation until `npm install` is run and the resulting single `package-lock.json` is committed.
2. **Formal verification pending:** T01..T24, typecheck and build are implemented/configured but cannot be marked PASS until run in a network-enabled Node 24 environment.
3. **No automatic persistence:** repository is intentionally in-memory. Bundle import/export is manual truth backup/recovery only.
4. **No Player View security claim:** all A-01 events are SYSTEM_TRUTH; no public endpoint or projection is implemented.
5. **A-02+ deliberately absent:** future command/event types are not accepted or silently ignored.

## 7. Review surface / core diff

This artifact was generated from an empty implementation workspace, so the core diff is the full content of these files rather than a patch against an earlier codebase:

- schemas: `src/core/domain/schemas.ts`
- reducer/replay: `src/core/domain/reducer.ts`
- command handler: `src/core/application/gameService.ts`
- repository: `src/core/infrastructure/repository.ts`
- serialization: `src/core/serialization/bundle.ts`
- tests: `tests/core/a01.test.ts`

Before A-01 is accepted, run on Node 24.21.0:

```bash
npm install
npm run typecheck
npm test
npm run build
git add package-lock.json
```

Do not start A-02 until those commands are reviewed and any resulting issues are fixed.
