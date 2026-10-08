import { HttpError } from './http-error';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID_RE.test(value);

export const uuidParam = (value: string | undefined, name: string): string => {
  if (!value || !isUuid(value)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `Invalid ${name}`);
  }
  return value;
};