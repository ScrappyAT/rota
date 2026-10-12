import cors from 'cors';
import { HttpError } from './http-error';

/**
 * Builds CORS options from an env-provided configuration string.
 *
 * - '*' (default) allows any origin for local development.
 * - Production should pass a comma-separated allow-list
 *   (e.g. `CORS_ORIGIN=https://app.rota.example,https://admin.rota.example`).
 * - Same-origin requests carry no `Origin` header and are always allowed, and
 *   non-browser clients (the mobile app) ignore CORS entirely.
 *
 * Blocked origins receive a 403 `CORS_BLOCKED` via the centralized error
 * handler rather than an ambiguous 500.
 */
export const createCorsMiddleware = (originConfig: string): cors.CorsOptions => {
  const raw = originConfig.trim();
  if (raw === '*' || raw === '') {
    return {};
  }
  const allowed = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const origin: cors.CorsOptions['origin'] = (originOfRequest, callback) => {
    if (!originOfRequest || allowed.includes(originOfRequest)) {
      callback(null, true);
    } else {
      callback(new HttpError(403, 'CORS_BLOCKED', 'Origin not allowed'));
    }
  };

  return { origin };
};