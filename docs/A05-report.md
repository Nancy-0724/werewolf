# A-05 Implementation / Verification Report

## Scope

A-05 adds persistence, recovery, snapshots and continuation compatibility without changing A-01～A-04 game rules.

Implemented:

- repository port abstraction;
- durable command orchestration;
- in-memory durable store for restart/recovery tests;
- PostgreSQL durable store and migration;
- snapshot creation/hash validation/recovery;
- snapshot + tail replay;
- fallback full replay;
- persistent command idempotency;
- durable optimistic concurrency;
- pending reaction recovery;
- history-only compatibility assessment.

## Test inventory

```text
A-01  24
A-02  20
A-03  16
A-04  24
A-05  20
------------
Total 104
```

## Offline smoke execution

Because this container could not reliably install the declared npm dependencies, a temporary compatibility layer located **outside this repository** was used to execute the compiled test flows. It is not part of the artifact.

Observed smoke results:

```text
A-01 24/24
A-02 20/20
A-03 16/16
A-04 24/24
A-05 20/20
Total 104/104
```

A-04 was split into individual executions because repeated full-stream replay under the temporary shim was slow; all 24 individual cases completed successfully.

These results are a logic smoke check only. They do not replace the declared Vitest + TypeScript toolchain.

## A-05 cases

- A05-01 durable truth survives service/process replacement
- A05-02 command idempotency survives restart
- A05-03 command ID reuse with changed payload is rejected after restart
- A05-04 explicit checkpoint uses latest command boundary
- A05-05 snapshot inside a multi-event command is rejected
- A05-06 snapshot + tail equals full replay
- A05-07 corrupt snapshot falls back to full replay
- A05-08 missing snapshot falls back to full replay
- A05-09 build ID may change when contracts remain compatible
- A05-10 unsupported historical event version becomes HISTORY_ONLY
- A05-11 pending Hunter reaction survives restart exactly once
- A05-12 two commands from one revision allow at most one commit
- A05-13 snapshot write failure does not roll back truth
- A05-14 snapshot interval creates recoverable cache
- A05-15 snapshot contains state only
- A05-16 PostgreSQL migration contains four truth/cache tables and constraints
- A05-17 pool adapter commits interactive transaction
- A05-18 pool adapter rolls back on failure
- A05-19 incompatible registry versions become HISTORY_ONLY
- A05-20 broken sequence remains INVALID_EVENT_STREAM

## Formal toolchain status

The repository declares Node 24, TypeScript, Zod and Vitest. Final packaging attempted the formal commands in this container:

```text
npm install       -> timed out before dependencies were installed
npm run typecheck -> exit 2: @types/node and vitest/globals unavailable because install did not complete
npm test          -> exit 127: vitest not installed
npm run build     -> exit 2: @types/node unavailable because install did not complete
```

These are environment/dependency-install failures, not formal test PASS results. GitHub Actions remains the authoritative declared-toolchain verification path. A PASS is reported only if the actual command exits successfully.

## Live PostgreSQL boundary

No live PostgreSQL service or secret credentials were provided in this execution environment. Therefore:

- migration SQL exists;
- PostgreSQL adapter exists;
- transaction wrapper semantics are tested;
- actual network/database integration is **not** claimed as verified.
