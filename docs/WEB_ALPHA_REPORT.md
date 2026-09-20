# Web Alpha Implementation Report

Version: 0.7.0

## Implemented

- Next.js App Router shell
- new-game form
- 12-seat game table
- private role/information panel
- public timeline
- all current B action prompt types mapped to human UI controls
- signed HttpOnly anonymous session cookie
- server-side trusted command reconstruction
- deterministic NPC alpha policy
- auto-advance orchestrator
- production PostgreSQL / local memory store selection
- PostgreSQL migration runner script
- Vercel deployment documentation
- 8 Web Alpha test definitions

## Security / information boundary

The browser receives `PlayerView`, not GameState or Event Stream truth. The browser does not select viewer identity. The signed session determines game/player identity server-side.

Human action requests are mapped against the latest `availableActions` and use the server-side current action prompt token. A stale or unavailable action is rejected before or by Core.

## Verification performed in this delivery environment

Executed:

- TypeScript/TSX transpile syntax scan across `app/`, `src/`, and `tests/`: 50 files, 0 syntax diagnostics.
- `npm install --no-audit --no-fund` was attempted with a 35 second bound but could not complete because this container cannot reliably reach npm registry.

Not claimed as PASS here:

- official TypeScript 7 typecheck
- Vitest 5 test run
- Next.js 16.3.3 production build
- PostgreSQL integration against a live server

Those are configured in GitHub Actions and must run in a normal networked environment.

## Test definitions

```text
A-01   24
A-02   20
A-03   16
A-04   24
A-05   20
B      22
Web     8
-----------
Total 134
```

## Next milestone

C — NPC cognition / memory / structured AI decisions. The deterministic alpha policy should remain available as a test/fallback bot.
