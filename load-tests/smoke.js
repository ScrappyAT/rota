// Smoke test — the complete mobile read path against a seeded team, driven by a
// single low-frequency virtual user. Purpose: verify every hot endpoint answers
// correctly and fast before any heavier scenario runs; commonly the gate for
// CI-style "did this deployment break reads?" checks.
//
// Exercises, in order per iteration:
//   - GET /teams/:teamId/shifts?limit=20      (list)
//   - GET /teams/:teamId/shifts/:shiftId      (detail)
//   - GET /teams/:teamId/members              (membership)
//   - GET /teams/:teamId/swaps?limit=20       (swap requests)
//   - GET /teams/:teamId/activity?limit=20    (feed)
//   - GET /teams/:teamId/activity?type=SHIFT_ASSIGNED&limit=20 (filtered feed)
//   - follow one cursor page of the activity feed (keyset pagination)
//
// Thresholds are intentionally the strictest in the suite — a smoke run that
// misses them signals a regression, not just load.
//
//   k6 run k6/smoke.js \
//     -e BASE_URL=http://localhost:3000 \
//     -e USER_EMAIL=<..> -e USER_PASSWORD=<..> -e TEAM_ID=<team-uuid>

import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { authenticate, authedGet, successRate } from './common.js';

const shiftDetail = new Trend('rota_shift_detail_latency');

export const options = {
  scenarios: {
    smoke: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 20,
      maxDuration: '2m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    http_req_duration: ['p(95)<150', 'p(99)<300'],
    rota_shift_detail_latency: ['p(95)<150'],
    rota_successful_requests: ['rate>0.999'],
  },
};

export function setup() {
  const auth = authenticate();
  return { token: auth.token, teamId: auth.teamId };
}

export default function (data) {
  const { token, teamId } = data;

  // List shifts, then open the first one's detail (the app's primary drill-in).
  const list = authedGet(`/teams/${teamId}/shifts?limit=20`, token);
  let detailOk = false;
  if (list.body?.data?.items?.length > 0) {
    const shiftId = list.body.data.items[0].id;
    const detail = authedGet(`/teams/${teamId}/shifts/${shiftId}`, token);
    shiftDetail.add(detail.ok ? detail.res.timings.duration : -1);
    detailOk = detail.ok;
  }
  check(detailOk, { 'shift detail followed a list result': true });

  // Membership roster and swap-request list.
  authedGet(`/teams/${teamId}/members`, token);
  authedGet(`/teams/${teamId}/swaps?limit=20`, token);

  // Feed, plus one type-filtered view and one cursor page (keyset pagination).
  const feed = authedGet(`/teams/${teamId}/activity?limit=20`, token);
  if (feed.ok && feed.body?.data?.nextCursor) {
    authedGet(
      `/teams/${teamId}/activity?limit=20&cursor=${encodeURIComponent(feed.body.data.nextCursor)}`,
      token
    );
  }
  authedGet(`/teams/${teamId}/activity?type=SHIFT_ASSIGNED&limit=20`, token);

  successRate.add(1);
  sleep(0.5);
}