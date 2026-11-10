import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { ApiResponse } from '@rota/shared';
import { logEvent } from './services/observability';
import { captureFailure } from './services/error-tracking';

export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    logEvent('request.error', { route: req.originalUrl, method: req.method, outcome: 'server_error' }, 'error');
    captureFailure({ route: req.originalUrl, method: req.method });
    // Express's default handler prints errors; forward a fixed error when it must close a partial response.
    const safeError = new Error('Response stream failed');
    safeError.stack = undefined;
    return next(safeError);
  }

  if (err instanceof ZodError) {
    const message = err.errors.map((e) => `${e.path.join('.') || 'body'}: ${e.message}`).join('; ');
    const response: ApiResponse<null> = {
      success: false,
      error: { code: 'VALIDATION_ERROR', message },
    };
    return res.status(400).json(response);
  }

  if (err?.type === 'entity.parse.failed') {
    const response: ApiResponse<null> = {
      success: false,
      error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' },
    };
    return res.status(400).json(response);
  }

  const status: number = err?.statusCode || err?.status || 500;

  if (status >= 500) {
    logEvent('request.error', { route: req.originalUrl, method: req.method, status, outcome: 'server_error' }, 'error');
    captureFailure({ route: req.originalUrl, method: req.method, status });
  }

  const response: ApiResponse<null> = {
    success: false,
    error: {
      code: status >= 500 ? 'INTERNAL_SERVER_ERROR' : (err?.code || 'ERROR'),
      message: status >= 500 ? 'An unexpected error occurred' : (err.message || 'Request failed'),
    },
  };

  res.status(status).json(response);
};
