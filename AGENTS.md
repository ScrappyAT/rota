# AGENTS.md — Rota Monorepo

Instructions for coding agents working on this repository. This file governs the
repository as a whole. For mobile-specific rules, also follow
`apps/mobile/AGENTS.md` — it takes precedence for anything inside `apps/mobile`.

## Project Purpose

Rota is a mobile shift-scheduling application for small businesses (restaurants,
clinics, retail). Teams have owners, managers, and staff. Owners and managers
create shifts and invite members; staff view and swap shifts. The product is
delivered as an Expo mobile app backed by an Express API.

Current state: Phase 2 (auth, teams, invitations, role-based access control) is
implemented and validated. Shifts, swaps, and the activity feed are Phase 3 and
are **not implemented yet**. Track everything in
`docs/IMPLEMENTATION-STATUS.md`.

## Technology Stack

- **Monorepo**: npm workspaces (`apps/*`, `packages/*`), TypeScript everywhere.
- **API** (`apps/api`): Node.js, Express 4, Zod validation, `pg`, Redis client,
  JWT (`jsonwebtoken`), bcrypt, `express-rate-limit`, Jest + Supertest.
- **Mobile** (`apps/mobile`): Expo SDK 57, Expo Router, React Native 0.86,
  `expo-secure-store` for token storage. See `apps/mobile/AGENTS.md`.
- **Shared** (`packages/shared`): Zod schemas, types, role constants. Consumed
  by both API and mobile. **Rebuild `dist/` (`npm run build -w @rota/shared`)
  after editing `src/`** — consumers resolve the built output.
- **Infra** (`infrastructure/docker-compose.yml`): PostgreSQL 15 on host port
  **5440**, Redis 7 on host port **6380**. `.env` at the repo root already
  points at these ports. Never assume 5432/6379.

## Monorepo Structure

```
apps/api          Express API, migrations, Jest integration tests
apps/mobile       Expo app (routes in apps/mobile/app/, logic in src/)
packages/shared   Shared Zod schemas, types, Roles constants
infrastructure    docker-compose for Postgres + Redis
docs              ARCHITECTURE.md, SECURITY.md, phase plans and trackers
```

## Coding Conventions

- TypeScript strict mode via `tsconfig.base.json`; no `any` in new code unless
  unavoidable (ESLint downgrades `no-explicit-any` to a warning — do not rely
  on that).
- Responses always use the `ApiResponse<T>` envelope from `@rota/shared`:
  `{ success, data?, error?: { code, message } }`.
- Validate every request body/params with a Zod schema before touching the
  database. Zod failures must surface as HTTP 400 `VALIDATION_ERROR` via
  `error-handler.ts`, never as 500.
- Route handlers: thin handlers + `try/catch` that calls `next(error)`. Shared
  logic belongs in middleware or a service module, not duplicated inline.
- Use the existing `authenticate` and `requireRole([...roles])` middleware for
  every team-scoped endpoint. Do not hand-roll authorization checks.
- Multi-statement writes (team creation, invitation acceptance) must run in an
  explicit transaction with `BEGIN`/`COMMIT`/`ROLLBACK` and `client.release()`
  in `finally`.
- Follow the existing file layout: routes in `src/routes/`, middleware in
  `src/middleware/`, no new top-level folders without updating this file.

## Database Migration Rules

- Migrations are plain `.sql` files in `apps/api/migrations/`, named
  `NNN_description.sql` with a zero-padded, monotonically increasing number.
- **Never edit an already-applied migration.** Add a new file instead. Applied
  files are recorded in the `migrations` table.
- Run with `npm run db:migrate` (root). Each file runs inside one transaction;
  keep DDL and its data fixes together in that file.
- Timestamps are `TIMESTAMP WITH TIME ZONE`. Primary keys are `UUID`
  (`gen_random_uuid()`). Use `citext`-style normalization by lowercasing emails
  in application code (as registration does).
- Roles are stored per-team in `team_memberships.role` using the `user_role`
  enum. There is deliberately **no** global role on `users`.
- Every foreign key used in a hot query path gets an index; every list endpoint
  that supports pagination gets a composite index matching its sort order.

