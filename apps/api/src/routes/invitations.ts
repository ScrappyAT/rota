import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/tenant';
import { Roles } from '@rota/shared';
import { addActivity } from '../services/activity';
import { assertCanGrow } from '../billing/service';
import {
  generateInvitationCode,
  hashInvitationCode,
  isValidInvitationCodeFormat,
  isAttemptBlocked,
  recordFailedAttempt,
  clearFailedAttempts,
  INVITATION_EXPIRATION_MS,
  MAX_FAILED_ATTEMPTS,
} from '../services/invitation';
import { invalidateRoster, invalidateActivity } from '../services/cache';

const router = Router();

router.use(authenticate);

// Dedicated rate limiter on invitation acceptance to prevent brute-force attacks
const acceptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15, // 15 attempts per 15 minutes per IP
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many invitation redemption attempts. Please try again later.',
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Create invitation
router.post('/team/:teamId', requireRole([Roles.OWNER, Roles.MANAGER]), async (req: AuthRequest, res, next) => {
  try {
    const { email, role } = req.body;
    const teamId = req.params.teamId;

    if (!email || !role || !Object.values(Roles).includes(role)) {
      return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Invalid payload' } });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const myRoleRes = await client.query('SELECT role FROM team_memberships WHERE team_id = $1 AND user_id = $2', [teamId, req.user!.id]);
      const myRole = myRoleRes.rows[0].role;

      if (myRole === Roles.MANAGER && role !== Roles.STAFF) {
        await client.query('ROLLBACK');
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Managers can only invite staff' } });
      }

      // Subscription gates: the team must be active and have seats available
      // for the additional member this invitation represents.
      await assertCanGrow(client, teamId, new Date(), 1);

      // Check if user is already a member
      const existingUser = await client.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
      if (existingUser.rows.length > 0) {
        const existingMember = await client.query('SELECT id FROM team_memberships WHERE team_id = $1 AND user_id = $2', [teamId, existingUser.rows[0].id]);
        if (existingMember.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ success: false, error: { code: 'ALREADY_MEMBER', message: 'User is already in the team' } });
        }
      }

      // Generate 6-digit numeric code and hash with collision retry
      let code = generateInvitationCode();
      let tokenHash = hashInvitationCode(code);
      const expiresAt = new Date(Date.now() + INVITATION_EXPIRATION_MS); // 15 minutes

      let inserted = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await client.query(
            'INSERT INTO invitations (team_id, email, role, token_hash, inviter_id, expires_at, attempts) VALUES ($1, $2, $3, $4, $5, $6, 0) ON CONFLICT (team_id, email) WHERE accepted_at IS NULL DO UPDATE SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, role = EXCLUDED.role, inviter_id = EXCLUDED.inviter_id, attempts = 0',
            [teamId, email.toLowerCase(), role, tokenHash, req.user!.id, expiresAt]
          );
          inserted = true;
          break;
        } catch (err: any) {
          if (err.code === '23505' && err.constraint === 'invitations_token_hash_key') {
            code = generateInvitationCode();
            tokenHash = hashInvitationCode(code);
            continue;
          }
          throw err;
        }
      }

      if (!inserted) {
        throw new Error('Failed to generate a unique invitation code. Please try again.');
      }

      await client.query('COMMIT');
      res.status(201).json({
        success: true,
        data: {
          code,
          token: code, // Backward compatibility for clients expecting token
          expiresAt: expiresAt.toISOString(),
        },
      });
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
router.post('/accept', acceptLimiter, async (req: AuthRequest, res, next) => {
  try {
    const userId = req.user!.id;
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';

    // 1. Check if user or IP is blocked from brute force attempts
    if (await isAttemptBlocked(userId) || await isAttemptBlocked(clientIp)) {
      return res.status(429).json({
        success: false,
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many failed invitation attempts. Please wait 15 minutes before trying again.',
        },
      });
    }

    const rawCode = req.body.code ?? req.body.token;
    if (!rawCode || typeof rawCode !== 'string') {
      return res.status(400).json({
        success: false,
        error: { code: 'BAD_REQUEST', message: 'Invitation code is required' },
      });
    }

    const code = rawCode.trim();

    if (!isValidInvitationCodeFormat(code)) {
      await recordFailedAttempt(userId);
      await recordFailedAttempt(clientIp);
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_TOKEN', message: 'Invalid or expired invitation' },
      });
    }

    const tokenHash = hashInvitationCode(code);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inviteRes = await client.query(
        'SELECT id, team_id, email, role, attempts FROM invitations WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > NOW()',
        [tokenHash]
      );

      if (inviteRes.rows.length === 0) {
        await client.query('ROLLBACK');
        await recordFailedAttempt(userId);
        await recordFailedAttempt(clientIp);
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_TOKEN', message: 'Invalid or expired invitation' },
        });
      }

      const invite = inviteRes.rows[0];

      if (req.user!.email.toLowerCase() !== invite.email.toLowerCase()) {
        // Increment attempts on the targeted invitation
        const nextAttempts = (invite.attempts || 0) + 1;
        await client.query('UPDATE invitations SET attempts = $1 WHERE id = $2', [nextAttempts, invite.id]);

        if (nextAttempts >= MAX_FAILED_ATTEMPTS) {
          // Expire invitation immediately if compromised by guessing
          await client.query('UPDATE invitations SET expires_at = NOW() WHERE id = $1', [invite.id]);
        }
        await client.query('COMMIT');

        await recordFailedAttempt(userId);
        await recordFailedAttempt(clientIp);
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Email mismatch' },
        });
      }

      await client.query(
        'INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (team_id, user_id) DO NOTHING',
        [invite.team_id, req.user!.id, invite.role]
      );

      await addActivity(client, {
        teamId: invite.team_id,
        actorId: req.user!.id,
        type: 'MEMBER_JOINED',
        payload: { email: invite.email, role: invite.role },
      });

      await client.query('UPDATE invitations SET accepted_at = NOW() WHERE id = $1', [invite.id]);
      await client.query('COMMIT');

      await invalidateRoster(invite.team_id);
      await invalidateActivity(invite.team_id);

      // Clear failed attempts on successful redemption
      await clearFailedAttempts(userId);
      await clearFailedAttempts(clientIp);

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
