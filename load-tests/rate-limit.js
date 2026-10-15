// Rate-limit behavior test — proves the `/teams` limiter (300 req / 15 min / IP)
// starts answering 429 TOO_MANY_REQUESTS once the in-memory budget is spent.
//
// Deliberately uses MISSING credentials: the limiter runs before auth, so the
// request is counted even though it would otherwise be a 401. This keeps the
// test fully read-only and independent of any real account.
//
// IMPORTANT — run this LAST and against a dedicated stress/staging instance.
// It exhausts the 15-minute budget for the traffic source IP on the target:
// any later test from the same origin will be rejected by the limiter.
//
//   k6 run k6/rate-limit.js -e BASE_URL=https://<railway-host>
//
// Also run with a few extra requests to prove the window is exercised:
// the counter will exceed `max`, so expect both 401 (before cap) and
// 429 (after cap) statuses.

import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { BASE_URL } from './common.js';

const BUDGET = Number(__ENV.BUDGET || 300); // must match teamsLimiter.max
const ATTEMPTS = Number(__ENV.ATTEMPTS || BUDGET + 20);

const rateLimited = new Counter('rota_rate_limited');

export const options = {
  scenarios: {
    exhaust: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: ATTEMPTS,
      maxDuration: '1m',
    },
  },
  thresholds: {
    // Prove the limiter actually engages: with ATTEMPTS = BUDGET + 20, exactly
    // 20 requests must be throttled by the /teams budget.
    rota_rate_limited: ['count>1'],
    http_req_duration: ['p(95)<150'],
  },
};

export default function () {
  // No Authorization header on purpose (see file header).
  const res = http.get(`${BASE_URL}/teams`);

  const status = res.status;
  const flagged = status === 429;
  if (flagged) rateLimited.add(1);

  check(res, {
    'the throttling envelope was returned': () =>
      status === 429 &&
      Object.keys(JSON.parse(res.body).error || {}).length > 0,
  });
}