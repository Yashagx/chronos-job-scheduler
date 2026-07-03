// src/routes/workers.ts
// Worker information routes — read-only, requires authentication.

import { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { NotFoundError } from '../lib/errors';
import { parsePagination, buildMeta } from '../lib/pagination';
import { WorkerStatus } from '@prisma/client';

export async function workerRoutes(fastify: FastifyInstance): Promise<void> {

  // ── GET /workers ───────────────────────────────────────────────────────────
  fastify.get(
    '/workers',
    {
      schema: {
        tags: ['Workers'],
        summary: 'List all workers with optional status filter',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['active', 'draining', 'dead'] },
            page: { type: 'string' },
            limit: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    hostname: { type: 'string' },
                    pid: { type: 'number' },
                    status: { type: 'string' },
                    startedAt: { type: 'string' },
                    lastHeartbeatAt: { type: 'string' },
                    activeJobCount: { type: 'number' },
                  },
                },
              },
              meta: { type: 'object' },
            },
          },
        },
      },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const q = request.query as { status?: string; page?: string; limit?: string };
      const { page, limit, skip } = parsePagination(q);

      const where = q.status ? { status: q.status as WorkerStatus } : {};

      const [workers, total] = await Promise.all([
        prisma.worker.findMany({
          where,
          skip,
          take: limit,
          orderBy: [{ status: 'asc' }, { lastHeartbeatAt: 'desc' }],
          include: {
            heartbeats: {
              orderBy: { timestamp: 'desc' },
              take: 1,
              select: { activeJobCount: true, cpuLoad: true, timestamp: true },
            },
          },
        }),
        prisma.worker.count({ where }),
      ]);

      return reply.send({
        data: workers.map((w) => ({
          id: w.id,
          hostname: w.hostname,
          pid: w.pid,
          status: w.status,
          startedAt: w.startedAt.toISOString(),
          lastHeartbeatAt: w.lastHeartbeatAt.toISOString(),
          activeJobCount: w.heartbeats[0]?.activeJobCount ?? 0,
          cpuLoad: w.heartbeats[0]?.cpuLoad ?? null,
          lastHeartbeatTimestamp: w.heartbeats[0]?.timestamp.toISOString() ?? null,
        })),
        meta: buildMeta(total, page, limit),
      });
    },
  );

  // ── GET /workers/:id ───────────────────────────────────────────────────────
  fastify.get(
    '/workers/:id',
    {
      schema: {
        tags: ['Workers'],
        summary: 'Get worker detail',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        response: {
          200: { type: 'object' },
        },
      },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const worker = await prisma.worker.findUnique({
        where: { id },
        include: {
          heartbeats: {
            orderBy: { timestamp: 'desc' },
            take: 5,
          },
          executions: {
            orderBy: { startedAt: 'desc' },
            take: 10,
            select: {
              id: true,
              jobId: true,
              attemptNumber: true,
              status: true,
              startedAt: true,
              finishedAt: true,
              durationMs: true,
              errorMessage: true,
            },
          },
          _count: { select: { executions: true } },
        },
      });

      if (!worker) throw new NotFoundError('Worker not found');

      return reply.send({
        id: worker.id,
        hostname: worker.hostname,
        pid: worker.pid,
        status: worker.status,
        startedAt: worker.startedAt.toISOString(),
        lastHeartbeatAt: worker.lastHeartbeatAt.toISOString(),
        totalExecutions: worker._count.executions,
        recentHeartbeats: worker.heartbeats.map((h) => ({
          id: h.id,
          activeJobCount: h.activeJobCount,
          cpuLoad: h.cpuLoad,
          timestamp: h.timestamp.toISOString(),
        })),
        recentExecutions: worker.executions.map((e) => ({
          ...e,
          startedAt: e.startedAt.toISOString(),
          finishedAt: e.finishedAt?.toISOString() ?? null,
        })),
      });
    },
  );

  // ── GET /workers/:id/heartbeats ────────────────────────────────────────────
  fastify.get(
    '/workers/:id/heartbeats',
    {
      schema: {
        tags: ['Workers'],
        summary: 'Get last 20 heartbeats for a worker',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    workerId: { type: 'string' },
                    activeJobCount: { type: 'number' },
                    cpuLoad: { type: 'number', nullable: true },
                    timestamp: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const worker = await prisma.worker.findUnique({ where: { id }, select: { id: true } });
      if (!worker) throw new NotFoundError('Worker not found');

      const heartbeats = await prisma.workerHeartbeat.findMany({
        where: { workerId: id },
        orderBy: { timestamp: 'desc' },
        take: 20,
      });

      return reply.send({
        data: heartbeats.map((h) => ({
          id: h.id,
          workerId: h.workerId,
          activeJobCount: h.activeJobCount,
          cpuLoad: h.cpuLoad,
          timestamp: h.timestamp.toISOString(),
        })),
      });
    },
  );
}

export default workerRoutes;
