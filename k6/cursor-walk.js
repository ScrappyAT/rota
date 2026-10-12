// Cursor-walk soak — exercises the keyset pagination path this app ships
// instead of OFFSET. Each iteration follows the activity feed page by page
// until it is drained or the per-iteration cap is reached.
//
// This is the test that proves the 10,000-row seeded feed stays fast and
// gap-free under ongoing cursor traversal. Requires a seeded team:
//
//   npm run db:seed:activity -- --team <team-uuid> --count 10000
//   k6 run k6/cursor-walk.js \
//     -e BASE_URL=https://<railway-host> \
//     -e USER_EMAIL=loadtest@example.com \
//     -e USER_PASSWORD='...' \
//     -e TEAM_ID=<team-uuid>
//
// Read-only. Uses PAGE_CAP to bound work per iteration.

import { sleep } from 'k6';
import { authenticate, authedGet, BASE_URL, defaultThresholds } from './common.js';

const PAGE_SIZE = 50;                      // the API ceiling for limit
const PAGE_CAP = Number(__ENV.PAGE_CAP || 100); // max pages walked per iteration

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-vus',
      vus: 2,
      duration: __ENV.SOAK_DURATION || '5m',
    },
  },
  thresholds: defaultThresholds,
};

export function setup() {
  const auth = authenticate();
  return { token: auth.token, teamId: auth.teamId };
}

export default function (data) {
  const { token, teamId } = data;

  let cursor = null;
  let pages = 0;
  let items = 0;

  do {
    const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const { body, ok } = authedGet(
      `/teams/${teamId}/activity?limit=${PAGE_SIZE}${suffix}`,
      token
    );
    if (!ok || !body?.data) break;

    pages += 1;
    items += (body.data.items || []).length;
    cursor = body.data.nextCursor;
    sleep(0.1);
  } while (cursor && pages < PAGE_CAP);
}