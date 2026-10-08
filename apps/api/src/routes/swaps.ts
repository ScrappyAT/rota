import { Router } from 'express';
import { pool } from '../db';
import { AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/tenant';
import { Roles, SwapStatus, SwapReasonSchema } from '@rota/shared';
import { HttpError } from '../http-error';
import { uuidParam } from '../utils';
import { parseLimit, page, cursorPosition, parseStatus } from '../pagination';
import { addActivity } from '../services/activity';

const router = Router({ mergeParams: true });

router.use(requireRole([Roles.OWNER, Roles.MANAGER, Roles.STAFF]));

const SWAP_COLUMNS = `
  sr.id,
  sr.shift_id as "shiftId",
  sr.requested_by as "requestedBy",
  sr.offered_to as "offeredTo",
  sr.status,
  sr.reason,
  sr.reviewed_by as "reviewedBy",
  sr.reviewed_at as "reviewedAt",
  sr.created_at as "createdAt",
  s.title as "shiftTitle",
  s.starts_at as "shiftStartsAt",
  s.ends_at as "shiftEndsAt"
`;

const reviewerRole = async (client: import('pg').PoolClient, teamId: string, userId: string) => {
  const { rows } = await client.query(
    'SELECT role FROM team_memberships WHERE team_id = $1 AND user_id = $2',
    [teamId, userId]
  );
  return rows[0]?.role ?? null;
};

// List swap requests (staff see their own; owners/managers see the team's)
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const teamId = uuidParam(req.params.teamId, 'teamId');
    const limit = parseLimit(req.query.limit as string | undefined);
    const cursor = cursorPosition(req.query.cursor as string | undefined);
    const status = parseStatus(req.query.status as string | undefined, Object.values(SwapStatus));

    const conditions: string[] = ['s.team_id = $1'];
    const params: unknown[] = [teamId];
    let n = 2;

    if (cursor) {
      conditions.push(`(sr.created_at < $${n} OR (sr.created_at = $${n} AND sr.id < $${n + 1}))`);
      params.push(cursor.timestamp, cursor.id);
      n += 2;
    }
    if (status) {
      conditions.push(`sr.status = $${n}`);
      params.push(status);
      n += 1;
    }

    const myMembership = await pool.query(
      'SELECT role FROM team_memberships WHERE team_id = $1 AND user_id = $2',
      [teamId, req.user!.id]
    );
    const myRole = myMembership.rows[0]?.role;
    if (myRole !== Roles.OWNER && myRole !== Roles.MANAGER) {
      conditions.push(`sr.requested_by = $${n}`);
      params.push(req.user!.id);
      n += 1;
    }

    params.push(limit + 1);

    const { rows } = await pool.query(
      `SELECT ${SWAP_COLUMNS}
       FROM swap_requests sr
       JOIN shifts s ON s.id = sr.shift_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY sr.created_at DESC, sr.id DESC
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

// Approve a swap request
router.post('/:swapId/approve', async (req: AuthRequest, res, next) => {
  try {
    const teamId = uuidParam(req.params.teamId, 'teamId');
    const swapId = uuidParam(req.params.swapId, 'swapId');
    const actorId = req.user!.id;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `SELECT sr.id, sr.shift_id as "shiftId", sr.requested_by as "requestedBy", sr.offered_to as "offeredTo",
                sr.status, s.team_id as "teamId", s.title as "shiftTitle"
         FROM swap_requests sr
         JOIN shifts s ON s.id = sr.shift_id
         WHERE sr.id = $1 AND s.team_id = $2`,
        [swapId, teamId]
      );
      if (rows.length === 0) {
        throw new HttpError(404, 'NOT_FOUND', 'Swap request not found');
      }
      const swap = rows[0];

      const myRole = await reviewerRole(client, teamId, actorId);
      const isManagerOrOwner = myRole === Roles.OWNER || myRole === Roles.MANAGER;
      const isOfferedUser = swap.offeredTo === actorId;

      if (!isManagerOrOwner && !isOfferedUser) {
        throw new HttpError(403, 'FORBIDDEN', 'Only owners, managers, or the proposed replacement can approve this swap');
      }
      if (swap.offeredTo && !isManagerOrOwner && !isOfferedUser) {
        throw new HttpError(403, 'FORBIDDEN', 'Only the proposed replacement can approve a targeted swap');
      }

      if (swap.status !== SwapStatus.PENDING) {
        throw new HttpError(409, 'SWAP_NOT_PENDING', `Swap request is already ${swap.status.toLowerCase()}`);
      }

      if (swap.offeredTo) {
        const offered = await client.query(
          'SELECT 1 FROM team_memberships WHERE team_id = $1 AND user_id = $2',
          [teamId, swap.offeredTo]
        );
        if (offered.rows.length === 0) {
          throw new HttpError(409, 'OFFERED_NOT_MEMBER', 'The proposed replacement is no longer a member of this team');
        }

        const requesterStillAssigned = await client.query(
          'SELECT 1 FROM shift_assignments WHERE shift_id = $1 AND user_id = $2',
          [swap.shiftId, swap.requestedBy]
        );
        if (requesterStillAssigned.rows.length === 0) {
          throw new HttpError(409, 'REQUESTER_NOT_ASSIGNED', 'The requester is no longer assigned to this shift');
        }

        const offeredAlreadyAssigned = await client.query(
          'SELECT 1 FROM shift_assignments WHERE shift_id = $1 AND user_id = $2',
          [swap.shiftId, swap.offeredTo]
        );
        if (offeredAlreadyAssigned.rows.length > 0) {
          throw new HttpError(409, 'OFFERED_ALREADY_ASSIGNED', 'The proposed replacement is already assigned to this shift');
        }

        // Apply the swap: transfer the assignment from requester to the offered user.
        await client.query(
          'DELETE FROM shift_assignments WHERE shift_id = $1 AND user_id = $2',
          [swap.shiftId, swap.requestedBy]
        );
        await client.query(
          'INSERT INTO shift_assignments (shift_id, user_id, assigned_by) VALUES ($1, $2, $3)',
          [swap.shiftId, swap.offeredTo, actorId]
        );
      }

      await client.query(
        `UPDATE swap_requests SET status = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND status = 'PENDING'`,
        [SwapStatus.APPROVED, actorId, swapId]
      );

      const actor = await client.query('SELECT first_name, last_name FROM users WHERE id = $1', [actorId]);
      const actorName = actor.rows[0] ? `${actor.rows[0].first_name} ${actor.rows[0].last_name}` : 'Unknown user';

      await addActivity(client, {
        teamId,
        actorId,
        type: 'SWAP_APPROVED',
        payload: {
          swapId,
          shiftId: swap.shiftId,
          shiftTitle: swap.shiftTitle,
          approvedBy: actorName,
          assignmentTransferred: Boolean(swap.offeredTo),
        },
      });

      await client.query('COMMIT');
      res.json({ success: true });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// Reject a swap request
router.post('/:swapId/reject', async (req: AuthRequest, res, next) => {
  try {
    const teamId = uuidParam(req.params.teamId, 'teamId');
    const swapId = uuidParam(req.params.swapId, 'swapId');
    const { reason } = SwapReasonSchema.parse(req.body);
    const actorId = req.user!.id;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `SELECT sr.id, sr.offered_to as "offeredTo", sr.status, s.team_id as "teamId", s.title as "shiftTitle", sr.shift_id as "shiftId"
         FROM swap_requests sr
         JOIN shifts s ON s.id = sr.shift_id
         WHERE sr.id = $1 AND s.team_id = $2`,
        [swapId, teamId]
      );
      if (rows.length === 0) {
        throw new HttpError(404, 'NOT_FOUND', 'Swap request not found');
      }
      const swap = rows[0];

      const myRole = await reviewerRole(client, teamId, actorId);
      const isManagerOrOwner = myRole === Roles.OWNER || myRole === Roles.MANAGER;
      if (!isManagerOrOwner && swap.offeredTo !== actorId) {
        throw new HttpError(403, 'FORBIDDEN', 'Only owners, managers, or the proposed replacement can reject this swap');
      }

      if (swap.status !== SwapStatus.PENDING) {
        throw new HttpError(409, 'SWAP_NOT_PENDING', `Swap request is already ${swap.status.toLowerCase()}`);
      }

      await client.query(
        `UPDATE swap_requests SET status = $1, reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP, reason = COALESCE($3, reason)
         WHERE id = $4 AND status = 'PENDING'`,
        [SwapStatus.REJECTED, actorId, reason ?? null, swapId]
      );

      await addActivity(client, {
        teamId,
        actorId,
        type: 'SWAP_REJECTED',
        payload: { swapId, shiftId: swap.shiftId, shiftTitle: swap.shiftTitle, reason: reason ?? null },
      });

      await client.query('COMMIT');
      res.json({ success: true });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// Cancel a swap request (requester only)
router.post('/:swapId/cancel', async (req: AuthRequest, res, next) => {
  try {
    const teamId = uuidParam(req.params.teamId, 'teamId');
    const swapId = uuidParam(req.params.swapId, 'swapId');
    const actorId = req.user!.id;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const swap = await fetchSwapForTeamInTx(client, teamId, swapId);

      if (swap.requestedBy !== actorId) {
        throw new HttpError(403, 'FORBIDDEN', 'Only the requester can cancel this swap request');
      }
      if (swap.status !== SwapStatus.PENDING) {
        throw new HttpError(409, 'SWAP_NOT_PENDING', `Swap request is already ${swap.status.toLowerCase()}`);
      }

      await client.query(
        `UPDATE swap_requests SET status = $1 WHERE id = $2 AND status = 'PENDING'`,
        [SwapStatus.CANCELLED, swapId]
      );

      await addActivity(client, {
        teamId,
        actorId,
        type: 'SWAP_CANCELLED',
        payload: { swapId, shiftId: swap.shiftId, shiftTitle: swap.shiftTitle },
      });

      await client.query('COMMIT');
      res.json({ success: true });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

const fetchSwapForTeamInTx = async (client: import('pg').PoolClient, teamId: string, swapId: string) => {
  const { rows } = await client.query(
    `SELECT sr.id, sr.shift_id as "shiftId", sr.requested_by as "requestedBy", sr.offered_to as "offeredTo",
            sr.status, s.team_id as "teamId", s.title as "shiftTitle"
     FROM swap_requests sr
     JOIN shifts s ON s.id = sr.shift_id
     WHERE sr.id = $1 AND s.team_id = $2`,
    [swapId, teamId]
  );
  if (rows.length === 0) {
    throw new HttpError(404, 'NOT_FOUND', 'Swap request not found');
  }
  return rows[0];
};

export default router;