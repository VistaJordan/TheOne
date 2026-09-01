// Central error shape per SPRINT1-SPEC §5:
//   { "error": { "code": "NOT_FOUND", "message": "...", "details": null } }
// Codes: BAD_REQUEST (400, Zod failure → details holds issues), FORBIDDEN (403,
// S4 role gate), NOT_FOUND (404), INTERNAL (500).

import type { FastifyInstance } from 'fastify';
import { ZodError, type ZodTypeAny, type output } from 'zod';
import type { ApiErrorCode } from '@theone/shared';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INTERNAL: 500,
};

/** Thrown by services/handlers; the error handler renders it into the §5 shape. */
export class ApiError extends Error {
  code: ApiErrorCode;
  details: unknown;
  constructor(code: ApiErrorCode, message: string, details: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
  get statusCode(): number {
    return STATUS_BY_CODE[this.code];
  }
}

export const notFound = (message = 'Not found') => new ApiError('NOT_FOUND', message);
/** S4 role gate — the actor's principal.role is below the required bar. */
export const forbidden = (message: string, details: unknown = null) =>
  new ApiError('FORBIDDEN', message, details);
export const badRequest = (message: string, details: unknown = null) =>
  new ApiError('BAD_REQUEST', message, details);

/**
 * Zod parse that throws a BAD_REQUEST ApiError (details = flattened issues) on
 * failure. Generic over the SCHEMA, not over a payload type, so the result is
 * the schema's OUTPUT — defaults are applied (`limit: number`, not
 * `number | undefined`) and S4's money coercions land as numbers.
 */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ApiError('BAD_REQUEST', 'Validation failed', result.error.flatten());
  }
  return result.data;
}

export function registerErrorHandler(app: FastifyInstance): void {
  // `err` is typed as unknown by Fastify v5's handler signature; the annotation
  // below is purely a narrowing aid — no behaviour changes.
  app.setErrorHandler((rawErr, _req, reply) => {
    const err = rawErr as Error & { statusCode?: number };
    if (err instanceof ApiError) {
      return reply
        .status(err.statusCode)
        .send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply
        .status(400)
        .send({ error: { code: 'BAD_REQUEST', message: 'Validation failed', details: err.flatten() } });
    }
    // Fastify's own validation / body-parse errors carry statusCode 400.
    if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
      return reply
        .status(err.statusCode)
        .send({ error: { code: 'BAD_REQUEST', message: err.message, details: null } });
    }
    app.log.error(err);
    return reply
      .status(500)
      .send({ error: { code: 'INTERNAL', message: 'Internal server error', details: null } });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply
      .status(404)
      .send({ error: { code: 'NOT_FOUND', message: 'Route not found', details: null } });
  });
}
