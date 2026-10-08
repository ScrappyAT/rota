import { Router } from 'express';
import { pool } from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/tenant';
import { Roles } from '@rota/shared';

import shiftsRouter from './shifts';
import swapsRouter from './swaps';
import activityRouter from './activity';

const router = Router();

router.use(authenticate);

router.use('/:teamId/shifts', shiftsRouter);
router.use('/:teamId/swaps', swapsRouter);
router.use('/:teamId/activity', activityRouter);

// Create Team
router.post('/', async (req: AuthRequest, res, next) => {
  try {
    const { name } = req.body;
    if (!name || !req.user) return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Invalid payload' } });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const teamRes = await client.query(
        'INSERT INTO teams (name, owner_id) VALUES ($1, $2) RETURNING id, name, owner_id as "ownerId", created_at as "createdAt"',
        [name, req.user.id]
      );
      const team = teamRes.rows[0];

      await client.query(
        'INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, $3)',
        [team.id, req.user.id, Roles.OWNER]
      );
      await client.query('COMMIT');
      res.status(201).json({ success: true, data: team });
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

// List Teams
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT t.id, t.name, t.owner_id as "ownerId", t.created_at as "createdAt" FROM teams t JOIN team_memberships tm ON t.id = tm.team_id WHERE tm.user_id = $1',
      [req.user!.id]
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
});

// Get Team Details
router.get('/:teamId', requireRole([Roles.OWNER, Roles.MANAGER, Roles.STAFF]), async (req: AuthRequest, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, owner_id as "ownerId", created_at as "createdAt" FROM teams WHERE id = $1',
      [req.params.teamId]
    );
    res.json({ success: true, data: rows[0] });
  } catch (error) {
    next(error);
  }
});

// List Members
router.get('/:teamId/members', requireRole([Roles.OWNER, Roles.MANAGER, Roles.STAFF]), async (req: AuthRequest, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT tm.id, tm.team_id as "teamId", tm.user_id as "userId", tm.role, u.email, u.first_name as "firstName", u.last_name as "lastName" FROM team_memberships tm JOIN users u ON tm.user_id = u.id WHERE tm.team_id = $1',
      [req.params.teamId]
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
});

// Update Member Role
router.patch('/:teamId/members/:userId/role', requireRole([Roles.OWNER]), async (req: AuthRequest, res, next) => {
  try {
    const { role } = req.body;
    if (!Object.values(Roles).includes(role)) {
      return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Invalid role' } });
    }
    
    // Prevent last owner demotion
    if (role !== Roles.OWNER) {
      const ownerCheck = await pool.query(
        'SELECT COUNT(*) as count FROM team_memberships WHERE team_id = $1 AND role = $2',
        [req.params.teamId, Roles.OWNER]
      );
      const isCurrentOwner = await pool.query(
        'SELECT role FROM team_memberships WHERE team_id = $1 AND user_id = $2',
        [req.params.teamId, req.params.userId]
      );
      
      if (isCurrentOwner.rows[0]?.role === Roles.OWNER && parseInt(ownerCheck.rows[0].count) <= 1) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Cannot demote the last owner' } });
      }
    }

    await pool.query(
      'UPDATE team_memberships SET role = $1 WHERE team_id = $2 AND user_id = $3',
      [role, req.params.teamId, req.params.userId]
    );
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// Remove Member
router.delete('/:teamId/members/:userId', requireRole([Roles.OWNER, Roles.MANAGER]), async (req: AuthRequest, res, next) => {
  try {
    // Only OWNER can remove OWNER or MANAGER (MANAGER can only remove STAFF)
    const targetMemberRes = await pool.query('SELECT role FROM team_memberships WHERE team_id = $1 AND user_id = $2', [req.params.teamId, req.params.userId]);
    if (targetMemberRes.rows.length === 0) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Member not found' } });
    
    const targetRole = targetMemberRes.rows[0].role;
    
    const myRoleRes = await pool.query('SELECT role FROM team_memberships WHERE team_id = $1 AND user_id = $2', [req.params.teamId, req.user!.id]);
    const myRole = myRoleRes.rows[0].role;
    
    if (myRole === Roles.MANAGER && targetRole !== Roles.STAFF) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Managers can only remove staff' } });
    }
    
    if (targetRole === Roles.OWNER) {
      const ownerCheck = await pool.query(
        'SELECT COUNT(*) as count FROM team_memberships WHERE team_id = $1 AND role = $2',
        [req.params.teamId, Roles.OWNER]
      );
      if (parseInt(ownerCheck.rows[0].count) <= 1) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Cannot remove the last owner' } });
      }
    }

    await pool.query('DELETE FROM team_memberships WHERE team_id = $1 AND user_id = $2', [req.params.teamId, req.params.userId]);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
