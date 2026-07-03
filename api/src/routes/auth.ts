/**
 * auth.ts — Authentication routes for Chronos API.
 *
 * Refresh token revocation strategy:
 *   When a refresh token is issued, its JTI (a random nanoid) is stored in
 *   Redis at key `refresh:jti:<jti>` with a TTL matching the token expiry
 *   (7 days). On POST /auth/refresh we verify the JTI is still in Redis; on
 *   POST /auth/logout we delete it. This gives us O(1) server-side revocation
 *   without a DB lookup on every request.
 *
 *   Why Redis (not a DB table)?
 *     - Refresh tokens are ephemeral — no audit requirement beyond "is it valid".
 *     - Redis TTL automatically purges expired entries; no background job needed.
 *     - A DB row would add a write + read on every refresh cycle unnecessarily.
 */

import { FastifyInstance } from 'fastify'
import bcrypt from 'bcrypt'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { prisma } from '../lib/prisma'
import { redis } from '../lib/redis'
import { rateLimit, AUTH_LIMIT } from '../middleware/rateLimit'
import {
  UnauthorizedError,
  ConflictError,
  ValidationError,
} from '../lib/errors'

const BCRYPT_ROUNDS = 12
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days
const REFRESH_COOKIE = 'chronos_refresh'
const ACCESS_COOKIE = 'chronos_access'

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  orgName: z.string().optional(),
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

interface JwtPayload {
  sub: string
  email: string
  role: string
  type: 'access' | 'refresh'
  jti?: string
  iat?: number
  exp?: number
}

function issueTokens(
  fastify: FastifyInstance,
  user: { sub: string; email: string; role: string }
): { accessToken: string; refreshToken: string; jti: string } {
  const jti = nanoid(32)

  const accessToken = fastify.jwt.sign(
    { sub: user.sub, email: user.email, role: user.role, type: 'access' },
    { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m' }
  )

  const refreshToken = fastify.jwt.sign(
    { sub: user.sub, email: user.email, role: user.role, type: 'refresh', jti },
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d' }
  )

  return { accessToken, refreshToken, jti }
}

function setRefreshCookie(reply: any, token: string) {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/auth',
    maxAge: REFRESH_TTL_SECONDS,
  })
}

function setAccessCookie(reply: any, token: string) {
  reply.setCookie(ACCESS_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 15 * 60,
  })
}

/** Stores the refresh token JTI in Redis with a 7-day TTL. */
async function storeRefreshJti(jti: string): Promise<void> {
  await redis.set(`refresh:jti:${jti}`, '1', 'EX', REFRESH_TTL_SECONDS)
}

/** Returns true if the JTI is still valid (not revoked). */
async function isRefreshJtiValid(jti: string): Promise<boolean> {
  const result = await redis.get(`refresh:jti:${jti}`)
  return result === '1'
}

/** Revokes a refresh token JTI by deleting it from Redis. */
async function revokeRefreshJti(jti: string): Promise<void> {
  await redis.del(`refresh:jti:${jti}`)
}

