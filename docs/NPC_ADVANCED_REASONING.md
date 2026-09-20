# C-03.5 NPC Advanced Reasoning

## Purpose

C-03.5 upgrades the zero-cost NPC brain from per-player heuristic scores to a layered evidence model plus bounded world hypotheses. It is deliberately **non-authoritative**: every result is a belief, not game truth.

## Five reasoning layers

### 1. Identity logic

Question: if this player were a villager / wolf / god / claimed role, how natural is the observed behavior?

Implemented signals include:

- seer claim with or without check output;
- competing / later role counterclaims;
- role claims and check behavior used as world-fit evidence.

A behavior is never considered wolf-exclusive.

### 2. Information logic

Question: does the speaker's certainty exceed the information publicly available to them?

Implemented signals include:

- `EXCESS_CERTAINTY` for unsupported absolute alignment reads;
- `HIDDEN_ROLE_OVERREACH` for high-certainty hidden-role claims without a public role proof;
- `KNIFE_INFO_CLAIM` as role-fit evidence for information-capable roles.

These signals remain soft because a player can guess correctly, exaggerate, bluff, or speak imprecisely.

### 3. Temporal logic

Question: what new information appeared between two different positions?

Alignment-read reversals are classified as:

- `EXPLAINED`: a strong target-specific trigger appeared, such as a check claim or rule-proof event;
- `PARTIALLY_EXPLAINED`: general new information such as vote/death results appeared;
- `UNEXPLAINED`: no visible trigger was found.

Only the unexplained case receives meaningful suspicion weight, and it is still not a hard fact.

### 4. Utility logic

Question: who benefits from an action or death?

Implemented low-weight signals include:

- `DEATH_REMOVES_ACCUSER` — a critic dies, which benefits the criticized target but may also be deliberate framing;
- `BUSSING_PLAUSIBLE` — voting an already heavily pressured known wolf can buy good-player credit.

Utility evidence is intentionally weak because benefit does not imply causation.

### 5. World logic

The engine creates complete 12-seat role worlds that must satisfy:

- the locked WB12 public role counts;
- the NPC's own exact identity;
- legal initial wolf-team knowledge;
- private seer faction checks;
- rule-proof public facts such as self-explosion and hunter shot.

It scores worlds using:

- C-02 faction beliefs;
- role-claim fit;
- check-claim fit;
- C-03.5 soft evidence;
- explicit assumption cost.

## Bounded search

The complete WB12 space is too large for per-turn exhaustive search. C-03.5 uses constrained Beam Search:

```text
hard constraints
  ↓
candidate role assignment
  ↓
beam width = 64
  ↓
complete candidate worlds
  ↓
Top 8 persisted worlds
```

For contested special-role claims, the engine runs anchored alternatives and preserves at least one feasible world per claimant when possible. This prevents the Top-K list from being filled by trivial permutations of only one interpretation.

The alternative world's score is **not** artificially increased; diversity affects selection, not scoring.

## Marginals and strategy

Top worlds are converted into per-player marginals:

- wolf likelihood;
- most likely role;
- role confidence.

C-03 strategy blends world wolf likelihood at only ~25% for uncertain players. C-02 hard facts always override the world model.

## Persistence and compatibility

`NpcCognitiveState` now contains `advancedReasoning`:

- evidence;
- temporal transitions;
- Top-8 worlds;
- marginals.

No new database table is required because cognition is already persisted as JSON in `werewolf_npc_cognitive_states`.

Legacy C-03 JSON without `advancedReasoning` is upgraded with an empty snapshot by `parseNpcCognitiveState()`.

## Security / information boundary

C-03.5 consumes only:

```text
PlayerView-derived cognitive state
+ public ruleset catalog
```

It never accepts raw `GameState`, raw Event Stream, SYSTEM_TRUTH, or another player's private view. `windowToken` is neither accepted nor persisted by advanced reasoning.

## Cost

C-03.5 uses deterministic TypeScript CPU logic only:

```text
OpenAI API = 0
LLM API = 0
GPU inference = 0
```
