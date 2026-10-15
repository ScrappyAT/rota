// Auth journey test — measures how quickly the credential-handling endpoints
// answer. Runs a low-frequency sequence of login -> /me reads with an
// occasional token refresh, mirroring app startup and session renewal.
//
// Respects the platform budget: /auth is limited to 100 requests / 15 min / IP,
// so this script deliberately stays around 65 auth requests and must be run on
// its own (or before the heavier scenarios). If you reuse the same origin, wait
// for the window to roll over before running rate-limit.js.
//
//   k6 run k6/auth.js \
//     -e BASE_URL=http://localhost:3000 \
//     -e USER_EMAIL=<..> -e USER_PASSWORD=<..>

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { BASE_URL } from './common.js';

const loginLatency = new Trend('rota_login_latency');
const meLatency = new Trend('rota_me_latency');
const successRate = new Rate('rota_auth_success');

const ITERATIONS = 30;
const REFRESH_EVERY = 8;

export const options = {
  scenarios: {
    auth: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: ITERATIONS,
      maxDuration: '4m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    rota_login_latency: ['p(95)<300', 'p(99)<600'],
    rota_me_latency: ['p(95)<150'],
    rota_auth_success: ['rate>0.99'],
  },
};

export default function () {
  const credentials = {
    email: __ENV.USER_EMAIL,
    password: __ENV.USER_PASSWORD,
  };
  if (!credentials.email || !credentials.password) {
    throw new Error('USER_EMAIL and USER_PASSWORD are required.');
  }

  const login = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify(credentials),
    { headers: { 'Content-Type': 'application/json' } }
  );
  loginLatency.add(login.timings.duration);

  const body = login.json();
  const token = body?.data?.accessToken;
  const refreshToken = body?.data?.refreshToken;
  const userId = body?.data?.user?.id;
  const ok =
    login.status === 200 &&
    typeof token === 'string' &&
    body.success === true;

  successRate.add(ok ? 1 : 0);
  check(ok, { 'login returns accessToken': true });
  if (!ok) return;

  const me = http.get(`${BASE_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  meLatency.add(me.timings.duration);
  const meOk = me.status === 200 && me.json()?.data?.id === userId;
  successRate.add(meOk ? 1 : 0);
  check(meOk, { '/auth/me echoes the signed-in user': true });

  // Occasionally rotate the refresh token (session renewal).
  if (__ITER % REFRESH_EVERY === 0 && refreshToken && userId) {
    const refresh = http.post(
      `${BASE_URL}/auth/refresh`,
      JSON.stringify({ refreshToken, userId }),
      { headers: { 'Content-Type': 'application/json' } }
    );
    const refreshOk = refresh.status === 200 && refresh.json()?.success === true;
    successRate.add(refreshOk ? 1 : 0);
    check(refreshOk, { 'refresh rotates the token': true });
  }

  sleep(2 + Math.random() * 4);
}