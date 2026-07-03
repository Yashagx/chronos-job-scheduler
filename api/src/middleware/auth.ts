// src/middleware/auth.ts
// JWT authentication preHandler — verifies access token from Authorization header
// or the `accessToken` httpOnly cookie and attaches decoded payload to request.user.

import { FastifyRequest, FastifyReply } from 'fastify';
import { UnauthorizedError } from '../lib/errors';
import { JwtPayload } from '../types';

export async function requireAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  // 1. Try Authorization: Bearer <token>
  let token: string | undefined;

  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }

  // 2. Fall back to httpOnly cookie
  if (!token) {
    token = (request.cookies as Record<string, string | undefined>).accessToken;
  }

  if (!token) {
    throw new UnauthorizedError('No authentication token provided');
  }

  try {
    // @fastify/jwt decorates request with jwtVerify
    const payload = await request.jwtVerify<JwtPayload>();

    if (payload.type !== 'access') {
      throw new UnauthorizedError('Invalid token type');
    }

    request.user = payload;
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    throw new UnauthorizedError('Invalid or expired token');
  }
}

export default requireAuth;
