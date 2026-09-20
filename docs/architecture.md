# Architecture through C-03.5 NPC Advanced Reasoning

## 1. Trust layers

```text
PostgreSQL durable truth
        ↓
A — Game Core / SYSTEM_TRUTH
        ↓
B — Projection / information boundary
   ├─ PublicGameView
   └─ PlayerView(viewer)
        ↓
Consumers
   ├─ Next.js Web
   └─ C NPC brain (C-01 memory + C-02 reasoning + C-03.5 worlds + C-03 strategy)
```

A and B have different responsibilities. A must know enough truth to adjudicate every rule. B must remove everything a particular observer is not allowed to know.

## 2. A remains authoritative

The authoritative model remains Event Sourcing:

```text
TrustedPrincipal + Command
        ↓
GameService
        ↓
Event batch + CommandReceipt
        ↓
DurableGameStore
        ↓
append-only Event Stream
```

Snapshots are cache, not truth. B does not alter this model.

## 3. B is a pure read projection

B consumes the persisted event stream and constructs a new DTO. It does not serialize `GameState` and then remove a few fields.

That distinction is intentional: allow-list projection is safer than deny-list redaction.

```text
raw events
   ↓ parse / replay
SYSTEM_TRUTH
   ↓ semantic projection
safe new object
```

The result has its own runtime Zod schemas and contract version.

## 4. Public and private contracts

`PublicGameView` is safe for a common display. It contains public stage, seats, public life state, sheriff state, completed public events and the final outcome.

`PlayerView` contains `PublicGameView` plus the authorized seat's own identity, legal private observations, ability state and current legal actions.

The client never needs a raw Core event envelope.

## 5. Visibility gates

B uses publication semantics rather than current truth alone.

Example: a player can be DEAD in Core during night resolution while every player-facing screen must still show ALIVE. B changes that public state only when `DawnAnnouncementPublished` occurs.

Likewise an open vote does not reveal partial ballots. Only `VoteResolved` becomes a public vote observation.

## 6. Fixed private recipients

Private information belongs to recipients fixed at the time the information is published/created. A later role/life-state lookup must not retroactively change that audience.

Examples in current B:

- `PrivateObservationPublished` seer result uses its stored recipients.
- witch knife information is frozen for the eligible witch action actor when the witch window opens.
- wolf target information is frozen to that night's eligible living wolf actors.

This prevents dead wolves from receiving later team information.

## 7. Capability tokens

`windowToken` is private capability data. B only places it inside the current actor's `availableActions`.

Public view never exposes tokens. Future APIs must still validate trusted player principal + actor + current token in Core; hiding a token is not the only authorization layer.

## 8. Persistence and serverless

`PlayerViewService` reads through `DurableGameStore`. A future Vercel Function therefore does not depend on process-local memory:

```text
HTTP request
  ↓ authenticate
  ↓ derive viewer seat
DurableGameStore / PostgreSQL
  ↓ load events
PlayerViewService
  ↓ safe DTO
HTTP response
```

## 9. Web and C cognition

Web Alpha consumes B contracts and never sends SYSTEM_TRUTH DTOs to browser code. C-01 consumes the same PlayerView contract for each NPC; C-02 reasons only over that legal cognitive state; C-03.5 adds bounded five-layer evidence and complete-world hypotheses; C-03 converts those beliefs/hypotheses into a role-aware structured action plan.

C-01 introduces a separate, non-authoritative durable state:

```text
PlayerView(NPC)
  ↓
NpcCognitiveState
  ├─ legal memories
  ├─ exact knowledge
  ├─ beliefs
  ├─ claims
  ├─ working theory
  └─ decision history
```

Cognition is not replay truth and may never mutate Core directly. Action capabilities are always read fresh from PlayerView.

C-02 now deterministically extracts conservative structured claims and recomputes belief/trust/suspicion evidence from C-01 memory. The same evidence re-run is idempotent, exact facts stay anchored, and no API/LLM is required.

C-03.5 now evaluates identity fit, information provenance, timing shifts, utility, and bounded world hypotheses. It stores only soft evidence/hypotheses and never promotes them to SYSTEM_TRUTH. C-03 then consumes C-02 beliefs plus a minority-weight C-03.5 marginal signal to implement role-specific action strategy without granting NPCs direct access to hidden game truth. Strategy decisions exclude windowToken and return through a fresh PlayerView → command builder → Core validation path. C-04 will add persona-specific speech realization without changing this authority boundary.
