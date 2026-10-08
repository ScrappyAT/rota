# Rota

Rota is a mobile shift-scheduling application for small businesses such as restaurants, clinics, and retail stores.

## Technology Stack

- **Mobile**: Expo, React Native, TypeScript, Expo Router, NativeWind
- **Backend**: Node.js, Express, TypeScript, Zod, PostgreSQL, Redis
- **Infrastructure**: Docker Compose for local development

## Repository Structure

- `apps/mobile`: Expo mobile application
- `apps/api`: Express backend API
- `packages/shared`: Shared TypeScript types and Zod schemas
- `infrastructure`: Docker Compose file for local services
- `docs`: Architecture and documentation

## Prerequisites

- Node.js (v18+)
- Docker and Docker Compose (for local database and Redis)

## Local Setup

1. Copy `.env.example` to `.env` in the root directory.
2. Run `npm install` to install dependencies across workspaces.
3. Start the databases: `npm run db:start`
4. Run migrations: `npm run db:migrate`
5. Start the backend: `npm run dev:api`
6. Start the mobile app: `npm run dev:mobile`

## Available Scripts

- `npm run dev:api`: Starts the API server in development mode.
- `npm run dev:mobile`: Starts the Expo app.
- `npm run db:start`: Starts PostgreSQL and Redis using Docker Compose.
- `npm run db:stop`: Stops the Docker Compose services.
- `npm run db:migrate`: Runs database migrations in the API workspace.
- `npm run db:seed:activity`: Seed the activity feed with 10,000 rows for a
  team. Usage: `npm run db:seed:activity -- --team <team-uuid> [--count 10000]
  [--reset]`. Reruns are idempotent; `--reset` removes only previously seeded
  rows.
- `npm run lint`: Runs ESLint across all workspaces.
- `npm run typecheck`: Runs TypeScript checks across all workspaces.
- `npm run test`: Runs tests across all workspaces.

## Current Implementation Status

- **Phase 1** — Monorepo, shared package, Express bootstrap, Docker Compose,
  Expo shell: complete.
- **Phase 2** — Auth (JWT + rotating refresh tokens with reuse detection),
  teams, role-based access control, invitations: complete and verified.
- **Phase 3** — Shifts, shift assignments, swap requests/approvals, activity
  feed, cursor pagination, 10k seed script, and mobile shift/swap/activity
  screens: implemented. API behavior is covered by 43 automated tests
  (including a live-DB suite); mobile screens type-check but have not been
  exercised on a device.
- See `docs/IMPLEMENTATION-STATUS.md` for the full breakdown.

### Planned Next Steps
- Replace FlatList with FlashList for large rosters (see `docs/PAGINATION.md`).
- Push notifications, offline shift viewing, billing, load testing.
