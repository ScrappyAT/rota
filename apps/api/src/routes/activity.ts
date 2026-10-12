import { Router } from 'express';
import { pool } from '../db';
import { AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/tenant';
import { Roles } from '@rota/shared';
import { HttpError } from '../http-error';
import { uuidParam } from '../utils';
import { parseLimit, page, cursorPosition } from '../pagination';

const router = Router({ mergeParams: true });

router.use(requireRole([Roles.OWNER, Roles.MANAGER, Roles.STAFF]));

const VALID_TYPES = [
  'SHIFT_CREATED',
  'SHIFT_UPDATED',
  'SHIFT_DELETED',
  'SHIFT_ASSIGNED',
  'SHIFT_UNASSIGNED',
  'SWAP_REQUESTED',
  'SWAP_APPROVED',
  'SWAP_REJECTED',
  'SWAP_CANCELLED',
  'MEMBER_JOINED',
  'SUBSCRIPTION_CHANGED',
  'PAYMENT_RECEIVED',
];

// Activity feed
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const teamId = uuidParam(req.params.teamId, 'teamId');
    const limit = parseLimit(req.query.limit as string | undefined);
    const cursor = cursorPosition(req.query.cursor as string | undefined);
    const type = req.query.type as string | undefined;

    if (type && !VALID_TYPES.includes(type)) {
      throw new HttpError(400, 'VALIDATION_ERROR', `type must be one of: ${VALID_TYPES.join(', ')}`);
    }

    const conditions: string[] = ['a.team_id = $1'];
    const params: unknown[] = [teamId];
    let n = 2;

    if (cursor) {
      conditions.push(`(a.created_at < $${n} OR (a.created_at = $${n} AND a.id < $${n + 1}))`);
      params.push(cursor.timestamp, cursor.id);
      n += 2;
    }
    if (type) {
      conditions.push(`a.type = $${n}`);
      params.push(type);
      n += 1;
    }

    params.push(limit + 1);

    const { rows } = await pool.query(
      `SELECT a.id, a.team_id as "teamId", a.actor_id as "actorId", a.type, a.payload, a.created_at as "createdAt"
       FROM activity_events a
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $${n}`,
      params
    );

    const result = page({
      rows,
      limit,
      keyOf: (r) => ({ timestamp: r.createdAt, id: r.id }),
    });

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

export default router;