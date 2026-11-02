import { z } from 'zod';
import * as dotenv from 'dotenv';
import path from 'path';

// Load .env from root if it exists
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const envSchema = z
  .object({
    PORT: z.string().default('3000'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    DATABASE_URL: z.string().url(),
    READ_DATABASE_URL: z.string().url().optional(),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(30).default(10),
    AUTH_MAIL_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
    AUTH_LINK_BASE: z.string().url().default('rota://action'),
    MAIL_API_URL: z.string().url().default('https://api.resend.com/emails'),
    MAIL_API_KEY: z.string().optional(),
    MAIL_FROM: z.string().optional(),
    REDIS_URL: z.string().url(),
    JOB_QUEUE_NAME: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('rota-jobs'),
    JOB_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
    JOB_BACKOFF_MS: z.coerce.number().int().min(10).max(60000).default(1000),
    JOB_POLL_MS: z.coerce.number().int().min(50).max(60000).default(1000),
    JOB_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(2),
    JWT_SECRET: z.string().default('supersecretjwtkey'),
    JWT_REFRESH_SECRET: z.string().default('supersecretjwtrefreshkey'),
    FLW_SECRET_KEY: z.string().optional(),
    FLW_PUBLIC_KEY: z.string().optional(),
    FLW_SECRET_HASH: z.string().optional(),
    FLW_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
    FLW_BASE_URL: z
      .string()
      .url()
      .default('https://api.flutterwave.com'),
    BILLING_CURRENCY: z.string().default('NGN'),
    BILLING_PERIOD_DAYS: z.coerce.number().int().positive().default(30),
    SUBSCRIPTION_GRACE_DAYS: z.coerce.number().int().nonnegative().default(14),
    // Request-limiter budgets, all expressed as max requests per 15 minutes
    // per IP. Only raise these on dedicated load-test instances; production
    // keeps the conservative defaults (see AGENTS.md security rules).
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    TEAMS_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    INVITATIONS_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    // Comma-separated allow-list of browser origins.
    // In development, defaults to allowing Expo web development (http://localhost:8081).
    // Production requires an explicit allow-list. Supports CORS_ORIGIN, CORS_ORIGINS, ALLOWED_ORIGINS.
    CORS_ORIGIN: z
      .string()
      .optional()
      .transform((val) => {
        if (typeof val === 'string' && val.trim().length > 0) return val;
        return (
          process.env.CORS_ORIGIN ||
          process.env.CORS_ORIGINS ||
          process.env.ALLOWED_ORIGINS ||
          (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8081,*')
        );
      }),
    // Expo push service endpoint (override only in tests/self-hosted setups).
    EXPO_PUSH_URL: z
      .string()
      .url()
      .default('https://exp.host/--/api/v2/push/send'),
    EXPO_PUSH_RECEIPTS_URL: z.string().url().default('https://exp.host/--/api/v2/push/getReceipts'),
    // Cache-aside toggle for benchmarking and testing (default true)
    ENABLE_REDIS_CACHE: z
      .string()
      .optional()
      .default('true')
      .transform((val) => val !== 'false' && val !== '0'),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV !== 'production') return;
    if (!cfg.AUTH_MAIL_KEY || !cfg.MAIL_API_KEY || !cfg.MAIL_FROM || !cfg.MAIL_API_URL.startsWith('https://')) {
      ctx.addIssue({code: z.ZodIssueCode.custom, path: ['AUTH_MAIL_KEY'], message: 'Production auth mail needs a 32-byte key, HTTPS provider, API key and verified sender'});
    }
    if (!process.env.JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'JWT_SECRET must be explicitly set when NODE_ENV=production',
      });
    }
    if (!process.env.FLW_SECRET_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FLW_SECRET_KEY'],
        message: 'FLW_SECRET_KEY must be explicitly set when NODE_ENV=production',
      });
    }
    if (!process.env.FLW_SECRET_HASH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FLW_SECRET_HASH'],
        message: 'FLW_SECRET_HASH must be explicitly set when NODE_ENV=production',
      });
    }
    const corsEnv =
      process.env.CORS_ORIGIN ||
      process.env.CORS_ORIGINS ||
      process.env.ALLOWED_ORIGINS ||
      cfg.CORS_ORIGIN;
    if (!corsEnv || corsEnv === '*') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGIN'],
        message: 'CORS_ORIGIN must be an explicit comma-separated allow-list (not "*") when NODE_ENV=production',
      });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
