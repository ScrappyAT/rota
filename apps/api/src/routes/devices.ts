import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { readSettings,writeSettings } from '../services/settings';

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

// Compatibility endpoints share the authoritative settings/timestamps.
router.get('/preferences',async(req:AuthRequest,res,next)=>{
  try{const client=await pool.connect();try{const settings=await readSettings(client,req.user!.id);res.json({success:true,data:settings.notificationTypes});}finally{client.release();}}catch(error){next(error);}
});
router.patch('/preferences',async(req:AuthRequest,res,next)=>{
  try{
    const data=UpdatePreferencesSchema.parse(req.body);const client=await pool.connect();
    try{await client.query('BEGIN');const settings=await writeSettings(client,req.user!.id,{notificationTypes:data});await client.query('COMMIT');res.json({success:true,data:settings.notificationTypes});}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }catch(error){next(error);}
});
export default router;
