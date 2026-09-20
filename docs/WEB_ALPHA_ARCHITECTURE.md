# Web Alpha Architecture

Version: 0.7.0

## Goal

Expose the completed Core + Player View through a browser without moving game truth or authorization into the client.

## Request boundary

```text
Browser intent
   ↓
HttpOnly signed session cookie
   ↓
Server resolves gameId + playerId
   ↓
PlayerViewService.forPlayer(...)
   ↓
Server finds currently available Action Prompt
   ↓
Server uses authoritative windowToken from that prompt
   ↓
Core Command
   ↓
DurableGameService
```

The browser can inspect its own PlayerView, including its own current action capability, but it cannot switch viewer identity by changing a request field. API endpoints never accept a browser-provided viewerPlayerId.

## Anonymous session

The alpha does not implement user accounts. New game creation writes an HttpOnly `ww_session` cookie containing a signed, expiring `{ gameId, playerId }` payload.

The cookie is:

- HttpOnly
- SameSite=Lax
- Secure in production
- HMAC-SHA256 signed with `WEB_SESSION_SECRET`
- valid for seven days by default

Changing `WEB_SESSION_SECRET` invalidates existing alpha sessions.

## NPC C-03 strategy client

The Web NPC receives the same `PlayerView` contract that a future model-backed NPC would receive. It does not receive raw SYSTEM_TRUTH.

When an NPC has a legal action, the server runs:

```text
C-01 synchronize cognition
→ C-02 heuristic reasoning
→ C-03 role strategy
→ structured choice without windowToken
→ fresh PlayerView command builder
→ DurableGameService / Core
```

C-03 currently handles night abilities, sheriff choices, voting, badge transfer, limited self-explosion policy and a minimal strategic speech template. C-04 will replace the speech realization layer, not the game authority path.

## Auto advance

After a human action, the server runs NPC / host automation until one of these boundaries:

1. the human player has an available action;
2. the game ends;
3. no automated action is possible;
4. the safety cap is reached.

Host-only automation is limited to lifecycle commands needed by the current Core contract (`ResolveNight`, `BeginDay`). It never submits a human player action.

## Storage

Local development may use `InMemoryDurableGameStore`.

Production uses:

```text
pg Pool
  ↓
PgDatabasePort
  ↓
PostgresGameStore
  ↓
DurableGameService
```

Snapshot remains disposable cache; events + command receipts remain truth.

## Web routes

```text
GET  /                        landing page
GET  /new-game                setup UI
GET  /game                    main game UI
POST /api/games               create + configure + lock + start game
GET  /api/game                authorized PlayerView
POST /api/game/action         submit human intent
POST /api/game/advance        run bot/host auto advance when human has no action
```

## Current non-goals

- accounts / OAuth
- multi-human realtime rooms
- websocket live updates
- AI/LLM NPC reasoning
- rate limiting / abuse controls
- wolf private chat UI
- voice input
