import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './env';
import { pool } from './db';
import { redisClient } from './redis';
import { errorHandler } from './error-handler';
import { createCorsMiddleware, DEFAULT_DEV_ORIGINS } from './cors';
import { redisRateLimit } from './middleware/rate-limit-redis';
import { ApiResponse } from '@rota/shared';

import authRouter from './routes/auth';
import teamsRouter from './routes/teams';
import invitationsRouter from './routes/invitations';
import billingRouter from './routes/billing';
import devicesRouter from './routes/devices';

const isDev = env.NODE_ENV !== 'production';
const devOrigins = isDev ? DEFAULT_DEV_ORIGINS : [];
const corsMiddleware = cors(createCorsMiddleware(env.CORS_ORIGIN, devOrigins));

const app = express();
app.use(helmet({ frameguard: { action: 'deny' } }));
app.use(corsMiddleware);
app.options('*', corsMiddleware);
app.use(express.json());

app.get('/health', async (req, res, next) => {
  try {
    const dbStatus = await pool.query('SELECT 1').then(() => 'ok').catch(() => 'error');
    const redisStatus = redisClient.isReady ? 'ok' : 'error';

    const response: ApiResponse<{ status: string; db: string; redis: string; timestamp: string }> = {
      success: true,
      data: {
        status: dbStatus === 'ok' && redisStatus === 'ok' ? 'ok' : 'error',
        db: dbStatus,
        redis: redisStatus,
        timestamp: new Date().toISOString()
      }
    };
    res.json(response);
  } catch (error) {
    next(error);
  }
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.AUTH_RATE_LIMIT_MAX,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Try again later' } }
});

// Credential-adjacent mutating endpoints: team mutations and invitations.
const teamsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.TEAMS_RATE_LIMIT_MAX,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Try again later' } }
});
const invitationsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: env.INVITATIONS_RATE_LIMIT_MAX,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Try again later' } }
});

app.use('/auth', apiLimiter, authRouter);
app.use('/teams', teamsLimiter, teamsRouter);
app.use('/invitations', invitationsLimiter, invitationsRouter);
app.use('/devices', redisRateLimit({ windowSeconds: 15 * 60, max: 200, keyPrefix: 'rl:devices' }), devicesRouter);
app.use('/billing', billingRouter);

app.use(errorHandler);

let server: any;

async function startServer() {
  await redisClient.connect();
  server = app.listen(env.PORT, () => {
    console.log(`🚀 API Server running on port ${env.PORT}`);
  });
}

if (require.main === module) {
  startServer().catch(console.error);
}

// Graceful shutdown
const shutdown = async () => {
  console.log('Shutting down gracefully...');
  if (server) {
    server.close(() => {
      console.log('HTTP server closed.');
    });
  }
  await pool.end();
  await redisClient.quit();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { app };
