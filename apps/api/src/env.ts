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
    REDIS_URL: z.string().url(),
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
    // Comma-separated allow-list of browser origins. '*' (default) is a dev
    // posture; production requires an explicit allow-list.
    CORS_ORIGIN: z.string().default('*'),
    // Expo push service endpoint (override only in tests/self-hosted setups).
    EXPO_PUSH_URL: z
      .string()
      .url()
      .default('https://exp.host/--/api/v2/push/send'),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV !== 'production') return;
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
    if (!process.env.CORS_ORIGIN || process.env.CORS_ORIGIN === '*') {
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
