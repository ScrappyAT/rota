# Architecture Overview

This document outlines the foundation and intended system components of the Rota application.

## System Components

1.  **Mobile App (`apps/mobile`)**: An Expo (React Native) application serving as the primary interface for Owners, Managers, and Staff. It uses Expo Router for navigation and NativeWind for styling. It connects to the backend API via HTTP.

2.  **Backend API (`apps/api`)**: A Node.js and Express application providing RESTful endpoints. It handles business logic, database interactions, and integrations.
    - **Database**: PostgreSQL is used as the primary relational database to store users, teams, shifts, and relationships.
    - **Caching/Queues**: Redis is used for potential caching, rate limiting, and background job queues (e.g., sending notifications).

3.  **Shared Package (`packages/shared`)**: Contains shared types, validation schemas (using Zod), and constants. This ensures consistency between the mobile app and backend API.

## Data Flow

- The mobile app sends HTTP requests to the backend API.
- The API validates requests using Zod schemas from the shared package.
- The API interacts with PostgreSQL and/or Redis based on the request.
- The API returns formatted responses back to the mobile app.

## Implemented Functionality (Phase 1)

- Monorepo structure with npm workspaces.
- Empty shell of the mobile application with basic navigation.
- Foundational backend setup with database connection pooling (pg), environment validation, and error handling.
- Local infrastructure defined via Docker Compose (PostgreSQL, Redis).

## Planned Architecture (Future Phases)

- **Authentication**: JWT-based authentication or integration with a third-party provider (e.g., Supabase, Firebase).
- **Shift Management**: Logic for creating, assigning, and swapping shifts.
- **Notifications**: Push notifications via Expo Push Notification service or similar.
- **Offline Access**: Local data persistence in the mobile app (e.g., using WatermelonDB or simple AsyncStorage).