const authRateLimit = rateLimit('auth', AUTH_LIMIT)

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // ── POST /auth/register ────────────────────────────────────────────────────
  fastify.post(
    '/register',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Register a new user',
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 8 },
            orgName: { type: 'string' },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                  role: { type: 'string' },
                  createdAt: { type: 'string' },
                },
              },
              accessToken: { type: 'string' },
              organization: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                },
              },
            },
          },
        },
      },
      preHandler: [authRateLimit],
    },
    async (request, reply) => {
      const parsed = registerSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new ValidationError('Invalid request body', parsed.error.flatten())
      }

      const { email, password, orgName } = parsed.data

      const existing = await prisma.user.findUnique({ where: { email } })
      if (existing) throw new ConflictError('A user with this email already exists')

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)

      const result = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email, passwordHash },
        })

        const org = await tx.organization.create({
          data: {
            name: orgName ?? `${email.split('@')[0]}'s Org`,
            ownerId: user.id,
          },
        })

        await tx.orgMembership.create({
          data: { orgId: org.id, userId: user.id, role: 'owner' },
        })

        return { user, org }
      })

      const { accessToken, refreshToken, jti } = issueTokens(fastify, {
        sub: result.user.id,
        email: result.user.email,
        role: result.user.role,
      })

      // Store JTI in Redis for server-side revocation capability
      await storeRefreshJti(jti)

      setRefreshCookie(reply, refreshToken)
      setAccessCookie(reply, accessToken)

      return reply.code(201).send({
        user: {
          id: result.user.id,
          email: result.user.email,
          role: result.user.role,
          createdAt: result.user.createdAt.toISOString(),
        },
        accessToken,
        organization: {
          id: result.org.id,
          name: result.org.name,
        },
      })
    }
  )

  // ── POST /auth/login ───────────────────────────────────────────────────────
  fastify.post(
    '/login',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Log in with email and password',
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                  role: { type: 'string' },
                  createdAt: { type: 'string' },
                },
              },
              accessToken: { type: 'string' },
            },
          },
        },
      },
      preHandler: [authRateLimit],
    },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new ValidationError('Invalid request body', parsed.error.flatten())
      }

      const { email, password } = parsed.data

      const user = await prisma.user.findUnique({ where: { email } })
      if (!user) throw new UnauthorizedError('Invalid email or password')

      const valid = await bcrypt.compare(password, user.passwordHash)
      if (!valid) throw new UnauthorizedError('Invalid email or password')

      const { accessToken, refreshToken, jti } = issueTokens(fastify, {
        sub: user.id,
        email: user.email,
        role: user.role,
      })

      await storeRefreshJti(jti)
      setRefreshCookie(reply, refreshToken)
      setAccessCookie(reply, accessToken)

      return reply.send({
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          createdAt: user.createdAt.toISOString(),
        },
        accessToken,
      })
    }
  )

  // ── POST /auth/refresh ─────────────────────────────────────────────────────
  fastify.post(
    '/refresh',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Exchange a refresh token for a new access+refresh token pair',
        description:
          'The refresh token JTI is checked against Redis. If it has been revoked ' +
          '(via logout) or expired, a 401 is returned. On success, the old JTI is ' +
          'rotated out and a new one issued.',
        response: {
          200: {
            type: 'object',
            properties: {
              accessToken: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const rawCookies = request.cookies as Record<string, string>
      const refreshToken = rawCookies[REFRESH_COOKIE]
      if (!refreshToken) {
        throw new UnauthorizedError('No refresh token provided')
      }

      let payload: JwtPayload
      try {
        payload = fastify.jwt.verify<JwtPayload>(refreshToken)
      } catch {
        throw new UnauthorizedError('Invalid or expired refresh token')
      }

      if (payload.type !== 'refresh') {
        throw new UnauthorizedError('Invalid token type')
      }

      // Server-side validity check: is this JTI still in Redis?
      if (!payload.jti || !(await isRefreshJtiValid(payload.jti))) {
        throw new UnauthorizedError('Refresh token has been revoked or expired')
      }

      const user = await prisma.user.findUnique({ where: { id: payload.sub } })
      if (!user) throw new UnauthorizedError('User not found')

      // Rotate: revoke old JTI, issue new one
      await revokeRefreshJti(payload.jti)
      const { accessToken, refreshToken: newRefresh, jti: newJti } = issueTokens(fastify, {
        sub: user.id,
        email: user.email,
        role: user.role,
      })
      await storeRefreshJti(newJti)

      setRefreshCookie(reply, newRefresh)
      setAccessCookie(reply, accessToken)

      return reply.send({ accessToken })
    }
  )

  // ── POST /auth/logout ──────────────────────────────────────────────────────
  fastify.post(
    '/logout',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Log out and revoke the refresh token',
        description:
          'Deletes the refresh token JTI from Redis, making it immediately invalid ' +
          'server-side. The short-lived access token remains valid until it expires ' +
          '(max 15 minutes) — this is the standard trade-off for stateless JWTs.',
        response: {
          200: {
            type: 'object',
            properties: {
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const rawCookies = request.cookies as Record<string, string>
      const refreshToken = rawCookies[REFRESH_COOKIE]

      if (refreshToken) {
        try {
          const payload = fastify.jwt.verify<JwtPayload>(refreshToken)
          if (payload.jti) {
            await revokeRefreshJti(payload.jti)
          }
        } catch {
          // Token already expired or malformed — nothing to revoke
        }
      }

      reply.clearCookie(REFRESH_COOKIE, { path: '/auth' })
      reply.clearCookie(ACCESS_COOKIE, { path: '/' })
      return reply.send({ message: 'Logged out successfully' })
    }
  )
}

export default authRoutes