## Security and Tenant Isolation Requirements

These are non-negotiable. Any endpoint touching team data must satisfy them:

1. **Tenant isolation**: every `/teams/:teamId/...` route uses
   `authenticate` + `requireRole(...)`. Non-members receive 404, members
   without the role receive 403. Never leak data across teams — not even names.
2. **Role rules**: `OWNER` > `MANAGER` > `STAFF`. Managers may only invite or
   remove `STAFF`. The last `OWNER` of a team can never be demoted or removed.
3. **Auth**: access tokens are 15-minute JWTs; refresh tokens are opaque random
   strings stored as bcrypt hashes in `refresh_tokens`, rotated on every use.
   Presenting an already-rotated refresh token is treated as reuse: revoke the
   user's entire active session family and return 401.
4. **Rate limiting**: `/auth/*` is rate-limited (100 requests / 15 min / IP).
   Any new credential-accepting endpoint must be under a limiter.
5. **Secrets**: never commit `.env`, never print secrets in logs or responses,
   never hardcode production secrets. `JWT_SECRET` must be explicitly set when
   `NODE_ENV=production` (enforced in `src/env.ts`).
6. **Invitations**: store only SHA-256 hashes of invitation tokens; raw tokens
   are returned once at creation. Acceptance requires an authenticated user
   whose email matches the invitation, and the invitation must be unexpired and
   unaccepted (one-time use).
7. Input is validated with Zod; SQL uses parameterized queries only — no string
   concatenation into SQL.

## Testing Expectations

- API: `npm test` runs Jest in `apps/api`. Integration tests hit the live local
  Docker Postgres/Redis — start them with `npm run db:start` and migrate with
  `npm run db:migrate` first.
- Integration tests mutate the database (they clear tables in `beforeAll`).
  Do **not** run multiple Jest workers against the same database, and do not
  add time-dependent or port-dependent tests without isolation.
- Tests must run against real behavior. Do not mock the database in
  integration tests, and do not add tests that only restate implementation.
- Before declaring any task complete, run all three gates and make them pass:
  - `npm run typecheck`
  - `npm run lint` (0 errors; pre-existing warnings are tolerated)
  - `npm test`
- Mobile has no test runner yet (`test` script is a stub). Mobile changes must
  at minimum pass `npm run typecheck` from the repo root. Do not claim mobile
  runtime behavior was verified unless the app was actually run.
- New features require tests covering: the happy path, a cross-tenant denial
  (403/404), and an invalid-input denial (400).

## Documentation Requirements

- `docs/IMPLEMENTATION-STATUS.md` is the single source of truth for feature
  status. Update it whenever a feature moves between categories.
- When you add or change an endpoint, update `docs/ARCHITECTURE.md` (or the
  active phase plan) in the same change.
- Never write documentation that claims functionality which has not been
  executed and observed. Distinguish "implemented" from "verified".
- Keep `README.md` setup steps accurate when scripts or ports change.

## Git Commit Conventions

- Conventional Commits: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`,
  `chore:`, `build:` — imperative mood, lower-case subject, scope optional
  (`feat(api):`, `feat(mobile):`).
- One logical change per commit; do not mix formatting sweeps with behavior
  changes.
- Never commit `.env`, secrets, `node_modules/`, `dist/`, or database dumps.
- Do not commit, push, force-push, reset, or amend unless the user explicitly
  asks for it in the current session.

## Instructions for Future Coding Agents

1. Read `docs/IMPLEMENTATION-STATUS.md` first — it tells you what is real.
2. Do not recreate working systems. Prefer small, targeted edits over
   refactors; preserve the `ApiResponse` envelope and middleware stack.
3. Do not implement Phase 3+ features until asked; if you are asked, follow
   `docs/PHASE-3-PLAN.md`.
4. Do not deploy, push to GitHub, commit, reset the database, or modify files
   outside this repository unless explicitly instructed.
5. Do not claim a test passed unless you ran it and saw the output. If a check
   fails for environmental reasons, say so plainly instead of working around it.
6. If you change ports, scripts, or env var names, update `.env.example`,
   `README.md`, and this file together.
