import { z } from 'zod';
import * as dotenv from 'dotenv';
import path from 'path';

// Load .env from root if it exists
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const envSchema = z.object({
  PORT: z.string().default('3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().default('supersecretjwtkey'),
  JWT_REFRESH_SECRET: z.string().default('supersecretjwtrefreshkey'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
