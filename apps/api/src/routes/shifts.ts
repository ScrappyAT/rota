import { Router } from 'express';
import { pool } from '../db';
import { AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/tenant';
import { Roles, CreateShiftSchema, UpdateShiftSchema, AssignShiftSchema, CreateSwapSchema, ShiftStatus, SwapStatus } from '@rota/shared';
import { HttpError } from '../http-error';
import { isUuid, uuidParam } from '../utils';
import { parseLimit, page, cursorPosition, parseStatus } from '../pagination';
import { addActivity } from '../services/activity';
import { notify, formatShiftDate } from '../services/notifications';
import { assertSubscriptionActive } from '../billing/service';

const router = Router({ mergeParams: true });

router.use(requireRole([Roles.OWNER, Roles.MANAGER, Roles.STAFF]));

const SHIFT_COLUMNS = `
  s.id,
  s.team_id as "teamId",
  s.created_by as "createdBy",
  s.title,
  s.description,
  s.starts_at as "startsAt",
  s.ends_at as "endsAt",
  s.status,
  s.created_at as "createdAt",
  s.updated_at as "updatedAt"
`;

const fetchShiftRow = async (teamId: string, shiftId: string) => {
  const { rows } = await pool.query(
    `SELECT ${SHIFT_COLUMNS} FROM shifts s WHERE s.id = $1 AND s.team_id = $2`,
    [shiftId, teamId]
  );
  if (rows.length === 0) {
    throw new HttpError(404, 'NOT_FOUND', 'Shift not found');
  }
  return rows[0];
};

const getShiftWithAssignments = async (teamId: string, shiftId: string) => {
  const shift = await fetchShiftRow(teamId, shiftId);
  const { rows: assignmentRows } = await pool.query(
    `SELECT sa.shift_id as "shiftId", sa.user_id as "userId", sa.assigned_by as "assignedBy",
            sa.created_at as "createdAt", u.first_name as "firstName", u.last_name as "lastName"
     FROM shift_assignments sa
     JOIN users u ON u.id = sa.user_id
     WHERE sa.shift_id = $1
     ORDER BY sa.created_at ASC, sa.user_id ASC`,
    [shiftId]
  );
  return { shift, assignments: assignmentRows };
};

const assertAssigneesAreTeamMembers = async (
  client: import('pg').PoolClient,
  teamId: string,
  userIds: string[]
): Promise<void> => {
  const { rows } = await client.query(
    'SELECT user_id FROM team_memberships WHERE team_id = $1 AND user_id = ANY($2::uuid[])',
    [teamId, userIds]
  );
  if (rows.length !== userIds.length) {
    throw new HttpError(400, 'INVALID_ASSIGNEE', 'One or more assignees are not members of this team');
  }
};

// List shifts
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const teamId = uuidParam(req.params.teamId, 'teamId');
    const limit = parseLimit(req.query.limit as string | undefined);
    const cursor = cursorPosition(req.query.cursor as string | undefined);
    const from = req.query.from ? new Date(req.query.from as string) : null;
    const to = req.query.to ? new Date(req.query.to as string) : null;
    const status = parseStatus(req.query.status as string | undefined, Object.values(ShiftStatus));
    const assignedTo = req.query.assignedTo as string | undefined;

    if (assignedTo && !isUuid(assignedTo)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid assignedTo');
    }
    if (from && Number.isNaN(from.getTime())) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid from date');
    }
    if (to && Number.isNaN(to.getTime())) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid to date');
    }

    const conditions: string[] = ['s.team_id = $1'];
    const params: unknown[] = [teamId];
    let n = 2;

    if (cursor) {
      conditions.push(`(s.starts_at < $${n} OR (s.starts_at = $${n} AND s.id < $${n + 1}))`);
      params.push(cursor.timestamp, cursor.id);
      n += 2;
    }
    if (from) {
      conditions.push(`s.starts_at >= $${n}`);
      params.push(from);
      n += 1;
    }
    if (to) {
      conditions.push(`s.starts_at <= $${n}`);
      params.push(to);
      n += 1;
    }
    if (status) {
      conditions.push(`s.status = $${n}`);
      params.push(status);
      n += 1;
    }
    if (assignedTo) {
      conditions.push(
        `EXISTS (SELECT 1 FROM shift_assignments sa WHERE sa.shift_id = s.id AND sa.user_id = $${n})`
      );
      params.push(assignedTo);
      n += 1;
    }

    params.push(limit + 1);

    const { rows } = await pool.query(
      `SELECT ${SHIFT_COLUMNS}
       FROM shifts s
       WHERE ${conditions.join(' AND ')}
       ORDER BY s.starts_at DESC, s.id DESC
       LIMIT $${n}`,
      params
    );

    const result = page({
      rows,
      limit,
      keyOf: (r) => ({ timestamp: r.startsAt, id: r.id }),
    });

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// Create shift
router.post('/', requireRole([Roles.OWNER, Roles.MANAGER]), async (req: AuthRequest, res, next) => {
  try {
    const teamId = uuidParam(req.params.teamId, 'teamId');
    const data = CreateShiftSchema.parse(req.body);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await assertSubscriptionActive(client, teamId, new Date());

      const shiftRes = await client.query(
        `INSERT INTO shifts (team_id, created_by, title, description, starts_at, ends_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [teamId, req.user!.id, data.title, data.description ?? null, new Date(data.startsAt), new Date(data.endsAt)]
      );
      const shiftId = shiftRes.rows[0].id;

      const assigneeIds = data.assigneeIds ?? [];
      if (assigneeIds.length > 0) {
        await assertAssigneesAreTeamMembers(client, teamId, assigneeIds);
        await client.query(
          `INSERT INTO shift_assignments (shift_id, user_id, assigned_by)
           SELECT $1, user_id, $2 FROM unnest($3::uuid[]) AS user_id
           ON CONFLICT (shift_id, user_id) DO NOTHING`,
          [shiftId, req.user!.id, assigneeIds]
        );
      }

      await addActivity(client, {
        teamId,
        actorId: req.user!.id,
        type: 'SHIFT_CREATED',
        payload: { shiftId, shiftTitle: data.title },
      });

      await client.query('COMMIT');
      if (assigneeIds.length > 0) {
        await Promise.all(
          assigneeIds.map((userId) =>
            notify({
              teamId,
              userId,
              type: 'SHIFT_ASSIGNED',
              title: 'New shift assigned',
              body: `You've been assigned to "${data.title}" on ${formatShiftDate(data.startsAt)}.`,
              data: { teamId, shiftId, event: 'shift_assigned' },
              eventKey: `shift_assigned:${shiftId}:${userId}`,
            })
          )
        );
      }
      const { shift, assignments } = await getShiftWithAssignments(teamId, shiftId);
      res.status(201).json({ success: true, data: { ...shift, assignments } });
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

