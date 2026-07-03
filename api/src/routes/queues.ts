// src/routes/queues.ts
// Queue management routes.
// Create/update operations require admin role; reads require membership.

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { requireOrgMember } from '../middleware/rbac';
import { NotFoundError, ValidationError } from '../lib/errors';
import { parsePagination, buildMeta } from '../lib/pagination';

const createQueueSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[a-z0-9_-]+$/i, 'Queue name must be alphanumeric with dashes/underscores'),
  priority: z.number().int().min(0).max(100).optional(),
  concurrencyLimit: z.number().int().min(1).max(1000).optional(),
  defaultRetryPolicyId: z.string().optional(),
});

const updateQueueSchema = z.object({
  priority: z.number().int().min(0).max(100).optional(),
  concurrencyLimit: z.number().int().min(1).max(1000).optional(),
  isPaused: z.boolean().optional(),
});

export async function queueRoutes(fastify: FastifyInstance): Promise<void> {

  // ── POST /projects/:projectId/queues ───────────────────────────────────────
  fastify.post(
    '/projects/:projectId/queues',
    {
      schema: {
        tags: ['Queues'],
        summary: 'Create a queue in a project (requires admin role)',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['projectId'],
          properties: { projectId: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            priority: { type: 'number' },
            concurrencyLimit: { type: 'number' },
            defaultRetryPolicyId: { type: 'string' },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              projectId: { type: 'string' },
              name: { type: 'string' },
              priority: { type: 'number' },
              concurrencyLimit: { type: 'number' },
              isPaused: { type: 'boolean' },
              defaultRetryPolicyId: { type: 'string', nullable: true },
              createdAt: { type: 'string' },
            },
          },
        },
      },
      preHandler: [requireAuth, requireOrgMember('admin')],
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };

      const parsed = createQueueSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid request body', parsed.error.flatten());
      }

      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project) throw new NotFoundError('Project not found');

      const queue = await prisma.queue.create({
        data: {
          projectId,
          name: parsed.data.name,
          priority: parsed.data.priority ?? 0,
          concurrencyLimit: parsed.data.concurrencyLimit ?? 10,
          defaultRetryPolicyId: parsed.data.defaultRetryPolicyId,
        },
      });

      return reply.code(201).send({
        id: queue.id,
        projectId: queue.projectId,
        name: queue.name,
        priority: queue.priority,
        concurrencyLimit: queue.concurrencyLimit,
        isPaused: queue.isPaused,
        defaultRetryPolicyId: queue.defaultRetryPolicyId,
        createdAt: queue.createdAt.toISOString(),
      });
    },
  );

  // ── GET /projects/:projectId/queues ────────────────────────────────────────
  fastify.get(
    '/projects/:projectId/queues',
    {
      schema: {
        tags: ['Queues'],
        summary: 'List queues in a project with job counts per status',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['projectId'],
          properties: { projectId: { type: 'string' } },
        },
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'string' },
            limit: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: { type: 'array', items: { type: 'object' } },
              meta: { type: 'object' },
            },
          },
        },
      },
      preHandler: [requireAuth, requireOrgMember('member')],
    },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const { page, limit, skip } = parsePagination(request.query as Record<string, string>);

      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project) throw new NotFoundError('Project not found');

      const [queues, total] = await Promise.all([
        prisma.queue.findMany({
          where: { projectId },
          skip,
          take: limit,
          orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
          include: {
            _count: { select: { jobs: true } },
          },
        }),
        prisma.queue.count({ where: { projectId } }),
      ]);

      // Get job counts by status for each queue
      const queueIds = queues.map((q) => q.id);
      const jobStatusCounts = await prisma.job.groupBy({
        by: ['queueId', 'status'],
        where: { queueId: { in: queueIds } },
        _count: { id: true },
      });

      const statusCountMap = new Map<string, Record<string, number>>();
      for (const row of jobStatusCounts) {
        if (!statusCountMap.has(row.queueId)) {
          statusCountMap.set(row.queueId, {});
        }
        statusCountMap.get(row.queueId)![row.status] = row._count.id;
      }

      return reply.send({
        data: queues.map((q) => ({
          id: q.id,
          projectId: q.projectId,
          name: q.name,
          priority: q.priority,
          concurrencyLimit: q.concurrencyLimit,
          isPaused: q.isPaused,
          defaultRetryPolicyId: q.defaultRetryPolicyId,
          createdAt: q.createdAt.toISOString(),
          totalJobs: q._count.jobs,
          jobsByStatus: statusCountMap.get(q.id) ?? {},
        })),
        meta: buildMeta(total, page, limit),
      });
    },
  );

  // ── PATCH /queues/:id ──────────────────────────────────────────────────────
  fastify.patch(
    '/queues/:id',
    {
      schema: {
        tags: ['Queues'],
        summary: 'Update a queue (requires admin role)',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        body: {
          type: 'object',
          properties: {
            priority: { type: 'number' },
            concurrencyLimit: { type: 'number' },
            isPaused: { type: 'boolean' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              projectId: { type: 'string' },
              name: { type: 'string' },
              priority: { type: 'number' },
              concurrencyLimit: { type: 'number' },
              isPaused: { type: 'boolean' },
              updatedAt: { type: 'string' },
            },
          },
        },
      },
      preHandler: [requireAuth, requireOrgMember('admin')],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const parsed = updateQueueSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid request body', parsed.error.flatten());
      }

      const queue = await prisma.queue.findUnique({ where: { id } });
      if (!queue) throw new NotFoundError('Queue not found');

      const updated = await prisma.queue.update({
        where: { id },
        data: {
          ...(parsed.data.priority !== undefined && { priority: parsed.data.priority }),
          ...(parsed.data.concurrencyLimit !== undefined && { concurrencyLimit: parsed.data.concurrencyLimit }),
          ...(parsed.data.isPaused !== undefined && { isPaused: parsed.data.isPaused }),
        },
      });

      return reply.send({
        id: updated.id,
        projectId: updated.projectId,
        name: updated.name,
        priority: updated.priority,
        concurrencyLimit: updated.concurrencyLimit,
        isPaused: updated.isPaused,
        updatedAt: new Date().toISOString(),
      });
    },
  );

  // ── GET /queues/:id/stats ──────────────────────────────────────────────────
  fastify.get(
    '/queues/:id/stats',
    {
      schema: {
        tags: ['Queues'],
        summary: 'Get queue statistics including job counts by status and throughput',
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
              totalJobs: { type: 'number' },
              byStatus: { type: 'object' },
              jobsPerMinute: { type: 'number' },
            },
          },
        },
      },
      preHandler: [requireAuth, requireOrgMember('member')],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const queue = await prisma.queue.findUnique({ where: { id } });
      if (!queue) throw new NotFoundError('Queue not found');

      // Count jobs by status
      const statusGroups = await prisma.job.groupBy({
        by: ['status'],
        where: { queueId: id },
        _count: { id: true },
      });

      const byStatus: Record<string, number> = {
        queued: 0,
        scheduled: 0,
        claimed: 0,
        running: 0,
        completed: 0,
        failed: 0,
        dead_letter: 0,
        cancelled: 0,
      };

      let totalJobs = 0;
      for (const group of statusGroups) {
        byStatus[group.status] = group._count.id;
        totalJobs += group._count.id;
      }

      // Jobs completed/failed in last 5 minutes → jobs per minute
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
      const recentCount = await prisma.job.count({
        where: {
          queueId: id,
          status: { in: ['completed', 'failed'] },
          updatedAt: { gte: fiveMinAgo },
        },
      });
      const jobsPerMinute = Math.round((recentCount / 5) * 10) / 10;

      return reply.send({ totalJobs, byStatus, jobsPerMinute });
    },
  );
}

export default queueRoutes;
