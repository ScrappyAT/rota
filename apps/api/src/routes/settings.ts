import { Router } from 'express';
import { SettingsPatchSchema } from '@rota/shared';
import { pool } from '../db';
import { authenticate, AuthRequest } from '../middleware/auth';
import { readSettings, writeSettings } from '../services/settings';
const router = Router();
router.use(authenticate);
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const client = await pool.connect();
    try {
      res.json({ success: true, data: await readSettings(client, req.user!.id) });
    }
    finally {
      client.release();
    }
  }
  catch (error) {
    next(error);
  }
});
router.patch('/', async (req: AuthRequest, res, next) => {
  try {
    const patch = SettingsPatchSchema.parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const data = await writeSettings(client, req.user!.id, patch);
      await client.query('COMMIT');
      res.json({ success: true, data });
    }
    catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    finally {
      client.release();
    }
  }
  catch (error) {
    next(error);
  }
});
export default router;
