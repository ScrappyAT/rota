# Graduation Submission Checklist

Single list of everything still needed to close out the October graduation,
with exact commands and pointers to the evidence each item produces.

Legend: ✅ done (verified run output) · 🟡 ready/in-progress · ⬜ not done

## Code & evidence

| Item | Status | Evidence / notes |
|---|---|---|
| Push notification backend | ✅ | 127/127 API tests pass; `docs/IMPLEMENTATION-STATUS.md` |
| Mobile push wiring (device registration, preferences, receipt) | 🟡 | Being implemented in `apps/mobile` (separate workstream) |
| Load-testing harness | ✅ | `k6/**` scripts + `docs/PERFORMANCE-TESTING.md` |
| Load-test **execution** + recorded results | ⬜ | k6 not installed on this machine yet. Install (`choco install k6` or `winget install k6.k6`), then run per `docs/PERFORMANCE-TESTING.md` and fill the results table. |
| Docker image build | 🟡 | `Dockerfile` written; validate with `docker build -t rota-api .` |
| Git remote + initial push | ⬜ | Repo has no remote/commits yet. Create the GitHub repo, then (once the user requests it) `git remote add origin <url>` and push. |
| EAS production build | ⬜ | Needs `EXPO_PUBLIC_API_URL` pointed at the deployed host, then `EXPO_PUBLIC_API_URL=https://<host> npx eas-cli build --profile production --platform android` from `apps/mobile`. |
| Demo video | ⬜ | Blocked on the deployed host being reachable from the phone during recording. |

## Release prerequisites

| Item | Status | Notes |
|---|---|---|
| Flutterwave test (sandbox) keys | ⬜ | `FLW_SECRET_KEY`, `FLW_PUBLIC_KEY`, `FLW_SECRET_HASH` from https://dashboard.flutterwave.com. Never commit; set only in the deployed service vars. |
| Production JWT secrets | ⬜ | Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. Set `JWT_SECRET` (+ `JWT_REFRESH_SECRET`) in the service. |
| `CORS_ORIGIN` allow-list | ⬜ | Must be non-`*` in production (enforced by `apps/api/src/env.ts`). |
| Provision Railway project (Postgres + Redis + API) | ⬜ | Walkthrough in `docs/DEPLOYMENT.md`. Never provision until the user instructs it. |
| Deploy + post-deploy checks | ⬜ | `docker build`, `curl /health`, `k6 run k6/health.js`. |

## After deploy (in order)

```bash
# 1. Smoke the live API
curl -s https://<host>/health

# 2. Run the load suite against the deployment
k6 run k6/health.js   -e BASE_URL=https://<host>
k6 run k6/workload.js -e BASE_URL=https://<host> -e USER_EMAIL=... -e USER_PASSWORD=... -e TEAM_ID=...
k6 run k6/cursor-walk.js -e BASE_URL=https://<host> -e USER_EMAIL=... -e USER_PASSWORD=... -e TEAM_ID=...
# rate-limit.js LAST, against a disposable instance (it exhausts the IP budget)

# 3. Fill the results table in docs/PERFORMANCE-TESTING.md from k6 summaries

# 4. Build the mobile artifact against the live host, record demo video
```

## Close-out

- [ ] All three gates green on the final tree: `npm run typecheck`, `npm run lint`, `npm test`.
- [ ] k6 thresholds pass on the deployed host; results recorded (no fabricated numbers).
- [ ] `docs/IMPLEMENTATION-STATUS.md` "Validation history" updated with final runs.
- [ ] GitHub repo has the full history committed and pushed.

## Status of this document

Compiled as part of the deployment-pack task. Nothing here claims to have
executed outside the repo. Any item marked ✅ was run in this workspace's
earlier validation sessions (127 API tests) or is a committed artifact.