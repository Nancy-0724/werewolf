# GitHub + Vercel + PostgreSQL deployment

Web Alpha is structured for Vercel but production gameplay requires a durable PostgreSQL database.

## 1. Push the repository to GitHub

Use one repository, for example:

```text
werewolf-game
```

Do not upload the ZIP itself. Extract it and push the repository contents so `package.json`, `app/`, `src/`, and `db/` are at repository root.

## 2. Create PostgreSQL

Recommended target for this project: Neon PostgreSQL.

Create a database and obtain a pooled connection string.

Set locally if needed:

```text
DATABASE_URL=postgresql://...
```

Then run:

```bash
npm install
npm run db:migrate
```

`npm run db:migrate` applies all ordered SQL files under `db/migrations/`, currently `0001_a05_event_store.sql` and `0002_c01_npc_cognitive_state.sql`. If using a database SQL console instead, apply them in that order.

## 3. Generate the session secret

Example:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Save the output as:

```text
WEB_SESSION_SECRET
```

Never commit it to GitHub.

## 4. Import GitHub repository into Vercel

Vercel should auto-detect Next.js.

Use Node.js 24.x.

Add Environment Variables:

```text
DATABASE_URL=<pooled postgres connection string>
WEB_SESSION_SECRET=<random secret>
```

Do not set `WEB_ALLOW_MEMORY_DEMO=1` for a real deployment.

## 5. Deploy

Vercel builds with:

```bash
npm run build
```

GitHub Actions separately validates:

```bash
npm run typecheck
npm test
npm run build:core
npm run build
```

## Preview vs Production

Use the same codebase for Vercel Preview deployments. Database isolation for preview branches is recommended before active development with real user data.

## Current alpha limitation

Authentication is an anonymous signed browser cookie, not a user account. A player can continue the current game in the same browser while the cookie remains valid and the database remains available.
