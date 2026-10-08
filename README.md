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
- `npm run lint`: Runs ESLint across all workspaces.
- `npm run typecheck`: Runs TypeScript checks across all workspaces.
- `npm run test`: Runs tests across all workspaces.

## Current Implementation Status (Phase 1)

Phase 1 provides a solid technical foundation. We have implemented:
- Monorepo setup with npm workspaces.
- Shared package for types and schemas.
- Express API with health check, validation, centralized error handling, and database connection.
- Expo mobile app with routing and placeholder screens.
- Local development environment with Docker Compose.

## Planned Next Steps

- Implement authentication and authorization.
- Design and build the API for shifts, teams, and swaps.
- Implement mobile UI and connect with the API.
