# C-02 NPC Heuristic Reasoning Engine

C-02 adds deterministic, zero-API-cost reasoning on top of the C-01 cognitive state.

## Boundary

```text
PlayerView
  ↓
C-01 synchronization / memory
  ↓
C-02 heuristic reasoning
  ↓
Beliefs + Claim Ledger + Working Theory
```

C-02 does not accept `GameState`, raw event envelopes, SYSTEM_TRUTH, `windowToken`, network data, an LLM, RNG, or a wall clock.

## Reasoning principle

Beliefs are recomputed from the currently persisted legal evidence instead of repeatedly adding deltas to the previous score. Re-running the same state is therefore idempotent.

Hard facts remain anchors:

- self identity
- legal initial identity knowledge such as wolf teammates
- private seer faction checks
- post-game reveal
- public rule-proof events such as self-explosion (wolf faction) and a hunter shot (hunter / good)

A public speech claim never becomes identity truth by itself.

## Deterministic claim extraction

C-02 performs conservative best-effort parsing of speech for:

- self role claims
- seer check-result claims
- alignment reads
- vote intents

Parsed claims are stored with stable IDs such as `AUTO:SPEECH:<ordinal>:...`. Unsupported free-form text is left as ordinary episodic memory.

## Evidence currently evaluated

- incompatible role claims by one speaker
- a role counterclaim against the NPC's legally known unique role
- check-result claims that match or contradict known faction evidence
- conflicting check results from the same speaker
- alignment reads later checkable against known faction evidence
- votes against known wolves / known good players
- pressure from a known wolf on another player (weak anti-correlation only)
- declared vote intent versus actual later ballot
- self-explosion
- hunter shot

Ordinary death alone does not reveal alignment because public death causes are hidden and this ruleset allows wolf-team attack targets that cannot safely be assumed good.

## Persona weighting

C-01 persona traits influence only evidence weighting, not information access. For example:

- `skepticism` scales contradiction sensitivity
- `consistencyBias` scales speech/vote consistency evidence

Persona can change how strongly an NPC reacts to the same legal evidence, but cannot manufacture facts.

## Output

C-02 updates:

- `beliefs[].wolfLikelihoodBps`
- `beliefs[].trustScore`
- `beliefs[].suspicionScore`
- `beliefs[].evidenceMemoryIds`
- deterministic auto claims in `claimLedger`
- `workingTheory.supportedPlayerId`
- `workingTheory.opposedPlayerId`
- `workingTheory.voteIntentPlayerId`

It also returns an ephemeral `NpcHeuristicReasoningReport` for tests/debugging. The report is not game authority.

## Scope boundary for C-03

C-02 is analysis, not complete role strategy. C-03 will decide how a role uses this analysis: wolves may deceive/bus, seers choose check targets, witches choose medicine policy, and so on. Every resulting action must still be rebuilt from a fresh PlayerView and validated by Core.
