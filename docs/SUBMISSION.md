# Rota graduation submission evidence

Reviewed 10 November 2026 against the original Dev & Design HQ PDF, Part 2 Task A
and page 34. This replaces the outdated pre-publication checklist. Completion of
an artifact and availability of its submission link are separate facts.
No remote submission, publication or deployment is performed in this phase.

| Required evidence | Current evidence | Remaining action |
|---|---|---|
| Public source | [ScrappyAT/rota](https://github.com/ScrappyAT/rota); R1/R2/R3 merged per user and local main | Integrated locally on the release branch; approved publication still needed |
| Android build | [New integrated preview APK](https://expo.dev/artifacts/eas/r197ay-RMlQSdm-zTC_w1I4b_gD85C3_c0NBXPBYi8w.apk) — Expo build FINISHED10 November2026 | Physical Android acceptance still required; old link404 replaced |
| Backend | Railway existed and attempted main deployment; missing-redis runtime repair is separately implemented/tested locally | Confirm approved repaired API + separate worker rollout and a reachable endpoint; no current uptime claim |
| Architecture diagram/docs | [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md), [SHARDING.md](SHARDING.md), [LEARNING-LOG.md](LEARNING-LOG.md), [OBSERVABILITY.md](OBSERVABILITY.md) | Reconcile shared docs when integrating all worktrees |
| Automated tests | Final integrated release478/44 passed; TypeScript/lint/builds and final Docker smoke passed; see release report | Publish exact final integrated verification rather than reusing an older total |
| 10k data / cursor/index evidence | large-dataset tests; [PAGINATION.md](PAGINATION.md) before/after plans | Existing evidence; new load/EXPLAIN execution is not claimed here |
| 200-VU before/after cache report | [load-tests/REPORT.md](../load-tests/REPORT.md), [PERFORMANCE-REPORT.md](PERFORMANCE-REPORT.md) | Historical executed evidence retained; disclose missed harness latency thresholds |
| Three-minute demo | **Recording completed 14 October 2026**, per user and central submission | **Public shareable URL missing**; check access and assessment coverage. Do not mark recording as unrecorded |
| LinkedIn engineering post | **Published** [existing post](https://lnkd.in/p/edPwxhTV), HTTP 200 redirect confirmed | Preserve completion; a new post is not a blocker |
| Portfolio Rota case study | [Portfolio](https://samuel-emmanuel-portfolio.vercel.app/) HTTP 200; no Rota text found in homepage HTML; central submission lists three other projects | Publish/link a dedicated Rota case study; homepage check is not an exhaustive crawl. [Repo draft](ROTA-CASE-STUDY.md) is not a published portfolio page |
| Production store billing explanation | README covers Rota digital subscriptions and Matinee physical cinema tickets | Re-evaluate store/program/region eligibility before enabling production checkout |
| Central submission | [final-task-samuel-emmanuel/SUBMISSION.md](https://github.com/ScrappyAT/final-task-samuel-emmanuel/blob/main/SUBMISSION.md) read through GitHub connector | Update Rota's 236-test historical count, broken APK, video URL, backend and case-study links after review; other assessment parts unchanged |

## Final sign-off sequence

- [ ] Review the integrated release diff and original phase reports; docs are reconciled locally.
- [ ] Run final integrated serial PostgreSQL/Redis tests, TypeScript, lint, builds
      and the repaired final-image dependency/HTTP smoke test with explicit approval.
- [ ] Review serialized release migration plan, worker topology, PORT 8080 and
      provider/telemetry configuration without placing secrets in source or Expo.
- [ ] Complete physical Android acceptance for current changes, including cold/
      warm links, offline restoration, swaps, two-device settings and quiet hours.
- [ ] Obtain authorized sandbox Flutterwave USD proof and mocked-to-live staging
      mail/push/error-monitoring evidence. Flutterwave is already allowed; no
      replacement provider is required by the assignment.
- [x] Supply the new working Android APK download.
- [ ] Supply a reachable backend, recorded demo's
      share URL and dedicated Rota case-study URL into central submission.
- [ ] Check public/incognito access to every final link and submit per page 34.

Physical WAL replication, a particular calendar/virtual-list library, replay
recording, native crash analytics and optional stretch enhancements are not
added as graduation blockers. Required app/server JS error integration exists
locally; live ingestion and rollout remain operational verification.


## November10 final release update

The actual integrated candidate passed478 tests across44 suites; TypeScript,
lint, shared/API builds, final-image imports (including @sentry/node), peer HTTP
health8080 and separate-worker durable execution passed. Initial partial-run
worker timeout is disclosed in [release report](GRADUATION-RELEASE-REPORT.md).

[APK build progress](https://expo.dev/accounts/scrappy4rls-team/projects/rota/builds/947dc9d2-f999-43a8-b3e4-3b9a4c8a23cf)
uses the existing Expo Android signing key and matching ignored Firebase config.
Build FINISHED; [download the installable APK](https://expo.dev/artifacts/eas/r197ay-RMlQSdm-zTC_w1I4b_gD85C3_c0NBXPBYi8w.apk).
Native compilation/signing succeeded. Physical-device verification remains open.

Intended backend: https://rota-production-84ef.up.railway.app (/health404 observed).
User reports trial expires11 November, no upgrade. Live service settings and
remaining credit are not verified. Deployment still requires explicit approval.
Central SUBMISSION.md is updated locally, not pushed. Demo recording and published
LinkedIn remain completed; demo URL and dedicated portfolio page are still needed.
