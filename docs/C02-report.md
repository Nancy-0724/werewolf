# C-02 Implementation Report

## Delivered

- Deterministic zero-cost heuristic reasoning engine.
- Conservative deterministic speech claim extraction for role/check/alignment/vote-intent claims.
- Exact-fact anchoring: heuristic evidence cannot overwrite legal hard facts.
- Public proof handling for self-explosion and hunter shot.
- Claim contradiction / check validation / vote-pattern / vote-intent consistency evidence.
- Persona-sensitive weighting for skepticism and consistency.
- Ranked suspect/trust report and persistent working theory.
- `NpcCognitiveStateService.loadSynchronizeAndReason()` integrates C-02 into lazy NPC cognition.
- Web Alpha NPC orchestration now synchronizes and reasons only when an NPC is about to consider a move.
- No OpenAI API, external model, GPU, network, RNG or wall clock required.

## Explicitly not in C-02

- Full role-specific action strategy (C-03).
- Persona-driven natural-language generation (C-04).
- OpenAI or local LLM integration.
- Game-rule changes.
- Any bypass of Player View / Core validation.

## Verification

C-02 adds 24 test definitions (`tests/npc/c02.test.ts`).

A delivery-external compatibility runner executed:

- C-01 regression: 24/24
- C-02: 24/24

The temporary compatibility shim is not included in the repository.

A syntax transpilation check over all project TypeScript / TSX files reported zero syntax diagnostics.

A formal `npm install` was attempted in this environment but timed out while downloading external packages. Therefore formal Vitest, full TypeScript typecheck and Next.js build are **not** reported as passing here. GitHub Actions remains the authoritative full toolchain verification path.
