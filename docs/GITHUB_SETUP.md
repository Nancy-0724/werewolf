# GitHub setup — C-01 latest main version

C-01 is cumulative and contains A-01～A-05, B Player View, Web Alpha, and NPC Cognitive State. Use this package as the single main working copy. Do not keep older milestone ZIPs inside the application repository.

## Web upload

1. Extract `werewolf_C01_github_ready.zip`.
2. Open the existing `werewolf-game` GitHub repository.
3. Replace/update repository files with the extracted C-01 contents.
4. Commit, for example: `feat: add npc cognitive state`.
5. Open GitHub Actions and confirm `Core + Player View + Web + C-01 Cognition CI` passes.

Do not upload the ZIP itself as application source. Repository root should directly contain:

```text
app/
src/
tests/
docs/
db/
package.json
next.config.ts
```

## Git workflow

```bash
git checkout -b feature/c01-npc-cognition
# copy/update C-01 files
npm install
npm run typecheck
npm test
npm run build:core
npm run build
git add .
git commit -m "feat: add npc cognitive state"
git push -u origin feature/c01-npc-cognition
```

After CI passes, merge to `main`.

## Database migration

C-01 adds a second migration. Run:

```bash
npm run db:migrate
```

The runner applies ordered files under `db/migrations/`.

## Vercel

See `docs/VERCEL_DEPLOY.md`.

Production requires:

```text
DATABASE_URL
WEB_SESSION_SECRET
```

No OpenAI API key is required for C-01.

## Security boundary

- Browser receives only `PlayerView` / `PublicGameView`.
- NPC cognition also consumes only its own `PlayerView`.
- Browser does not choose `viewerPlayerId`.
- NPC persisted cognition does not store `windowToken`.
- Browser/NPC intent is checked against the server's latest Action Prompt before Core command creation.
- Do not expose raw events, snapshots, GameState, or SYSTEM_TRUTH bundles.

## Secrets

Never commit a real database URL, auth secret, AI provider key, or Vercel secret into GitHub.
