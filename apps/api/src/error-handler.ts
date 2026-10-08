import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { ApiResponse } from '@rota/shared';

export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    return next(err);
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
    console.error('Error:', err);
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
