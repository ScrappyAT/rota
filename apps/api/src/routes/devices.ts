import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

router.use(authenticate);

const PLATFORMS = ['android', 'ios', 'web'] as const;

const RegisterDeviceSchema = z.object({
  token: z.string().trim().min(10).max(500),
  platform: z.enum(PLATFORMS).default('android'),
});

const UnregisterDeviceSchema = z.object({
  token: z.string().trim().min(1).max(500),
});

const UpdatePreferencesSchema = z
  .object({
    shiftAssigned: z.boolean().optional(),
    swapRequested: z.boolean().optional(),
    swapApproved: z.boolean().optional(),
    swapRejected: z.boolean().optional(),
  })
  .refine((d) => [d.shiftAssigned, d.swapRequested, d.swapApproved, d.swapRejected].some((v) => v !== undefined), {
    message: 'At least one preference must be provided',
    path: ['preferences'],
  });

// Register (or re-register) a device for push notifications. Idempotent per
// (user, token). Also ensures a default notification_preferences row exists.
router.post('/', async (req: AuthRequest, res, next) => {
  try {
    const { token, platform } = RegisterDeviceSchema.parse(req.body);
    const userId = req.user!.id;

    await pool.query(
      `INSERT INTO device_tokens (user_id, token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, token) DO UPDATE
         SET platform = EXCLUDED.platform,
             push_enabled = TRUE,
             last_used_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP`,
      [userId, token, platform]
    );
    await pool.query(
      `INSERT INTO notification_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    res.json({ success: true, data: { token, platform, pushEnabled: true } });
  } catch (error) {
    next(error);
  }
});

// List the authenticated user's registered device tokens.
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT token, platform, push_enabled AS "pushEnabled", last_used_at AS "lastUsedAt"
       FROM device_tokens
       WHERE user_id = $1
       ORDER BY last_used_at DESC`,
      [req.user!.id]
    );
    res.json({ success: true, data: { tokens: rows } });
  } catch (error) {
    next(error);
  }
});

// Unregister a device token (e.g. app logout / revoked push permission).
router.delete('/', async (req: AuthRequest, res, next) => {
  try {
    const { token } = UnregisterDeviceSchema.parse(req.body);
    await pool.query('DELETE FROM device_tokens WHERE user_id = $1 AND token = $2', [
      req.user!.id,
      token,
    ]);
    res.json({ success: true, data: { unregistered: true } });
  } catch (error) {
    next(error);
  }
});

// Read the user's notification preferences (materializing defaults on first read).
router.get('/preferences', async (req: AuthRequest, res, next) => {
  try {
    const userId = req.user!.id;
    await pool.query(
      `INSERT INTO notification_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
    const { rows } = await pool.query(
      `SELECT shift_assigned AS "shiftAssigned",
              swap_requested AS "swapRequested",
              swap_approved AS "swapApproved",
              swap_rejected AS "swapRejected"
       FROM notification_preferences
       WHERE user_id = $1`,
      [userId]
    );
    res.json({ success: true, data: rows[0] });
  } catch (error) {
    next(error);
  }
});

// Update notification preferences (partial update; any subset of the toggles).
router.patch('/preferences', async (req: AuthRequest, res, next) => {
  try {
    const data = UpdatePreferencesSchema.parse(req.body);
    const userId = req.user!.id;

    const sets: string[] = [];
    const params: unknown[] = [];
    let n = 1;
    if (data.shiftAssigned !== undefined) {
      sets.push(`shift_assigned = $${n++}`);
      params.push(data.shiftAssigned);
    }
    if (data.swapRequested !== undefined) {
      sets.push(`swap_requested = $${n++}`);
      params.push(data.swapRequested);
    }
    if (data.swapApproved !== undefined) {
      sets.push(`swap_approved = $${n++}`);
      params.push(data.swapApproved);
    }
    if (data.swapRejected !== undefined) {
      sets.push(`swap_rejected = $${n++}`);
      params.push(data.swapRejected);
    }
    sets.push('updated_at = CURRENT_TIMESTAMP');

    await pool.query(
      `INSERT INTO notification_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
    await pool.query(
      `UPDATE notification_preferences SET ${sets.join(', ')} WHERE user_id = $${n}`,
      [...params, userId]
    );

    const { rows } = await pool.query(
      `SELECT shift_assigned AS "shiftAssigned",
              swap_requested AS "swapRequested",
              swap_approved AS "swapApproved",
              swap_rejected AS "swapRejected"
       FROM notification_preferences
       WHERE user_id = $1`,
      [userId]
    );
    res.json({ success: true, data: rows[0] });
  } catch (error) {
    next(error);
  }
});

export default router;