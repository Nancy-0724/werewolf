# C-03 NPC Role Strategy Engine

## Purpose

C-03 turns C-02 beliefs into legal role-aware action intent without using an external model.

```text
PlayerView
  +
NpcCognitiveState
  ↓
C-02 heuristic beliefs
  ↓
C-03 role strategy
  ↓
NpcStrategyDecision (NO windowToken)
  ↓
fresh PlayerView capability
  ↓
Core Command
```

The strategy layer is advisory. It cannot mutate game state and it cannot authenticate identity.

## Inputs

C-03 accepts only:

- the NPC's current `PlayerView`;
- that NPC's persisted C-01/C-02 cognitive state.

It has no API accepting `GameState`, `DomainEvent[]`, SYSTEM_TRUTH, database rows, or another player's private view.

## Output contract

`NpcStrategyDecision` contains:

- deterministic decision ID;
- role / public stage / round;
- structured strategy choice;
- target player ID when applicable;
- rationale codes;
- utility score.

It intentionally excludes `windowToken`.

## Strategy families

### Good roles

- **Guard**: protect trusted/high-value legal targets, avoid consecutive target, discourage self-locking.
- **Seer**: check high-information suspects, avoid already-known faction targets.
- **Witch**: heal legal non-wolf knife target; poison certain/high-confidence wolf; otherwise conserve potion.
- **Hunter**: shoot certain/high-confidence wolf; pass on weak information.
- **Villager**: use C-02 suspicion/trust for sheriff and day-vote policy.

### Wolf roles

- **Wolf ballot**: never knowingly knife packmate when a non-pack target exists; prioritize valuable likely-good targets.
- **Wolf beauty**: charm high-value good targets; keep an existing valuable charm rather than churning.
- **Day voting**: normally avoid packmates and blend into defensible non-pack targets.
- **Sheriff**: wolves may contest based on persona and support a legal packmate candidate.
- **Self explosion**: requires aggressive/risk-tolerant persona plus public pressure; it is not a default action.
- **Deception**: high-deception wolves may issue a simple fake-seer strategic statement. C-04 owns richer natural-language persona behavior.

## Sheriff and badge

- Seer joins sheriff by default.
- Other roles use persona thresholds.
- Wolf sheriff prioritizes legal packmate badge transfer.
- Good sheriff prioritizes trusted legal target.
- Speech-order choice begins near the current top suspect when possible.

## Determinism

For identical `PlayerView + NpcCognitiveState`, C-03 returns the same strategy decision.

No use of:

- `Math.random()`;
- wall clock;
- network;
- environment variables;
- OpenAI/LLM;
- GPU inference.

## Decision lifecycle

Cognition may persist:

```text
PLANNED → COMMITTED
PLANNED → REJECTED
```

This history is evaluation data only. If cognition persistence fails after a Core command commits, the Core result remains authoritative.

## Boundary to C-04

C-03 decides *what* the NPC wants to do and provides a minimal deterministic strategic speech template.

C-04 will decide *how that NPC says it*: persona-specific wording, verbosity, aggression, hedging, deception style and discourse consistency.
