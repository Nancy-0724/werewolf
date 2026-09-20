# A-02 implementation scope used for this repository

The supplied package contained the authoritative `A_CORE_SPEC_v1.0.md` and an executable A-01 prompt, but no separate A-02 prompt. The user explicitly requested A-02 implementation, so this milestone was bounded directly from section 15 of the authoritative core spec:

> A-02: 規則registry、phase/session、基礎夜間意圖與資源。無NPC。

Implemented interpretation:

1. Add a code-owned role/ability/handler whitelist registry.
2. Add `GameStarted`, runtime state, phase state and action-session state.
3. Collect first-night intents in the specified order: Guard → Wolf ballots/locked target → Beauty → Witch → Seer.
4. Use trusted PLAYER principal + matching actor + opaque window token for player commands.
5. Persist legal Witch resource consumption atomically with the Witch command.
6. End at `NIGHT_READY_FOR_RESOLUTION`.
7. Do not apply protection/charm/heal/poison/check results, deaths, hunter reactions, announcements or win conditions; those remain A-03+.
8. Preserve all A-01 tests and invariants.

This document records the chosen milestone boundary; it does not supersede `docs/spec-source/A_CORE_SPEC_v1.0.md`.
