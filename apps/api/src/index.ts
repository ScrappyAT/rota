import { replicaPool } from './services/read-routing';
import { validateRequestShape } from './middleware/validation';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
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
import settingsRouter from './routes/settings';

const isDev = env.NODE_ENV !== 'production';
const devOrigins = isDev ? DEFAULT_DEV_ORIGINS : [];
const corsMiddleware = cors(createCorsMiddleware(env.CORS_ORIGIN, devOrigins));

const app = express();
app.use(helmet({ frameguard: { action: 'deny' } }));
app.use(corsMiddleware);
app.options('*', corsMiddleware);
app.use(express.json({limit:'32kb'}));
app.use(validateRequestShape);

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

const apiLimiter=redisRateLimit({windowSeconds:900,max:env.AUTH_RATE_LIMIT_MAX,keyPrefix:'rl:auth',failClosed:true});
const teamsLimiter=redisRateLimit({windowSeconds:900,max:env.TEAMS_RATE_LIMIT_MAX,keyPrefix:'rl:teams',failClosed:true});
const invitationsLimiter=redisRateLimit({windowSeconds:900,max:env.INVITATIONS_RATE_LIMIT_MAX,keyPrefix:'rl:invitations',failClosed:true});

app.use('/auth', apiLimiter, authRouter);
app.use('/teams', teamsLimiter, teamsRouter);
app.use('/invitations', invitationsLimiter, invitationsRouter);
app.use('/devices', redisRateLimit({ windowSeconds: 15 * 60, max: 200, keyPrefix: 'rl:devices' }), devicesRouter);
app.use('/billing', billingRouter);
app.use('/settings', redisRateLimit({ windowSeconds: 15 * 60, max: 300, keyPrefix: 'rl:settings' }), settingsRouter);

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
  await replicaPool?.end();
  await pool.end();
  await redisClient.quit();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { app };
