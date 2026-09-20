# Core Decisions through B

## D1 — `SetupLocked` is one atomic event
Role assignment and immutable manifest are written together. There is no intermediate `RolesAssigned` state.

## D2 — role multiset comes from the validated ruleset snapshot
`LockGame` expands `roleCounts`; it does not keep a second hand-written role list in the assignment service.

## D3 — replay stores results, not random causes
RNG is called only while handling the first successful `LockGame`. Replay consumes persisted assignments and never calls RNG.

## D4 — receipt is part of the atomic write
A successful command appends its event batch and receipt together. Same `commandId` + same principal/request returns the old receipt. Reuse with different request/principal fails.

## D5 — read isolation through cloning
Repository read methods return JSON clones. Mutating caller-owned state/events cannot alter repository truth.

## D6 — exact WB12 whitelist plus A-02 registry
The ruleset snapshot must match the one supported WB12 declaration. Role/ability versions and handler IDs must also exist in the code-owned registry.

## D7 — import is all-or-nothing
Bundle schemas, replay, event IDs, receipt ranges and command batch shapes are verified before a fresh repository receives the imported stream.

## D8 — `windowToken` is the action session ID
Players do not submit truth-stream sequence numbers. A stale token is rejected without revealing hidden event counts.

## D9 — phase/session snapshots are persisted truth
Eligible actors and legal targets are fixed when the action window opens. Replay recalculates the expected snapshot and rejects forged event data.

## D10 — wolf knife result is locked before Witch phase
Each eligible alive wolf has one immutable ballot. After all submit, the unique highest option wins; a highest-vote tie or winning PASS yields `knifeTargetPlayerId = null`.

## D11 — Witch decision is one typed command
`PASS`, `HEAL`, or `POISON` is submitted once. HEAL/POISON emits `AbilityResourceSpent` in the same command transaction; the next window cannot open if the spend event is absent.

## D12 — A-02 stores intentions, not effects
Guard protection, charm status, poison/heal effects, seer result, deaths, hunter reactions and victory are not calculated in A-02. The handoff state is `NIGHT_READY_FOR_RESOLUTION` for A-03.


## D13 — `DeathWaveResolved` is the only life-state mutation
Direct effects are accumulated first. One wave records one DeathRecord per player with the complete cause set.

## D14 — charm death is part of the mandatory death closure
When Wolf Beauty dies, the currently active charm target is added before the wave is finalized if that target was alive at wave start. This includes Beauty dying from a later Hunter shot.

## D15 — Hunter reaction is delayed until after dawn announcement
The public death list is persisted before `ReactionWindowOpened`. Poison or charm-link in the Hunter death cause set suppresses the reaction; wolf attack and guard/heal collision allow it.

## D16 — victory is checked only after `ResolutionGroupSettled`
No intermediate death event declares a winner. If no side has won, A-03 stops at `DAWN_READY_FOR_DAY` for A-04.

## D17 — sheriff voters are frozen at signup close
`originalVoterPlayerIds` is derived from players who did not sign up. Withdrawal never grants sheriff-election voting rights. A sheriff PK reuses this original voter set minus players who have since died.

## D18 — vote weights come from the locked ruleset snapshot
Sheriff-election votes use `ordinaryVoteUnits`. Day exile votes use `sheriffDayVoteUnits` only for the active living sheriff and `ordinaryVoteUnits` for everyone else. UI never calculates authoritative weight.

## D19 — ballots are private until the vote session resolves
`BallotCommitted` is truth data. A complete PUBLIC `VoteSessionResolved` is emitted only after every eligible voter has committed.

## D20 — day deaths reuse the A-03 resolution engine
Exile and self-explosion open a ResolutionGroup and flow through EffectResolved → DeathWaveResolved → Beauty closure → optional Hunter reaction → settled → victory checkpoint.

## D21 — speech text never authenticates identity
`SpeechPublished` records player-provided public text only. Claims such as “I am the Seer” never mutate effective role/faction truth.

## D22 — later nights skip dead role owners
A night phase with no living eligible actor is deterministically opened/closed and advanced without player input, keeping the multi-day loop live after power-role deaths.

## D23 — A-04 session snapshots are replay-validated
Speech order, sheriff voter sets, PK targets and vote weights are not trusted merely because the application service emitted them. The reducer recomputes the legal snapshot from prior truth and rejects forged session events during replay/import.

