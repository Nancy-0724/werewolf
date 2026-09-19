# Long-term implementation rules

1. Roles are assigned exactly once by `SetupLocked`; no later API may mutate identity in v1.
2. Game state is derived from the append-only event stream. State is never the authoritative store.
3. SYSTEM_TRUTH state/events must never be passed directly to NPCs or public/shared UI.
4. Speech is content, not identity authentication.
5. Milestones are strict. A-04 owns sheriff/day speech/voting/PK/self-explosion/last-words/badge/next-night flow. A-05 owns persistence/recovery and must not rewrite game rules. B owns Player View information projection.
6. Every behavior change requires tests. Never delete failing tests to claim completion.
7. Never report PASS unless the corresponding command was actually executed successfully.
8. Reducers/replay are pure: no RNG, clock, network, LLM, database, or environment reads.
9. Successful command writes are atomic with their command receipt and use expected-sequence concurrency checks.
10. Player actions require a trusted PLAYER principal matching `actorPlayerId` and the current opaque `windowToken`.
11. Phase/session eligibility, speaker order, voter sets and legal-target snapshots are truth data fixed when a window opens; replay must reject forged snapshots or skipped phase transitions.
12. Ability resources are spent only by persisted `AbilityResourceSpent` events; illegal/retried commands do not spend resources.
13. Life state changes only through `DeathWaveResolved`; never add a second direct death mutation event.
14. PUBLIC announcements expose only information legal for that public event; raw death causes and hidden intent remain SYSTEM_TRUTH.
15. Optional death reactions must persist a pending reaction token before waiting for player input; resolution cannot settle while an OPEN reaction exists.
16. Authoritative vote weights come from the locked ruleset snapshot, not UI constants.
17. Ballots remain non-public until a vote session is complete.
18. A-05 persistence adapters may store/recover the event model but may not make domain decisions outside Core.

19. Events and successful CommandReceipt are durable source of truth; snapshots are disposable cache only.
20. Recovery may use a compatible snapshot plus tail events, but corrupt/missing snapshots must fall back to full event replay.
21. Unsupported historical contracts may be HISTORY_ONLY; corrupted truth must remain an invalid-stream error.
22. PostgreSQL adapters may coordinate transactions/concurrency but cannot invent domain outcomes.
23. Web UI and NPC code must consume `PublicGameView` / `PlayerView`; they may not receive raw `GameState`, raw event envelopes, or SYSTEM_TRUTH bundles.
24. A player's observation may reveal only information already public or privately published to that fixed recipient. Never infer recipients from a player's current faction after the fact.
25. Public night stage is intentionally coarse. Do not expose role-specific night phase names or hidden session existence through the public API.
26. `windowToken` is private action capability data and may appear only in the authorized player's current action prompt; it must never appear in `PublicGameView`.
27. Pre-dawn night deaths stay publicly ALIVE until `DawnAnnouncementPublished`; UI must not derive public life state directly from SYSTEM_TRUTH runtime state.
28. Post-game reveal is allowed only after `GameEnded`; pre-game/end developer/admin truth access must remain isolated from player-facing APIs.
29. Web browser code may never import or receive raw GameState/Event Stream truth. Web responses must be projection DTOs only.
30. Browser requests are intent, not authority. Server derives playerId and current windowToken from the signed session and latest PlayerView before calling Core.
31. Anonymous Web Alpha sessions use an HttpOnly signed cookie. Never accept viewerPlayerId from browser request data.
32. Deterministic Alpha bots are orchestration clients of PlayerView/Core only. They may not mutate state or inspect SYSTEM_TRUTH to choose player actions.
33. Host automation may inspect recovered truth only to issue host-only lifecycle commands such as ResolveNight/BeginDay; it may not act for a human player.
34. Production/Vercel must use a durable store unless an explicit disposable-demo override is configured. Never silently treat in-memory state as durable production storage.
35. WEB_SESSION_SECRET is mandatory in production and must never be committed to the repository.
36. C NPC AI must replace bot decision policy without changing Core rules or Player View information boundaries.
37. C-01 NPC cognitive state accepts PlayerView only. No C/NPC API may accept raw GameState, raw DomainEvent envelopes, or SYSTEM_TRUTH bundles.
38. Persisted NPC cognition must never contain action windowToken capabilities. Current legal actions are read fresh from PlayerView immediately before a command is built.
39. NPC facts and NPC beliefs are different data. Exact identity/faction knowledge requires a legal information source; suspicion, trust and working theory may never silently promote themselves into SYSTEM facts.
40. C-01 persona selection is deterministic and requires no RNG, clock, network, LLM, or environment configuration.
41. NPC observation cursors are monotonic. A stale/truncated PlayerView may not roll a cognitive state backward.
42. NPC cognitive persistence is state for future reasoning, not game authority. Core remains the only rule adjudicator and every NPC action still returns through PlayerView → Core Command validation.
43. Lazy cognition is intentional: an NPC synchronizes when it is about to consider an action; do not fan out reasoning work to every NPC for every public event.
44. C-02 heuristic reasoning accepts persisted NPC cognition / legal PlayerView-derived observations only. It may never request SYSTEM_TRUTH or raw domain events.
45. Heuristic beliefs are recomputed deterministically from evidence. Re-running the same cognitive state must be idempotent; do not repeatedly accumulate the same evidence delta.
46. Hard facts (self identity, legal initial knowledge, private seer faction result, post-game reveal, rule-proof public events) anchor beliefs and may not be overwritten by speech claims or heuristic scores.
47. Auto-parsed speech is a Claim, never identity authentication. Unsupported free-form text must remain ordinary memory instead of being guessed into a structured fact.
48. C-02 is analysis only. Complete role-specific action/deception policy belongs to C-03, and every chosen action must still be built from a fresh PlayerView and validated by Core.
49. C-02 must remain zero-external-inference by default: no LLM/API/network/RNG/clock dependency is allowed in the heuristic reasoner.
50. C-03 role strategy consumes only PlayerView + C-01/C-02 cognition. It may not inspect raw GameState, raw events, or SYSTEM_TRUTH.
51. Strategy output must not persist or return `windowToken`. Capability data is reacquired from the fresh PlayerView immediately before Core command construction.
52. Role strategy is advisory and non-authoritative. Every NPC action still passes through the same command builder and Core validation used by human players.
53. Wolf-team strategy may use only legally known packmates from PlayerView-derived exact knowledge. It may not infer hidden partners from SYSTEM_TRUTH.
54. C-03 decisions are deterministic for the same PlayerView + cognitive state. No RNG, clock, network, LLM, or environment-dependent decision policy is allowed.
55. Decision history may record PLANNED/COMMITTED/REJECTED strategy outcomes, but it never replaces the Core event stream as truth.
