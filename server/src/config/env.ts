import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env') });

const runtimeEnvironment = {
  ...process.env,
  CORS_ORIGIN: process.env.CORS_ORIGIN?.trim(),
};

const DEVELOPMENT_JWT_SECRET = 'nova-dev-jwt-secret-key-32-chars-plus';

const envSchema = z.object({
  NODE_ENV: z.preprocess(
    (value) => (typeof value === 'string' ? value.toLowerCase() : value),
    z.enum(['development', 'test', 'production']),
  ).default('development'),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().min(1).default('0.0.0.0'),
  DATABASE_URL: z.string().min(1).default('postgresql://postgres:postgres@localhost:5432/nova?schema=public'),
  JWT_SECRET: z.string().min(32).default(DEVELOPMENT_JWT_SECRET),
  JWT_EXPIRES_IN: z.string().default('7d'),
  COOKIE_NAME: z.string().default('nova_session'),
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default(
    process.env.NODE_ENV?.toLowerCase() === 'production' ? 'none' : 'lax',
  ),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(900000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(100),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().default(20),
  TURN_URLS: z.string().default(''),
  TURN_SHARED_SECRET: z.string().optional(),
  TURN_USERNAME_PREFIX: z.string().default('nova'),
  TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().min(300).max(86400).default(3600),
}).superRefine((data, ctx) => {
  const hasProductionSecret = Boolean(process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32);
  const hasProductionDatabaseUrl = Boolean(process.env.DATABASE_URL);
  const hasProductionCorsOrigin = Boolean(runtimeEnvironment.CORS_ORIGIN);

  if (Boolean(data.TURN_URLS.trim()) !== Boolean(data.TURN_SHARED_SECRET)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TURN_SHARED_SECRET'],
      message: 'TURN_URLS and TURN_SHARED_SECRET must be configured together.',
    });
  }

  if (data.NODE_ENV === 'production') {
    if (!hasProductionSecret || data.JWT_SECRET === DEVELOPMENT_JWT_SECRET || data.JWT_SECRET.toLowerCase().includes('replace')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'JWT_SECRET must be configured to a secure value before running in production.',
      });
    }

    if (!hasProductionDatabaseUrl || /^(?:postgres(?:ql)?:\/\/)(?:[^@]+@)?(localhost|127\.0\.0\.1)(?::|\/|$)/i.test(data.DATABASE_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'DATABASE_URL must be explicitly configured before running in production.',
      });
    }

    for (const origin of data.CORS_ORIGIN.split(',').map((value) => value.trim()).filter(Boolean)) {
      try {
        if (new URL(origin).protocol !== 'https:') {
          throw new Error('HTTPS required');
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ORIGIN'],
          message: 'CORS_ORIGIN must contain valid HTTPS origins in production.',
        });
        break;
      }
    }

    if (!hasProductionCorsOrigin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGIN'],
        message: 'CORS_ORIGIN must be explicitly configured before running in production.',
      });
    }

    if (data.CORS_ORIGIN.split(',').some((origin) => origin.trim() === '*')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGIN'],
        message: 'CORS_ORIGIN must contain explicit origins in production; wildcards are not allowed.',
      });
    }

    if (!data.COOKIE_NAME || data.COOKIE_NAME.length < 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['COOKIE_NAME'],
        message: 'COOKIE_NAME must be configured in production.',
      });
    }

    if (data.COOKIE_SAME_SITE === 'none' && !data.CORS_ORIGIN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['COOKIE_SAME_SITE'],
        message: 'COOKIE_SAME_SITE=none requires an explicit CORS_ORIGIN.',
      });
    }
  }
});

export const env = envSchema.parse(runtimeEnvironment);

export default env;
