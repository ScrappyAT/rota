import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { env } from './env';
import { pool } from './db';
import { redisClient } from './redis';
import { errorHandler } from './error-handler';
import { ApiResponse } from '@rota/shared';

import authRouter from './routes/auth';
import teamsRouter from './routes/teams';
import invitationsRouter from './routes/invitations';

const app = express();
app.use(cors());
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
  max: 100,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Try again later' } }
});

app.use('/auth', apiLimiter, authRouter);
app.use('/teams', teamsRouter);
app.use('/invitations', invitationsRouter);

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