// Shift detail
router.get('/:shiftId', async (req: AuthRequest, res, next) => {
  try {
    const teamId = uuidParam(req.params.teamId, 'teamId');
    const shiftId = uuidParam(req.params.shiftId, 'shiftId');
    const { shift, assignments } = await getShiftWithAssignments(teamId, shiftId);
    res.json({ success: true, data: { ...shift, assignments } });
  } catch (error) {
    next(error);
  }
});

// Update shift
router.patch('/:shiftId', requireRole([Roles.OWNER, Roles.MANAGER]), async (req: AuthRequest, res, next) => {
  try {
    const teamId = uuidParam(req.params.teamId, 'teamId');
    const shiftId = uuidParam(req.params.shiftId, 'shiftId');
    const data = UpdateShiftSchema.parse(req.body);

    if (Object.keys(data).length === 0) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'No fields to update');
    }

    const current = await fetchShiftRow(teamId, shiftId);

    const startsAt = data.startsAt ? new Date(data.startsAt) : new Date(current.startsAt);
    const endsAt = data.endsAt ? new Date(data.endsAt) : new Date(current.endsAt);
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'endsAt must be after startsAt');
    }

    const changes: string[] = [];
    const sets: string[] = [];
    const params: unknown[] = [];
    let n = 1;

    if (data.title !== undefined) {
      sets.push(`title = $${n++}`);
      params.push(data.title);
      changes.push('title');
    }
    if (data.description !== undefined) {
      sets.push(`description = $${n++}`);
      params.push(data.description);
      changes.push('description');
    }
    if (data.startsAt !== undefined) {
      sets.push(`starts_at = $${n++}`);
      params.push(startsAt);
      changes.push('startsAt');
    }
    if (data.endsAt !== undefined) {
      sets.push(`ends_at = $${n++}`);
      params.push(endsAt);
      changes.push('endsAt');
    }
    if (data.status !== undefined) {
      sets.push(`status = $${n++}`);
      params.push(data.status);
      changes.push('status');
    }

    sets.push(`updated_at = CURRENT_TIMESTAMP`);
    const whereParams = [shiftId, teamId];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const updatedRes = await client.query(
        `UPDATE shifts SET ${sets.join(', ')} WHERE id = $${n++} AND team_id = $${n++}
         RETURNING id, team_id as "teamId", created_by as "createdBy", title, description,
                   starts_at as "startsAt", ends_at as "endsAt", status,
                   created_at as "createdAt", updated_at as "updatedAt"`,
        [...params, ...whereParams]
      );

      await addActivity(client, {
        teamId,
        actorId: req.user!.id,
        type: 'SHIFT_UPDATED',
        payload: { shiftId, shiftTitle: data.title ?? current.title, changes },
      });

      await client.query('COMMIT');
      res.json({ success: true, data: updatedRes.rows[0] });
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

