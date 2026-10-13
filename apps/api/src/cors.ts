import cors from 'cors';
import { HttpError } from './http-error';

export const DEFAULT_DEV_ORIGINS = [
  'http://localhost:8081',
  'http://127.0.0.1:8081',
];

export const ALLOWED_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'HEAD',
];

export const ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Requested-With',
  'Accept',
  'Origin',
];

/**
 * Builds CORS options from an env-provided configuration string.
 *
 * - '*' (default in dev) allows any origin for local development.
 * - Production should pass a comma-separated allow-list
 *   (e.g. `CORS_ORIGIN=https://app.rota.example,http://localhost:8081`).
 * - Same-origin requests carry no `Origin` header and are always allowed, and
 *   non-browser clients (the native mobile app) ignore CORS entirely.
 * - Explicitly permits required methods (GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD)
 *   and headers (Content-Type, Authorization, X-Requested-With, Accept, Origin).
 * - Preflight OPTIONS requests are handled with a 204 No Content response.
 * - Wildcard origins are never paired with credentials, preserving production security.
 *
 * Blocked origins receive a 403 `CORS_BLOCKED` via the centralized error
 * handler rather than an ambiguous 500.
 */
export const createCorsMiddleware = (
  originConfig: string,
  extraAllowedOrigins: string[] = []
): cors.CorsOptions => {
  const raw = originConfig.trim();
  if (raw === '*' || raw === '') {
    return {
      origin: '*',
      methods: ALLOWED_METHODS,
      allowedHeaders: ALLOWED_HEADERS,
      credentials: false,
      optionsSuccessStatus: 204,
    };
  }

  const allowed = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  for (const extra of extraAllowedOrigins) {
    if (!allowed.includes(extra)) {
      allowed.push(extra);
    }
  }

  const origin: cors.CorsOptions['origin'] = (originOfRequest, callback) => {
    // Same-origin or non-browser requests (native app) have no Origin header
    if (!originOfRequest || allowed.includes(originOfRequest)) {
      callback(null, true);
    } else {
      callback(new HttpError(403, 'CORS_BLOCKED', 'Origin not allowed'));
    }
  };

  return {
    origin,
    methods: ALLOWED_METHODS,
    allowedHeaders: ALLOWED_HEADERS,
    credentials: false,
    optionsSuccessStatus: 204,
  };
};