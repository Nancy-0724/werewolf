# C-03 Implementation Report

## Delivered

- Deterministic zero-API-cost role strategy engine.
- New `src/npc/strategy/` contract + engine.
- Guard, wolf ballot, wolf beauty, witch, seer and hunter night/reaction policies.
- Good/wolf day ballot strategy.
- Sheriff signup, withdrawal, sheriff ballot, speech-order and badge policies.
- Pressure-gated wolf self-explosion policy.
- Basic strategic speech content including legal seer reveal and high-deception wolf fake-seer option.
- Strategy choices never contain or persist `windowToken`.
- `NpcCognitiveStateService.loadSynchronizeReasonAndStrategize()` now performs C-01 → C-02 → C-03 in lazy cognition.
- Strategy decisions enter non-authoritative decision history as PLANNED and can be marked COMMITTED/REJECTED.
- Web auto-advance now uses C-03 instead of the previous Alpha-bot action policy.
- Core command validation and Player View remain unchanged.
- No OpenAI API, external model, GPU, RNG, network or wall-clock decision dependency.

## Explicitly not in C-03

- Rich persona-specific natural-language speech (C-04).
- LLM / local model integration.
- New game rules.
- SYSTEM_TRUTH access from NPC policy.
- Multiplayer-human networking changes.

## Verification

C-03 adds 30 test definitions (`tests/npc/c03.test.ts`).

A delivery-external compatibility runner executed:

- C-01 regression: 24/24
- C-02 regression: 24/24
- C-03: 30/30

A memory-demo Web integration smoke created games with different human seats and confirmed NPC C-03 auto-advance stops at a valid human decision boundary.

A syntax transpilation check over all project TypeScript / TSX files reported zero syntax diagnostics.

A formal npm toolchain run is still subject to external package-download availability in this environment; formal Vitest, TypeScript typecheck and Next.js build are therefore left to GitHub Actions unless the install succeeds during delivery verification.
