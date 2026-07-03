// src/lib/errors.ts
// Domain-specific error classes used throughout the Chronos API.
// All errors carry a machine-readable `code` and HTTP `statusCode`.

export class ChronosError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    statusCode: number,
    details?: unknown,
  ) {
    super(message);
    this.name = 'ChronosError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    // Maintain proper prototype chain
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends ChronosError {
  constructor(message = 'Resource not found', details?: unknown) {
    super('NOT_FOUND', message, 404, details);
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends ChronosError {
  constructor(message = 'Authentication required', details?: unknown) {
    super('UNAUTHORIZED', message, 401, details);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends ChronosError {
  constructor(message = 'Insufficient permissions', details?: unknown) {
    super('FORBIDDEN', message, 403, details);
    this.name = 'ForbiddenError';
  }
}

export class ConflictError extends ChronosError {
  constructor(message = 'Resource already exists', details?: unknown) {
    super('CONFLICT', message, 409, details);
    this.name = 'ConflictError';
  }
}

export class ValidationError extends ChronosError {
  constructor(message = 'Validation failed', details?: unknown) {
    super('VALIDATION_ERROR', message, 400, details);
    this.name = 'ValidationError';
  }
}

export class RateLimitError extends ChronosError {
  public readonly retryAfter: number;

  constructor(retryAfter: number, message = 'Too many requests') {
    super('RATE_LIMITED', message, 429, { retryAfter });
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class BadRequestError extends ChronosError {
  constructor(message = 'Bad request', details?: unknown) {
    super('BAD_REQUEST', message, 400, details);
    this.name = 'BadRequestError';
  }
}
