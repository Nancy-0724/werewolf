# C-03.5 Implementation Report

## Scope

Implemented five-layer soft reasoning and bounded world hypotheses on top of C-01/C-02/C-03 without changing Core rules or Player View boundaries.

## Added

- `src/npc/advanced/schemas.ts`
- `src/npc/advanced/signals.ts`
- `src/npc/advanced/worlds.ts`
- `src/npc/advanced/engine.ts`
- `src/npc/advanced/index.ts`
- `tests/npc/c035.test.ts`
- `docs/NPC_ADVANCED_REASONING.md`

## Integration changes

- `NpcCognitiveState` persists an `advancedReasoning` snapshot.
- legacy cognitive JSON is upgraded by `parseNpcCognitiveState()`.
- `NpcCognitiveStateService` now runs C-03.5 before C-03 strategy.
- C-03 target scoring uses world marginals as a 25% soft refinement for unknown players only.
- claim parser now recognizes `我才是...` role counterclaims.

## Offline executed regression

Using an external temporary compatibility runner that is **not included in the delivery ZIP**:

```text
C-01    24/24
C-02    24/24
C-03    30/30
C-03.5  28/28
----------------
NPC subtotal 106/106
```

A Web memory-demo smoke also created a 1-human + 11-NPC game and advanced 10 steps through the C-03.5 pipeline until the human sheriff-signup decision point.

## Formal npm status

`npm install --ignore-scripts --no-audit --no-fund` was attempted in this container and did not complete within 60 seconds because external package retrieval remained unavailable/blocked. Therefore formal `npm run typecheck`, real Vitest, and Next.js build are **not claimed PASS here**. GitHub Actions remains the formal CI path.

## Boundaries

Not implemented in C-03.5:

- natural-language Persona Speech Engine (C-04);
- LLM / OpenAI API;
- new game rules;
- new DB tables;
- exhaustive world enumeration.
