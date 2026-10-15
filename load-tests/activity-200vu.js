// Dedicated 200-VU activity feed benchmark for Rota graduation compliance.
//
// Requirement:
//   "A k6 load test with 200 virtual users simultaneously loading the activity feed.
//    Report response times before and after caching."
//
// Exercises the team activity feed with 200 virtual users simultaneously:
//   - GET /teams/:teamId/activity?limit=20
//   - GET /teams/:teamId/activity?limit=50
//   - GET /teams/:teamId/activity?type=SHIFT_ASSIGNED&limit=20
//   - GET /teams/:teamId/activity?type=SWAP_REQUESTED&limit=20
//
// Read-only: no scripts in this suite mutate database records.

import { sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { authenticate, authedGet, defaultThresholds } from './common.js';

export const feedLatency = new Trend('activity_feed_latency');

const VUS = Number(__ENV.VUS || 200);
const DURATION = __ENV.DURATION || '30s';
const RAMP_UP = __ENV.RAMP_UP || '10s';
const COOL_DOWN = __ENV.COOL_DOWN || '5s';

export const options = {
  scenarios: {
    activity_200vu: {
      executor: 'ramping-vus',
      stages: [
        { duration: RAMP_UP, target: VUS },   // ramp up to 200 VUs
        { duration: DURATION, target: VUS },  // sustained peak 200 simultaneous VUs
        { duration: COOL_DOWN, target: 0 },   // ramp down
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'], // < 1% error rate
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    rota_successful_requests: ['rate>0.99'],
  },
};

const FEED_ENDPOINTS = (teamId) => [
  `/teams/${teamId}/activity?limit=20`,
  `/teams/${teamId}/activity?limit=50`,
  `/teams/${teamId}/activity?type=SHIFT_ASSIGNED&limit=20`,
  `/teams/${teamId}/activity?type=SWAP_REQUESTED&limit=20`,
];

export function setup() {
  const auth = authenticate();
  return { token: auth.token, teamId: auth.teamId };
}

export default function (data) {
  const { token, teamId } = data;
  const endpoints = FEED_ENDPOINTS(teamId);
  const path = endpoints[Math.floor(Math.random() * endpoints.length)];

  const { res, ok } = authedGet(path, token);
  if (ok && res) {
    feedLatency.add(res.timings.duration);
  }
  sleep(0.05 + Math.random() * 0.1); // 50-150ms think time
}
