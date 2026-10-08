import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { pool } from '../db';
import { env } from '../env';
import { RegisterSchema, LoginSchema, AuthResponse, User } from '@rota/shared';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

const generateTokens = (user: User) => {
  const accessToken = jwt.sign(user, env.JWT_SECRET, { expiresIn: '15m' });
  const refreshToken = crypto.randomBytes(40).toString('hex');
  return { accessToken, refreshToken };
};

router.post('/register', async (req, res, next) => {
  try {
    const data = RegisterSchema.parse(req.body);
    const hash = await bcrypt.hash(data.password, 10);
    
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        'INSERT INTO users (email, first_name, last_name, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, email, first_name, last_name, created_at',
        [data.email, data.firstName, data.lastName, hash]
      );
      
      const user = rows[0] as unknown as User;
      const { accessToken, refreshToken } = generateTokens(user);
      
      const refreshHash = await bcrypt.hash(refreshToken, 10);
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
      await client.query(
        'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [user.id, refreshHash, expiresAt]
      );

      res.status(201).json({ success: true, data: { user, accessToken, refreshToken } });
    } catch (e: any) {
      if (e.code === '23505') { // unique violation
        res.status(400).json({ success: false, error: { code: 'DUPLICATE_ACCOUNT', message: 'Email already exists' } });
      } else {
        throw e;
      }
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const data = LoginSchema.parse(req.body);
    const { rows } = await pool.query('SELECT id, email, first_name as "firstName", last_name as "lastName", created_at as "createdAt", password_hash FROM users WHERE email = $1', [data.email]);
    
    if (rows.length === 0) {
      return res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
    }
    
    const userRow = rows[0];
    const match = await bcrypt.compare(data.password, userRow.password_hash);
    if (!match) {
      return res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
    }
    
    const user: User = { id: userRow.id, email: userRow.email, firstName: userRow.firstName, lastName: userRow.lastName, createdAt: userRow.createdAt };
    const { accessToken, refreshToken } = generateTokens(user);
    const refreshHash = await bcrypt.hash(refreshToken, 10);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    
    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, refreshHash, expiresAt]
    );

    res.json({ success: true, data: { user, accessToken, refreshToken } });
  } catch (error) {
    next(error);
  }
});

router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken, userId } = req.body;
    if (!refreshToken || !userId) return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Missing tokens' } });

    const { rows } = await pool.query('SELECT id, token_hash, expires_at, revoked_at FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    
    let validTokenId = null;
    for (const row of rows) {
      if (row.expires_at > new Date() && await bcrypt.compare(refreshToken, row.token_hash)) {
        validTokenId = row.id;
        break;
      }
    }

    if (!validTokenId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired refresh token' } });
    }

    // Revoke old token
    await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1', [validTokenId]);

    // Get user
    const userRes = await pool.query('SELECT id, email, first_name as "firstName", last_name as "lastName", created_at as "createdAt" FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];

    const tokens = generateTokens(user);
    const refreshHash = await bcrypt.hash(tokens.refreshToken, 10);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, refreshHash, expiresAt]
    );

    res.json({ success: true, data: { user, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken } });
  } catch (error) {
    next(error);
  }
});

router.post('/logout', authenticate, async (req: AuthRequest, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken && req.user) {
      const { rows } = await pool.query('SELECT id, token_hash FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL', [req.user.id]);
      for (const row of rows) {
        if (await bcrypt.compare(refreshToken, row.token_hash)) {
          await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1', [row.id]);
        }
      }
    }
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.get('/me', authenticate, async (req: AuthRequest, res, next) => {
  res.json({ success: true, data: req.user });
});

export default router;
