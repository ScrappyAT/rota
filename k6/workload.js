// Primary workload test — realistic read-heavy usage against a seeded team.
//
// Exercises exactly what phase-3 lists and the mobile app do:
//   - GET /teams/:teamId/shifts (cursor paginated list)
//   - GET /teams/:teamId/activity (cursor paginated feed)
//   - occasional GET /teams/:teamId/members
//
// Phase profile (configurable via env):
//   ramp-up  : 0 -> PEAK_VUS over RAMP_INTERVALS * STEP_DURATION
//   steady   : PEAK_VUS for STEADY_DURATION
//   spike    : SPIKE_VUS for SPIKE_DURATION
//
// Sample load, ~10k activity rows seeded via `npm run db:seed:activity`:
//
//   k6 run k6/workload.js \
//     -e BASE_URL=https://<railway-host> \
//     -e USER_EMAIL=loadtest@example.com \
//     -e USER_PASSWORD='...' \
//     -e TEAM_ID=<team-uuid>
//
// Read-only: no scripts in this suite create or mutate records.

import { sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { authenticate, authedGet, defaultThresholds } from './common.js';

const PEAK_VUS = Number(__ENV.PEAK_VUS || 20);
const SPIKE_VUS = Number(__ENV.SPIKE_VUS || 60);
const STEP_DURATION = '30s';

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      stages: [
        { duration: '1m', target: PEAK_VUS },        // ramp-up
        { duration: '3m', target: PEAK_VUS },        // steady state
        { duration: '1m', target: SPIKE_VUS },       // spike
        { duration: '1m', target: PEAK_VUS },        // recover
        { duration: '1m', target: 0 },               // cool down
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: defaultThresholds,
};

// Weighted endpoint mix, favoring the two lists the app loads most.
const ENDPOINTS = (teamId) => [
  { path: `/teams/${teamId}/shifts?limit=20`, weight: 45 },
  { path: `/teams/${teamId}/activity?limit=20`, weight: 35 },
  { path: `/teams/${teamId}/shifts?limit=50`, weight: 5 },
  { path: `/teams/${teamId}/shifts?status=ACTIVE&from=${new Date(Date.now() - 7 * 864e5).toISOString()}`, weight: 5 },
  { path: `/teams/${teamId}/members`, weight: 5 },
];

const pick = (weighted) => {
  const total = weighted.reduce((sum, w) => sum + w.weight, 0);
  let roll = Math.random() * total;
  for (const item of weighted) {
    roll -= item.weight;
    if (roll <= 0) return item.path;
  }
  return weighted[weighted.length - 1].path;
};

export function setup() {
  const auth = authenticate();
  return { token: auth.token, teamId: auth.teamId };
}

export default function (data) {
  const { token, teamId } = data;
  const endpoints = ENDPOINTS(teamId);

  // 1-3 requests per iteration to approximate user reading bursts.
  const burst = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < burst; i++) {
    authedGet(pick(endpoints), token);
  }
  sleep(0.2 + Math.random() * 0.8); // think time
}