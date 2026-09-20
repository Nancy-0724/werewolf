# B — Player View implementation report

## Scope

B adds the player-facing information projection layer on top of the completed A-01～A-05 Core. It does not change game rules, resolution ordering, persistence semantics, or PostgreSQL truth.

Implemented outputs:

- `PublicGameView`
- `PlayerView`
- runtime Zod schemas for both contracts
- `PlayerViewService` backed by `DurableGameStore`
- private observation projection
- viewer-specific legal action prompts
- public/private information leak guards
- post-game reveal contract

## Information rules implemented

- No raw `GameState` or event envelopes are returned.
- No sequence/transaction/causation/debug fields are exposed.
- Public night stage is role-agnostic.
- Current `windowToken` is available only to the authorized current actor.
- Night deaths remain publicly ALIVE until the dawn announcement.
- Dawn publishes only the dead roster, not causes.
- Open votes reveal no partial ballots or commit counts.
- Completed votes reveal ballots/tally but not internal event metadata.
- Seer results go only to the seer recipient.
- Witch knife information follows `WHILE_HEAL_REMAINS`.
- Wolf target private information is frozen to eligible living wolf recipients for that night.
- Dead wolves receive no future wolf-team private target observation or normal action prompt.
- Player speech remains content, not identity proof.
- WB12 wolf initial identity policy exposes wolf teammates including special wolf role to wolf-team players only.
- Full reveal is reserved for an ended game.

## B tests

`tests/projection/b01.test.ts` contains 22 B-specific cases:

1. public locked view has board configuration but no assignments/seed;
2. self identity only;
3. wolf-team initial teammate knowledge;
4. outsider rejected;
5. coarse night stage + actor-only token;
6. wolf submitted state/private final target;
7. witch knife TARGET;
8. no-attack knife information;
9. seer result recipient isolation;
10. raw envelope/debug key leak scan;
11. pre-dawn death visibility gate;
12. dawn cause redaction;
13. partial vote secrecy;
14. completed vote sanitization;
15. speech does not mutate identity;
16. public self-explosion without role leak;
17. indistinguishable-world projection test;
18. spent heal causes later witch knife info `UNAVAILABLE`;
19. dead wolf receives no next-night target private info;
20. public projection never exposes current token;
21. private observation uses viewer-local ordinal;
22. durable `PlayerViewService` reads event truth through durable store.

## Verification status

The B-specific suite was executed with an external temporary compatibility harness because this execution environment cannot reliably download the repository's declared npm toolchain. Result:

```text
B: 22 / 22 smoke cases passed
```

During this B cycle, A-01～A-03 were also re-run under the same temporary harness and passed 60/60. A-04's full shim run became too slow because the temporary harness repeatedly replays a long event stream; Core files themselves were not modified by B. The previous clean A-05 delivery had A-04 24/24 and A-05 20/20 smoke results.

These smoke results are not a substitute for the declared Node 24 / TypeScript 7 / Vitest 5 toolchain.

Formal commands remain:

```bash
npm install
npm run typecheck
npm test
npm run build
```

GitHub Actions is configured to execute these using Node 24.21.0. Do not report formal PASS until that workflow succeeds.

## Test inventory after B

```text
A-01  24
A-02  20
A-03  16
A-04  24
A-05  20
B      22
-----------
Total 126 test definitions
```

## Security / integration caveat

`PlayerViewService.forPlayer(gameId, viewerPlayerId)` assumes the server already knows which authenticated user owns that `viewerPlayerId`. B defines information projection, not network authentication.

The future Next.js API must derive the seat on the server from session/account/game membership. It must not accept an arbitrary client-provided player id as authorization.

## Boundary

B intentionally does not implement:

- Next.js UI/API;
- authentication/account mapping;
- NPC cognition or LLM prompts;
- wolf private chat messaging;
- production Neon/Vercel binding.

The next agreed milestone is Web Alpha using `PublicGameView` / `PlayerView` as its only player-facing game data contract. Deterministic placeholder bots can be used before C NPC AI is connected.
