import { Router } from 'express';
import crypto from 'crypto';
import { pool } from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/tenant';
import { Roles } from '@rota/shared';

const router = Router();

router.use(authenticate);

// Create invitation
router.post('/team/:teamId', requireRole([Roles.OWNER, Roles.MANAGER]), async (req: AuthRequest, res, next) => {
  try {
    const { email, role } = req.body;
    const teamId = req.params.teamId;

    if (!email || !role || !Object.values(Roles).includes(role)) {
      return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Invalid payload' } });
    }

    const myRoleRes = await pool.query('SELECT role FROM team_memberships WHERE team_id = $1 AND user_id = $2', [teamId, req.user!.id]);
    const myRole = myRoleRes.rows[0].role;

    if (myRole === Roles.MANAGER && role !== Roles.STAFF) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Managers can only invite staff' } });
    }

    // Check if user is already a member
    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existingUser.rows.length > 0) {
      const existingMember = await pool.query('SELECT id FROM team_memberships WHERE team_id = $1 AND user_id = $2', [teamId, existingUser.rows[0].id]);
      if (existingMember.rows.length > 0) {
        return res.status(400).json({ success: false, error: { code: 'ALREADY_MEMBER', message: 'User is already in the team' } });
      }
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 days

    await pool.query(
      'INSERT INTO invitations (team_id, email, role, token_hash, inviter_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (team_id, email) WHERE accepted_at IS NULL DO UPDATE SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, role = EXCLUDED.role, inviter_id = EXCLUDED.inviter_id',
      [teamId, email.toLowerCase(), role, tokenHash, req.user!.id, expiresAt]
    );

    res.status(201).json({ success: true, data: { token } }); // Shareable token
  } catch (error) {
    next(error);
  }
});

// List invitations
router.get('/team/:teamId', requireRole([Roles.OWNER, Roles.MANAGER]), async (req: AuthRequest, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, role, expires_at as "expiresAt", created_at as "createdAt" FROM invitations WHERE team_id = $1 AND accepted_at IS NULL AND expires_at > NOW()',
      [req.params.teamId]
    );
    res.json({ success: true, data: rows });
  } catch (error) {
    next(error);
  }
});

// Accept invitation
// This shouldn't be under /:teamId/ because accepting requires knowing just the token. We will handle it in a separate block in index.ts, but let's define it here.
router.post('/accept', async (req: AuthRequest, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Token is required' } });

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inviteRes = await client.query(
        'SELECT id, team_id, email, role FROM invitations WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > NOW()',
        [tokenHash]
      );

      if (inviteRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid or expired invitation' } });
      }

      const invite = inviteRes.rows[0];

      if (req.user!.email !== invite.email) {
        await client.query('ROLLBACK');
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Email mismatch' } });
      }

      await client.query(
        'INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (team_id, user_id) DO NOTHING',
        [invite.team_id, req.user!.id, invite.role]
      );

      await client.query('UPDATE invitations SET accepted_at = NOW() WHERE id = $1', [invite.id]);
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

export default router;
