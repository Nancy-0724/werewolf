# C-01 NPC Cognitive State Contract

## 1. Purpose

C-01 introduces durable per-NPC cognition **without introducing an AI/LLM decision maker**.

Its job is to answer:

- What has this NPC legally observed?
- What facts does this NPC know with certainty?
- What beliefs / suspicions may future reasoning mutate?
- What claims has the NPC extracted from public speech?
- What was the NPC's current theory and prior decision history?

It is not a second game state and it is never authoritative for rules.

## 2. Information boundary

Input is `PlayerView` only.

Forbidden inputs:

- `GameState`
- raw Core `DomainEvent[]`
- Event Store bundle
- SYSTEM_TRUTH projections
- another player's PlayerView

This preserves the B-layer information firewall for both heuristic and future LLM NPCs.

## 3. Facts vs beliefs

Cognition keeps exact knowledge separate from inference.

Exact facts currently come from:

1. SELF identity.
2. `initiallyKnownIdentities` legally published by Player View (wolf team knowledge).
3. private Seer check faction results.
4. `finalReveal`, only after the game is over.

A claim such as “3號說自己是預言家” is a `ClaimLedger` item, not `knownRoleId = SEER`.

Likewise `wolfLikelihoodBps`, trust and suspicion are beliefs. They cannot mutate Game Core truth.

## 4. Persona

Persona is selected deterministically from `(gameId, npcPlayerId)` and a code-owned preset catalog.

No RNG, clock, API, LLM or environment input is used.

Current archetypes:

- ANALYST
- CAUTIOUS
- ASSERTIVE
- SOCIAL
- SKEPTIC
- OPPORTUNIST

The traits are future decision weights, not hidden game knowledge.

## 5. Observation cursor and memory

C-01 records only Player View observations:

```text
PUBLIC:<ordinal>
PRIVATE:<ordinal>
```

The public/private cursors are monotonic and observation ordinals must remain contiguous from 1. A stale Player View that would move a cursor backward is rejected.

Memory is bounded to 256 entries. Pruning removes ROUTINE memories first, then IMPORTANT, then CRITICAL if the cap must still be enforced. Cursor/stat counters continue to record that earlier observations were consumed.

C-02 now distills supported speech claims and deterministic evidence into beliefs/claims/working theory before episodic detail ages out. Auto claims already persisted in the ledger are retained when their original speech memory is later pruned.

## 6. Capability safety

`availableActions` and `windowToken` are intentionally not copied into cognitive state.

The NPC must obtain a fresh PlayerView immediately before building a Core Command. A persisted brain can remember intent, but not a stale capability token.

## 7. Lazy cognition

C-01 is integrated in Web Alpha immediately before the current deterministic bot considers an NPC action.

This means only the NPC whose turn matters synchronizes. We do not fan out 11 cognition updates every time any public event is appended.

C-02 follows the same principle: only the NPC currently being considered runs heuristic reasoning.

## 8. Persistence

`NpcCognitiveStore` has two adapters:

- `InMemoryNpcCognitiveStore` — disposable local/demo mode.
- `PostgresNpcCognitiveStore` — production/Vercel mode.

Database table:

```text
werewolf_npc_cognitive_states
(game_id, player_id) PK
contract_version
revision
state_json
```

Writes use expected revision optimistic concurrency.

The table references `werewolf_games` and is removed automatically when a game is deleted.

## 9. C-02 usage of this state

C-02 currently updates:

- trust/suspicion scores
- wolf likelihoods where not exact facts
- deterministic auto-extracted Claim Ledger entries
- Working Theory
- evidence references

C-02 still must not:

- change exact Game Core identity
- invent private observations
- inspect SYSTEM_TRUTH
- bypass Core validation
- persist `windowToken`

Role-specific action/deception strategy remains C-03.
