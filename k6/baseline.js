// Baseline test — short, gentle, constant read load used as a repeatable
// reference point. The baseline establishes the idle-machine budget that the
// heavier workload.js must hold to (same mix, 5 VUs, tight thresholds).
//
// Mix (same shape as workload.js, see that file for semantics):
//   shifts list (limit 20)  / shifts filtered          >  lists
//   activity feed (limit 20) / one type-filtered feed  >  feed
//   swaps list (limit 20)                              >  swaps
//   members                                             >  roster
//
//   k6 run k6/baseline.js \
//     -e BASE_URL=http://localhost:3000 \
//     -e USER_EMAIL=<..> -e USER_PASSWORD=<..> -e TEAM_ID=<team-uuid>

import { sleep } from 'k6';
import { authenticate, authedGet, defaultThresholds } from './common.js';

export const options = {
  scenarios: {
    baseline: {
      executor: 'constant-vus',
      vus: 5,
      duration: '2m',
    },
  },
  thresholds: {
    ...defaultThresholds,
    http_req_duration: ['p(95)<250', 'p(99)<500'],
  },
};

const ENDPOINTS = (teamId) => [
  { path: `/teams/${teamId}/shifts?limit=20`, weight: 40 },
  { path: `/teams/${teamId}/activity?limit=20`, weight: 30 },
  { path: `/teams/${teamId}/swaps?limit=20`, weight: 10 },
  { path: `/teams/${teamId}/activity?type=SHIFT_ASSIGNED&limit=20`, weight: 8 },
  { path: `/teams/${teamId}/shifts?status=ACTIVE&from=${new Date(Date.now() - 7 * 864e5).toISOString()}`, weight: 6 },
  { path: `/teams/${teamId}/members`, weight: 6 },
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
  const endpoints = ENDPOINTS(data.teamId);
  authedGet(pick(endpoints), data.token);
  sleep(0.3 + Math.random() * 0.7);
}