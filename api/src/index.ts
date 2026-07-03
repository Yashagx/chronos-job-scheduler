import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import fjwt from '@fastify/jwt'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { createServer } from 'http'

import { prisma } from './lib/prisma'
import { redis, redisSub } from './lib/redis'
import createSocketServer from './socket'
import { authRoutes } from './routes/auth'
import { projectRoutes } from './routes/projects'
import { queueRoutes } from './routes/queues'
import { jobRoutes } from './routes/jobs'
import { workerRoutes } from './routes/workers'
import { dashboardRoutes } from './routes/dashboard'
import { ChronosError } from './lib/errors'

const PORT = Number(process.env.API_PORT) || 4000
const HOST = process.env.API_HOST || '0.0.0.0'

async function buildApp() {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      ...(process.env.NODE_ENV !== 'production' && {
        transport: { target: 'pino-pretty', options: { colorize: true } },
      }),
    },
    disableRequestLogging: false,
  })

  // ── CORS ─────────────────────────────────────────────────────────────────
  await fastify.register(cors, {
    origin: process.env.CORS_ORIGIN || true,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  })

  // ── Cookies ───────────────────────────────────────────────────────────────
  await fastify.register(cookie)

  // ── JWT ───────────────────────────────────────────────────────────────────
  await fastify.register(fjwt, {
    secret: process.env.JWT_ACCESS_SECRET || 'chronos-dev-secret-at-least-32-chars!!',
    cookie: { cookieName: 'refreshToken', signed: false },
  })

  // ── OpenAPI / Swagger ─────────────────────────────────────────────────────
  await fastify.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Chronos API',
        description: 'Distributed job scheduling platform — REST API reference.\n\nUse `POST /auth/register` to create an account, then `POST /auth/login` to get an access token. Include the token as `Authorization: Bearer <token>` on all protected endpoints.',
        version: '1.0.0',
        contact: { name: 'Chronos', url: 'https://github.com/Yashagx/chronos-job-scheduler' },
      },
      servers: [{ url: 'http://54.87.25.180/api', description: 'Production (EC2)' }, { url: 'http://localhost:4000', description: 'Local development' }],
      components: {
        securitySchemes: {
          BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
  })

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      persistAuthorization: true,
    },
    staticCSP: true,
    theme: { title: 'Chronos API Docs' },
  })

  // ── Global error handler ──────────────────────────────────────────────────
  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof ChronosError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined && { details: error.details }),
        },
      })
    }

    // Fastify validation errors
    if (error.validation) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.validation,
        },
      })
    }

    // Prisma unique constraint violation
    if ((error as NodeJS.ErrnoException & { code?: string }).code === 'P2002') {
      return reply.status(409).send({
        error: { code: 'CONFLICT', message: 'A record with this identifier already exists' },
      })
    }

    fastify.log.error(error)
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred in Chronos' },
    })
  })

  // ── Routes ────────────────────────────────────────────────────────────────
  await fastify.register(authRoutes, { prefix: '/auth' })
  await fastify.register(projectRoutes, { prefix: '/projects' })
  await fastify.register(queueRoutes)
  await fastify.register(jobRoutes)
  await fastify.register(workerRoutes, { prefix: '/workers' })
  await fastify.register(dashboardRoutes, { prefix: '/dashboard' })

  // Health check
  fastify.get('/health', {
    schema: {
      tags: ['System'],
      summary: 'Health check — returns 200 if API is up',
      response: { 200: { type: 'object', properties: { status: { type: 'string' }, service: { type: 'string' }, timestamp: { type: 'string' } } } },
    },
  }, async () => ({ status: 'ok', service: 'chronos-api', timestamp: new Date().toISOString() }))

  return fastify
}

async function main() {
  const fastify = await buildApp()

  // Create underlying HTTP server so Socket.io can attach
  const httpServer = createServer(fastify.server)

  // Attach Socket.io to the HTTP server
  await createSocketServer(httpServer)

  // Connect to Redis
  await redis.connect()

  // Start listening
  await fastify.listen({ port: PORT, host: HOST })
  console.log(`\n🚀 Chronos API running at http://${HOST}:${PORT}`)
  console.log(`📖 Swagger UI: http://${HOST}:${PORT}/docs\n`)

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    fastify.log.info(`Received ${signal}, shutting down gracefully...`)
    await fastify.close()
    await prisma.$disconnect()
    redis.disconnect()
    redisSub.disconnect()
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  console.error('Fatal error starting Chronos API:', err)
  process.exit(1)
})
