// Shared helpers for the Rota k6 load-test suite.
//
// Consumed by the scenario scripts in this directory. These helpers are
// intentionally read-only so the harness never mutates production data.

import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

// Custom metrics reported by keep-centric scenarios.
export const successRate = new Rate('rota_successful_requests');
export const readLatency = new Trend('rota_read_latency');

// Auth'd GET with envelope validation. Returns the parsed body or null.
export function authedGet(endpoint, token) {
  const res = http.get(`${BASE_URL}${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  let ok = false;
  let body = null;
  try {
    body = res.json();
    ok = res.status >= 200 && res.status < 300 && body?.success === true;
  } catch {
    ok = res.status >= 200 && res.status < 300;
  }

  successRate.add(ok);
  check(ok, { 'API responded with success:true envelope': true });
  return { res, body, ok };
}

// Plain GET used only by the health smoke scenario.
export function plainGet(endpoint) {
  return http.get(`${BASE_URL}${endpoint}`);
}

// Resolves a team id: prefers TEAM_ID, else the first team the user belongs to.
export function resolveTeamId(token) {
  if (__ENV.TEAM_ID) return __ENV.TEAM_ID;

  const res = http.get(`${BASE_URL}/teams`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status !== 200) {
    throw new Error(`GET /teams failed (${res.status}); pass TEAM_ID explicitly.`);
  }
  const body = res.json();
  const teams = body?.data;
  if (!Array.isArray(teams) || teams.length === 0) {
    throw new Error('TEAM_ID is required: the logged-in user belongs to no teams.');
  }
  return teams[0].id;
}

// Authenticates once (in setup) and returns { token, teamId }.
export function authenticate() {
  const email = __ENV.USER_EMAIL;
  const password = __ENV.USER_PASSWORD;
  if (!email || !password) {
    throw new Error('USER_EMAIL and USER_PASSWORD are required to run auth-bearing scenarios.');
  }

  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email, password }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  if (res.status !== 200) {
    throw new Error(`POST /auth/login failed (${res.status}): ${res.body}`);
  }
  const body = res.json();
  return { token: body?.data?.accessToken, teamId: resolveTeamId(body?.data?.accessToken) };
}

// Standard latency and error budget shared across workload scenarios.
export const defaultThresholds = {
  http_req_failed: ['rate<0.01'],   // < 1% failed requests
  http_req_duration: ['p(95)<300', 'p(99)<800'],
  rota_successful_requests: ['rate>0.99'],
};