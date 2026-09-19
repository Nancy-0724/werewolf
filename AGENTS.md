# Long-term implementation rules

1. Roles are assigned exactly once by `SetupLocked`; no later API may mutate identity in v1.
2. Game state is derived from the append-only event stream. State is never the authoritative store.
3. SYSTEM_TRUTH state/events must never be passed directly to NPCs or public/shared UI.
4. Speech is not identity authentication.
5. Do not skip milestones. A-01 stops at `LOCKED`/`ABORTED`; do not silently add A-02 mechanics.
6. Every behavior change requires tests. Never delete failing tests to claim completion.
7. Never report PASS unless the corresponding command was actually executed successfully.
8. Reducers/replay are pure: no RNG, clock, network, LLM, database, or environment reads.
9. Successful command writes are atomic with their command receipt and use expected-sequence concurrency checks.