## D24 — durable truth is events + successful CommandReceipt
A-05 persists a successful command as one atomic durable transaction. A snapshot is never authoritative truth.

## D25 — game rules remain storage-agnostic
`GameService` depends on `GameRepositoryPort`. PostgreSQL code lives under infrastructure; reducers and rule handlers never issue SQL or read environment configuration.

## D26 — durable execution plans before it commits
`DurableGameService` first recovers state, then runs the existing rule service against a `PlanningGameRepository`, then commits the captured event batch through `DurableGameStore`. Infrastructure may persist results but cannot invent domain events.

## D27 — snapshot is a disposable replay cache
Snapshots contain state at a completed command boundary plus version/hash metadata. Missing, stale or corrupt snapshots are discarded and full event replay remains the fallback.

## D28 — snapshot failure never reverses committed truth
Event/receipt commit happens first. Snapshot persistence is best-effort; failure is observable but must not make an already successful command disappear.

## D29 — compatibility and corruption are different states
A valid historical game using unsupported event/rules/handler versions may be `HISTORY_ONLY`. Broken sequence numbers, malformed truth or impossible replay remain hard invalid-stream errors.

## D30 — PostgreSQL concurrency uses the durable game revision
`werewolf_games.current_sequence` is locked in the append transaction. Two commands planned from the same revision cannot both commit successfully.

## D31 — engine build identity is diagnostic, contract versions are authoritative
A different deployment/build ID does not by itself make a snapshot unusable. Continuation depends on persisted schema/contract/rules/handler compatibility.

## B — Player-facing truth is an allow-list projection

B creates new `PublicGameView` and `PlayerView` DTOs from event truth. It does not expose Core state and then try to blacklist secret fields.

Public/private publication gates are semantic: night deaths are not publicly dead before dawn announcement, open ballots are not partially visible, private observations use fixed recipients, and capability tokens are actor-only.

The future Web and NPC layers must consume B and may not bypass it to read SYSTEM_TRUTH.

## D32 — browser actions are intent, not authority
The Web API derives `gameId`, `playerId`, and the current action capability from the signed session and latest PlayerView. Client request bodies never authenticate a seat and never supply authoritative window state.

## D33 — anonymous alpha sessions are signed server cookies
Web Alpha uses one HttpOnly HMAC-signed game session cookie. This is intentionally lighter than user accounts but prevents a browser request from selecting another seat by changing a player ID field.

## D34 — deterministic bots consume PlayerView
Alpha bots use the same player-facing information contract intended for C. They may not inspect SYSTEM_TRUTH to decide player actions. Truth inspection is reserved for host-only lifecycle orchestration.

## D35 — production Web requires durable storage
In-memory store is a local/disposable demo mode only. Production/Vercel fails closed without `DATABASE_URL` unless an explicit disposable-demo override is configured.

## D36 — auto advance stops at the human decision boundary
NPC/host orchestration may continue through automated steps, but it stops before any currently available human player action. It never auto-submits a human skill, speech, ballot, sheriff choice, reaction, or self-explosion.

## D37 — C-01 cognition consumes PlayerView only
NPC cognition is downstream of B. It must not receive raw GameState or event truth, even when the NPC is server-side.

## D38 — exact knowledge and belief are separate
SELF / legal initial knowledge / Seer private check / post-game reveal may create exact facts. Speech claims, suspicion, trust and working theory remain inference and cannot promote themselves into Core truth.

## D39 — action capabilities are never cognitive memory
`windowToken` and current `availableActions` are intentionally excluded from persisted NPC cognition. They are fetched fresh immediately before a Core command is constructed.

## D40 — NPC cognition is durable but non-authoritative
`werewolf_npc_cognitive_states` may survive Vercel restarts and use its own revision concurrency, but losing/rebuilding NPC cognition cannot alter the authoritative Event Stream or GameState outcome.

## D41 — lazy cognition is the default compute model
Only an NPC that is about to consider an action synchronizes/reasons. Public events are not fanned out into 11 simultaneous reasoning jobs. This is the baseline for zero-cost heuristic C-02 and any future model-backed adapter.


## C-03 role strategy remains an advisory client

C-03 may use legal PlayerView-derived cognition to choose a structured action, but the strategy object never carries `windowToken`. The Web server reacquires the fresh PlayerView and uses the same command builder/Core validation path as a human action. Strategy history is non-authoritative evaluation data.
