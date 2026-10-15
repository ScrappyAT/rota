// Health smoke test — verifies the /health endpoint and its DB + Redis probes
// respond quickly under a tiny, constant load.
//
// Run:
//   k6 run k6/health.js                 (local: http://localhost:3000)
//   k6 run k6/health.js -e BASE_URL=https://<railway-host>
//
// Uses no credentials and never touches the database beyond Express's
// `SELECT 1` health probe.

import { check } from 'k6';
import { plainGet } from './common.js';

export const options = {
  scenarios: {
    smoke: {
      executor: 'constant-vus',
      vus: 1,
      duration: '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<150'],
  },
};

export default function () {
  const res = plainGet('/health');
  const ok =
    res.status === 200 &&
    res.json?.().success === true &&
    res.json().data?.status === 'ok' &&
    res.json().data?.db === 'ok' &&
    res.json().data?.redis === 'ok';

  check(res, {
    '/health returns ok for db and redis': () => ok,
  });
}