// Delete shift
router.delete('/:shiftId', requireRole([Roles.OWNER, Roles.MANAGER]), async (req: AuthRequest, res, next) => {
  try {
    const teamId = uuidParam(req.params.teamId, 'teamId');
    const shiftId = uuidParam(req.params.shiftId, 'shiftId');

    const current = await fetchShiftRow(teamId, shiftId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Cancel any pending swap requests before the row is cascade-deleted.
      await client.query(
        `UPDATE swap_requests SET status = $1, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = $2
         WHERE shift_id = $3 AND status = $4`,
        [SwapStatus.CANCELLED, req.user!.id, shiftId, SwapStatus.PENDING]
      );
      await addActivity(client, {
        teamId,
        actorId: req.user!.id,
        type: 'SHIFT_DELETED',
        payload: { shiftId, shiftTitle: current.title },
      });
      await client.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
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

// Assign staff to a shift
router.post('/:shiftId/assignments', requireRole([Roles.OWNER, Roles.MANAGER]), async (req: AuthRequest, res, next) => {
  try {
    const teamId = uuidParam(req.params.teamId, 'teamId');
    const shiftId = uuidParam(req.params.shiftId, 'shiftId');
    const { userIds } = AssignShiftSchema.parse(req.body);

    const shift = await fetchShiftRow(teamId, shiftId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assertAssigneesAreTeamMembers(client, teamId, userIds);

      const insertedRes = await client.query(
        `INSERT INTO shift_assignments (shift_id, user_id, assigned_by)
         SELECT $1, user_id, $2 FROM unnest($3::uuid[]) AS user_id
         ON CONFLICT (shift_id, user_id) DO NOTHING
         RETURNING shift_id as "shiftId", user_id as "userId", assigned_by as "assignedBy", created_at as "createdAt"`,
        [shiftId, req.user!.id, userIds]
      );

      const namesRes = await client.query(
        `SELECT first_name, last_name FROM users WHERE id = ANY($1::uuid[])`,
        [userIds]
      );
      const assigneeNames = namesRes.rows.map((r: any) => `${r.first_name} ${r.last_name}`);

      await addActivity(client, {
        teamId,
        actorId: req.user!.id,
        type: 'SHIFT_ASSIGNED',
        payload: { shiftId, assigneeIds: userIds, assigneeNames },
      });

      await client.query('COMMIT');
      // ON CONFLICT DO NOTHING + RETURNING yields only rows actually inserted,
      // so only newly assigned members are notified.
      const newlyAssignedIds = insertedRes.rows.map((row: { userId: string }) => row.userId);
      await Promise.all(
        newlyAssignedIds.map((userId) =>
          notify({
            teamId,
            userId,
            type: 'SHIFT_ASSIGNED',
            title: 'New shift assigned',
            body: `You've been assigned to "${shift.title}" on ${formatShiftDate(shift.startsAt)}.`,
            data: { teamId, shiftId, event: 'shift_assigned' },
            eventKey: `shift_assigned:${shiftId}:${userId}`,
          })
        )
      );
      res.status(201).json({ success: true, data: insertedRes.rows });
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

// Unassign a staff member (OWNER/MANAGER, or staff unassigning themselves)
router.delete('/:shiftId/assignments/:userId', async (req: AuthRequest, res, next) => {
  try {
    const teamId = uuidParam(req.params.teamId, 'teamId');
    const shiftId = uuidParam(req.params.shiftId, 'shiftId');
    const userId = uuidParam(req.params.userId, 'userId');

    const myMembership = await pool.query(
      'SELECT role FROM team_memberships WHERE team_id = $1 AND user_id = $2',
      [teamId, req.user!.id]
    );
    const myRole = myMembership.rows[0]?.role;
    if (myRole !== Roles.OWNER && myRole !== Roles.MANAGER && userId !== req.user!.id) {
      throw new HttpError(403, 'FORBIDDEN', 'Only owners, managers, or the staff member themselves can unassign an assignment');
    }

    const shift = await fetchShiftRow(teamId, shiftId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const delRes = await client.query(
        'DELETE FROM shift_assignments WHERE shift_id = $1 AND user_id = $2',
        [shiftId, userId]
      );
      if (delRes.rowCount === 0) {
        throw new HttpError(404, 'NOT_FOUND', 'Assignment not found');
      }

      const userRes = await client.query(
        'SELECT first_name, last_name FROM users WHERE id = $1',
        [userId]
      );
      const user = userRes.rows[0];

      await addActivity(client, {
        teamId,
        actorId: req.user!.id,
        type: 'SHIFT_UNASSIGNED',
        payload: {
          shiftId,
          shiftTitle: shift.title,
          userId,
          userName: user ? `${user.first_name} ${user.last_name}` : 'Unknown user',
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

// Create a swap request (only the current assignee of the shift may request)
router.post('/:shiftId/swaps', async (req: AuthRequest, res, next) => {
  try {
    const teamId = uuidParam(req.params.teamId, 'teamId');
    const shiftId = uuidParam(req.params.shiftId, 'shiftId');
    const data = CreateSwapSchema.parse(req.body);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const shiftRes = await client.query(
        'SELECT id, title, starts_at as "startsAt" FROM shifts WHERE id = $1 AND team_id = $2 AND status = $3',
        [shiftId, teamId, ShiftStatus.ACTIVE]
      );
      if (shiftRes.rows.length === 0) {
        throw new HttpError(404, 'NOT_FOUND', 'Shift not found');
      }
      const shift = shiftRes.rows[0];

      const isAssigned = await client.query(
        'SELECT 1 FROM shift_assignments WHERE shift_id = $1 AND user_id = $2',
        [shiftId, req.user!.id]
      );
      if (isAssigned.rows.length === 0) {
        throw new HttpError(403, 'FORBIDDEN', 'Only staff assigned to this shift can request a swap');
      }

      if (data.offeredTo) {
        if (data.offeredTo === req.user!.id) {
          throw new HttpError(400, 'VALIDATION_ERROR', 'offeredTo must be a different user');
        }
        const member = await client.query(
          'SELECT 1 FROM team_memberships WHERE team_id = $1 AND user_id = $2',
          [teamId, data.offeredTo]
        );
        if (member.rows.length === 0) {
          throw new HttpError(400, 'INVALID_ASSIGNEE', 'The proposed replacement is not a member of this team');
        }
      }

      const existing = await client.query(
        "SELECT id FROM swap_requests WHERE shift_id = $1 AND requested_by = $2 AND status = 'PENDING'",
        [shiftId, req.user!.id]
      );
      if (existing.rows.length > 0) {
        throw new HttpError(409, 'SWAP_EXISTS', 'A pending swap request already exists for this shift');
      }

      const insertRes = await client.query(
        `INSERT INTO swap_requests (shift_id, requested_by, offered_to, reason)
         VALUES ($1, $2, $3, $4)
         RETURNING id, shift_id as "shiftId", requested_by as "requestedBy", offered_to as "offeredTo",
                   status, reason, created_at as "createdAt"`,
        [shiftId, req.user!.id, data.offeredTo ?? null, data.reason ?? null]
      );
      const swap = insertRes.rows[0];

      await addActivity(client, {
        teamId,
        actorId: req.user!.id,
        type: 'SWAP_REQUESTED',
        payload: {
          swapId: swap.id,
          shiftId,
          shiftTitle: shift.title,
          offeredTo: data.offeredTo ?? null,
          reason: data.reason ?? null,
        },
      });

      await client.query('COMMIT');

      const requester = await pool.query(
        'SELECT first_name, last_name FROM users WHERE id = $1',
        [req.user!.id]
      );
      const requesterName = requester.rows[0]
        ? `${requester.rows[0].first_name} ${requester.rows[0].last_name}`.trim()
        : 'A teammate';

      // 1. Notify team OWNERS and MANAGERS that a shift swap has been requested
      const admins = await pool.query(
        `SELECT user_id FROM team_memberships
         WHERE team_id = $1 AND role IN ('OWNER', 'MANAGER') AND user_id != $2`,
        [teamId, req.user!.id]
      );

      for (const admin of admins.rows) {
        if (swap.offeredTo && admin.user_id === swap.offeredTo) {
          // If the admin is also the offered replacement, they receive the targeted offer notification below
          continue;
        }
        await notify({
          teamId,
          userId: admin.user_id,
          type: 'SWAP_REQUESTED',
          title: 'Shift swap request',
          body: `${requesterName} requested a shift swap for "${shift.title}" on ${formatShiftDate(shift.startsAt)}.`,
          data: { teamId, shiftId, swapId: swap.id, event: 'swap_requested' },
          eventKey: `swap_requested:${swap.id}:admin:${admin.user_id}`,
        });
      }

      // 2. If a specific teammate was offered the shift, notify them as well
      if (swap.offeredTo && swap.offeredTo !== req.user!.id) {
        await notify({
          teamId,
          userId: swap.offeredTo,
          type: 'SWAP_REQUESTED',
          title: 'Shift swap offer',
          body: `${requesterName} offered you the shift "${shift.title}" on ${formatShiftDate(shift.startsAt)}.`,
          data: { teamId, shiftId, swapId: swap.id, event: 'swap_requested' },
          eventKey: `swap_requested:${swap.id}:${swap.offeredTo}`,
        });
      }
      res.status(201).json({ success: true, data: swap });
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

export default router;