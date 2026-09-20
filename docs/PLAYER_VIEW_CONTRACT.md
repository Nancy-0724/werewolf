# Player View Contract — B

## 1. Purpose

The Core knows the complete truth of the match. A browser or NPC must not.

B introduces two explicit projection contracts:

```text
SYSTEM_TRUTH event stream
        ↓
Projection layer
   ├─ PublicGameView
   └─ PlayerView(viewerPlayerId)
```

`PublicGameView` is safe for a shared/common screen. `PlayerView` is safe only for the authenticated player represented by `viewerPlayerId`.

The projection layer is read-only. It does not decide game outcomes and does not modify Core state.

## 2. Hard boundary

Player-facing code must never receive:

- raw `GameState`;
- raw `EventEnvelope` objects;
- SYSTEM_TRUTH export bundles;
- hidden event sequence numbers or transaction ids;
- raw death causes before the rules make them public;
- hidden night intents belonging to other roles;
- another player's `windowToken`;
- private RNG seed or debug/replay metadata.

A safe API shape is:

```text
GET /api/games/:gameId/public
  → PublicGameView

GET /api/games/:gameId/me
  authenticate user
  map user → seated playerId on server
  → PlayerView(playerId)
```

The client must not be allowed to choose an arbitrary `viewerPlayerId` and thereby request another seat's PlayerView.

## 3. PublicGameView

Public output contains only information everyone is currently allowed to know:

- public game status and a coarse stage (`NIGHT`, `DAWN`, `SHERIFF`, `DAY`, etc.);
- seat names/numbers and publicly known life state;
- public sheriff status;
- completed public speech;
- completed vote results;
- public deaths after announcement;
- public self-explosion / hunter shot / badge events;
- final public game result.

Role-specific night phase names are intentionally hidden. A public client seeing `NIGHT_WITCH` versus `NIGHT_SEER`, for example, could infer whether a role is still active.

## 4. PlayerView

A PlayerView contains the public view plus only that seat's legal private information:

```text
PlayerView
├─ public
├─ viewer
├─ identity
├─ abilityState
├─ privateObservations
├─ availableActions
├─ interactionStatus
└─ finalReveal
```

### Identity

Every player sees their own locked identity.

For WB12, wolf-team roles follow `WOLF_TEAM_WITH_SPECIAL_ROLE`, so a living wolf initially knows the identities of the other wolf-team members, including Wolf Beauty. Good roles do not receive teammates merely because Core knows them.

### Private observations

Current v1 B observations include:

- seer check result, only for the seer recipient;
- witch knife information according to the ruleset's knife-info policy;
- resolved wolf target for the fixed eligible living wolf recipients for that night.

Private observation `ordinal` is viewer-local and does not expose raw event sequence positions.

### Available actions

Only a player who can legally act now receives an action prompt and `windowToken`.

Examples:

```text
Guard → CommitGuardAction + legal targets + token
Witch → CommitWitchAction + legal targets/resources + token
Current speaker → CommitSpeech + token
Eligible voter → CommitBallot + token
```

A public/shared view never contains these tokens.

## 5. Death visibility

Core may already know a player is dead while the night is still unresolved from the players' perspective.

B therefore gates public life state:

```text
SYSTEM_TRUTH: player died at night
        ↓
Before DawnAnnouncementPublished
PublicGameView: ALIVE
        ↓
DawnAnnouncementPublished
PublicGameView: DEAD
```

The dawn announcement exposes the dead roster only. It does not expose `WEREWOLF_ATTACK`, `WITCH_POISON`, guard/heal collision, Beauty link cause, or other hidden cause metadata unless a later explicit rule says that information becomes public.

## 6. Voting privacy

An open vote does not expose partial ballots, partial tally, or how many players have already submitted.

Only after the vote session resolves does B publish the complete public vote result. Internal fields such as `committedAtSequence` remain hidden.

## 7. Speech is not certified truth

Published speech is visible verbatim, but a sentence such as `我是女巫` does not change the speaker's identity projection.

Speech is player content. Core identity is locked truth.

## 8. Dead wolf information

Private wolf recipients are fixed when the relevant session/event occurs. A wolf who died on a previous night does not receive future wolf-target observations or normal wolf actions.

B must never reconstruct historical recipients by looking at a player's current faction alone.

## 9. Post-game reveal

After `GameEnded`, `PlayerView.finalReveal` may include the completed game's reveal data such as:

- all role assignments;
- recorded night actions;
- seer truth results;
- death causes.

Before game end, `finalReveal` is `null`.

Even post-game reveal does not expose implementation secrets such as RNG seed, raw event envelope ids, transaction metadata, or debug causation fields.

## 10. Web and NPC integration rule

The future Next.js UI and NPC layer must consume this projection contract rather than importing Core truth directly.

```text
Core A → Player View B → Web UI
                    └→ NPC C
```

This is the information-security boundary for the rest of the product.
