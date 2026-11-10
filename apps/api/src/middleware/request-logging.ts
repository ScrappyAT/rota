import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { RequestHandler } from 'express';
import type { AuthRequest } from './auth';
import { logEvent, requestContext } from '../services/observability';

export const requestLogging: RequestHandler = (req: AuthRequest, res, next) => {
  const requestId = randomUUID(); // Never trust caller-controlled correlation IDs.
  const started = performance.now();
  const path = req.originalUrl;
  res.setHeader('X-Request-ID', requestId);
  let reported = false;
  const finish = (aborted: boolean) => {
    if (reported) return;
    reported = true;
    const status = res.statusCode;
    logEvent('request.finished', {
      requestId, userId: req.user?.id, route: path, method: req.method,
      durationMs: performance.now() - started, status,
      outcome: aborted ? 'aborted' : status >= 500 ? 'server_error' : status >= 400 ? 'client_error' : 'success',
    });
  };
  res.once('finish', () => finish(false));
  res.once('close', () => finish(!res.writableFinished));
  requestContext.run({ requestId, userId: () => req.user?.id }, next);
};
