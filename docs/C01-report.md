# C-01 Implementation Report — NPC Cognitive State

Version: `0.8.0`

## Scope delivered

C-01 adds a zero-API-cost cognitive state layer for NPCs. No LLM/provider integration and no heuristic strategy engine are included yet.

Implemented:

- deterministic NPC persona presets
- exact-knowledge vs belief separation
- public/private observation cursors
- bounded episodic memory (256)
- private Seer faction knowledge integration
- structured Claim Ledger
- Working Theory state
- Decision History
- post-game reveal knowledge upgrade
- stale/truncated observation rejection
- no persisted action capability / windowToken
- in-memory cognitive store
- PostgreSQL cognitive store
- optimistic revision concurrency
- durable cognitive state service
- lazy Web Alpha integration before an NPC considers an action
- PostgreSQL migration `0002_c01_npc_cognitive_state.sql`
- migration runner upgraded to apply all ordered migration files

## Non-goals

C-01 does not implement:

- wolf/sheriff/seer strategic reasoning
- speech claim extraction
- automatic belief score changes from ballots/speeches
- LLM/API calls
- local GPU inference
- model routing
- C-02 decision policy

The existing deterministic Alpha bot still chooses the action. C-01 only synchronizes that NPC's legal cognition before the decision.

## C-01 tests

24 test definitions cover:

- NPC-only initialization
- deterministic persona
- self / wolf-team exact identity knowledge
- no capability-token persistence
- observation idempotency
- new public/private observation consumption
- Seer exact faction knowledge
- public death not revealing hidden role
- viewer/game mismatch rejection
- bounded memory
- Claim Ledger idempotency and target validation
- Working Theory / fact separation
- Decision History idempotency and ordinal order
- post-game full reveal only after final reveal exists
- schema JSON round trip
- cognitive store optimistic concurrency
- durable service initialization/synchronization
- delete-game cleanup
- no wall-clock timestamps in cognition
- stale PlayerView rejection
- non-contiguous observation rejection

A delivery-external temporary Zod-compatible smoke runtime executed these C-01 scenarios: **24/24 passed**. It is not included in this repository and is not reported as formal Vitest success.

## Static checks

A TypeScript transpile syntax scan across the repository is run during delivery preparation. Source scans also confirm `src/npc` does not import raw `GameState`, `DomainEvent`, replay, environment configuration, RNG or wall-clock APIs for decision/cognition logic.

## Formal toolchain status

The delivery environment does not currently resolve npm registry packages reliably. Therefore formal:

```text
npm install
npm run typecheck
npm test
npm run build:core
npm run build
```

must be executed by GitHub Actions / a normal networked Node 24 environment before treating them as formal PASS.
