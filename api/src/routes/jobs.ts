// src/routes/jobs.ts
// Job management routes — submission, listing, retry, cancel.

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { requireAuth } from '../middleware/auth';
import { requireOrgMember } from '../middleware/rbac';
import { rateLimit, JOB_SUBMISSION_LIMIT } from '../middleware/rateLimit';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  BadRequestError,
} from '../lib/errors';
import { parsePagination, buildMeta } from '../lib/pagination';
import { JobStatus } from '@prisma/client';

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const createJobSchema = z.object({
  type: z.string().min(1).max(128),
  payload: z.record(z.string(), z.unknown()).optional().default({}),
  runAt: z.string().datetime().optional(),
  cronExpression: z.string().optional(),
  retryPolicyId: z.string().optional(),
  idempotencyKey: z.string().max(256).optional(),
  priority: z.number().int().min(0).max(100).optional(),
});

const batchJobSchema = z.object({
  type: z.string().min(1).max(128),
  payload: z.record(z.string(), z.unknown()).optional().default({}),
  runAt: z.string().datetime().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  idempotencyKey: z.string().max(256).optional(),
});

const createBatchSchema = z.object({
  jobs: z.array(batchJobSchema).min(1).max(500),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Basic cron expression validator.
 * Validates that the expression has 5 space-separated fields.
 */
function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5;
}

/**
 * Compute the next run time after `from` for a cron expression.
 * Uses a simple approximation (next minute boundary) — in production
 * you would use a cron parser library like `cron-parser`.
 */
function computeNextRunAt(cronExpression: string, from = new Date()): Date {
  // Simple: advance to next minute. Replace with cron-parser in production.
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);
  return next;
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export async function jobRoutes(fastify: FastifyInstance): Promise<void> {
  const jobRateLimit = rateLimit('job_submission', JOB_SUBMISSION_LIMIT);

  // ── POST /queues/:queueId/jobs ─────────────────────────────────────────────
  fastify.post(
    '/queues/:queueId/jobs',
    {
      schema: {
        tags: ['Jobs'],
        summary: 'Submit a job to a queue',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['queueId'],
          properties: { queueId: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['type'],
          properties: {
            type: { type: 'string' },
            payload: { type: 'object' },
            runAt: { type: 'string', format: 'date-time' },
            cronExpression: { type: 'string' },
            retryPolicyId: { type: 'string' },
            idempotencyKey: { type: 'string' },
            priority: { type: 'number' },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              type: { type: 'string' },
              status: { type: 'string' },
              queueId: { type: 'string' },
              priority: { type: 'number' },
              runAt: { type: 'string' },
              createdAt: { type: 'string' },
              scheduledJobId: { type: 'string', nullable: true },
            },
          },
        },
      },
      preHandler: [requireAuth, requireOrgMember('member'), jobRateLimit],
    },
    async (request, reply) => {
      const { queueId } = request.params as { queueId: string };

      const parsed = createJobSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid request body', parsed.error.flatten());
      }

      const queue = await prisma.queue.findUnique({ where: { id: queueId } });
      if (!queue) throw new NotFoundError('Queue not found');

      const {
        type,
        payload,
        runAt,
        cronExpression,
        retryPolicyId,
        idempotencyKey,
        priority,
      } = parsed.data;

      // Idempotency check
      if (idempotencyKey) {
        const existing = await prisma.job.findFirst({
          where: { queueId, idempotencyKey },
        });
        if (existing) {
          throw new ConflictError(
            `A job with idempotency_key '${idempotencyKey}' already exists in this queue`,
            { existingJobId: existing.id },
          );
        }
      }

      // ── Cron job: create ScheduledJob definition ───────────────────────────
      if (cronExpression) {
        if (!isValidCron(cronExpression)) {
          throw new ValidationError('Invalid cron expression — must have 5 fields');
        }

        const nextRunAt = computeNextRunAt(cronExpression);

        const scheduledJob = await prisma.scheduledJob.create({
          data: {
            projectId: queue.projectId,
            cronExpression,
            queueId,
            jobTemplate: { type, payload: (payload ?? {}) as never, retryPolicyId, priority: priority ?? 0 },
            nextRunAt,
          },
        });

        await redis.publish(
          'job:transitions',
          JSON.stringify({
            scheduledJobId: scheduledJob.id,
            queueId,
            projectId: queue.projectId,
            type: 'scheduled_job:created',
            cronExpression,
            nextRunAt: nextRunAt.toISOString(),
            timestamp: new Date().toISOString(),
          }),
        );

        return reply.code(201).send({
          id: scheduledJob.id,
          type: 'scheduled',
          status: 'scheduled',
          queueId,
          priority: priority ?? 0,
          runAt: nextRunAt.toISOString(),
          createdAt: scheduledJob.createdAt.toISOString(),
          scheduledJobId: scheduledJob.id,
        });
      }

      // ── One-shot job ───────────────────────────────────────────────────────
      const resolvedRunAt = runAt ? new Date(runAt) : new Date();
      const isScheduled = resolvedRunAt > new Date();
      const status: JobStatus = isScheduled ? 'scheduled' : 'queued';

      const job = await prisma.job.create({
        data: {
          queueId,
          type,
          payload: (payload ?? {}) as never,
          status,
          priority: priority ?? 0,
          runAt: resolvedRunAt,
          retryPolicyId: retryPolicyId ?? queue.defaultRetryPolicyId,
          idempotencyKey,
        },
      });

      // Publish creation event
      await redis.publish(
        'job:transitions',
        JSON.stringify({
          jobId: job.id,
          queueId,
          projectId: queue.projectId,
          status: job.status,
          timestamp: new Date().toISOString(),
        }),
      );

      return reply.code(201).send({
        id: job.id,
        type: job.type,
        status: job.status,
        queueId: job.queueId,
        priority: job.priority,
        runAt: job.runAt.toISOString(),
        createdAt: job.createdAt.toISOString(),
        scheduledJobId: null,
      });
    },
  );

  // ── POST /queues/:queueId/jobs/batch ───────────────────────────────────────
  fastify.post(
    '/queues/:queueId/jobs/batch',
    {
      schema: {
        tags: ['Jobs'],
        summary: 'Submit a batch of jobs to a queue',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['queueId'],
          properties: { queueId: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['jobs'],
          properties: {
            jobs: {
              type: 'array',
              items: {
                type: 'object',
                required: ['type'],
                properties: {
                  type: { type: 'string' },
                  payload: { type: 'object' },
                  runAt: { type: 'string', format: 'date-time' },
                  priority: { type: 'number' },
                  idempotencyKey: { type: 'string' },
                },
              },
            },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              batchId: { type: 'string' },
              jobs: { type: 'array', items: { type: 'object' } },
              count: { type: 'number' },
            },
          },
        },
      },
      preHandler: [requireAuth, requireOrgMember('member'), jobRateLimit],
    },
    async (request, reply) => {
      const { queueId } = request.params as { queueId: string };

      const parsed = createBatchSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid request body', parsed.error.flatten());
      }

      const queue = await prisma.queue.findUnique({ where: { id: queueId } });
      if (!queue) throw new NotFoundError('Queue not found');

      const batchId = nanoid();
      const now = new Date();

      // Check for idempotency key conflicts in batch
      const keysInBatch = parsed.data.jobs
        .map((j) => j.idempotencyKey)
        .filter((k): k is string => !!k);

      if (keysInBatch.length > 0) {
        const conflicts = await prisma.job.findMany({
          where: { queueId, idempotencyKey: { in: keysInBatch } },
          select: { idempotencyKey: true, id: true },
        });
        if (conflicts.length > 0) {
          throw new ConflictError('Some jobs have duplicate idempotency keys', {
            conflicts: conflicts.map((c) => ({ key: c.idempotencyKey, existingId: c.id })),
          });
        }
      }

      const jobData = parsed.data.jobs.map((j) => {
        const resolvedRunAt = j.runAt ? new Date(j.runAt) : now;
        const status: JobStatus = resolvedRunAt > now ? 'scheduled' : 'queued';
        return {
          queueId,
          type: j.type,
          payload: (j.payload ?? {}) as never,
          status,
          priority: j.priority ?? 0,
          runAt: resolvedRunAt,
          batchId,
          retryPolicyId: queue.defaultRetryPolicyId,
          idempotencyKey: j.idempotencyKey,
        };
      });

      // createMany doesn't return records in Prisma — use transaction
      const jobs = await prisma.$transaction(
        jobData.map((data) => prisma.job.create({ data })),
      );

      // Publish batch created event
      await redis.publish(
        'job:transitions',
        JSON.stringify({
          batchId,
          queueId,
          projectId: queue.projectId,
          type: 'batch:created',
          count: jobs.length,
          timestamp: new Date().toISOString(),
        }),
      );

      return reply.code(201).send({
        batchId,
        count: jobs.length,
        jobs: jobs.map((j) => ({
          id: j.id,
          type: j.type,
          status: j.status,
          priority: j.priority,
          runAt: j.runAt.toISOString(),
          idempotencyKey: j.idempotencyKey,
          createdAt: j.createdAt.toISOString(),
        })),
      });
    },
  );

  // ── GET /jobs ──────────────────────────────────────────────────────────────
  fastify.get(
    '/jobs',
    {
      schema: {
        tags: ['Jobs'],
        summary: 'List jobs with optional filters',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            queueId: { type: 'string' },
            status: { type: 'string' },
            type: { type: 'string' },
            batchId: { type: 'string' },
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
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const q = request.query as {
        queueId?: string;
        status?: string;
        type?: string;
        batchId?: string;
        page?: string;
        limit?: string;
      };

      const { page, limit, skip } = parsePagination(q);

      // Scope to queues accessible by the user
      const memberships = await prisma.orgMembership.findMany({
        where: { userId: request.user.sub },
        select: { orgId: true },
      });
      const orgIds = memberships.map((m) => m.orgId);

      const where: any = {
        queue: { project: { orgId: { in: orgIds } } },
        ...(q.queueId && { queueId: q.queueId }),
        ...(q.status && { status: q.status as JobStatus }),
        ...(q.type && { type: q.type }),
        ...(q.batchId && { batchId: q.batchId }),
      };

      const [jobs, total] = await Promise.all([
        prisma.job.findMany({
          where,
          skip,
          take: limit,
          orderBy: [{ priority: 'desc' }, { runAt: 'asc' }, { createdAt: 'desc' }],
          include: {
            queue: { select: { name: true, projectId: true } },
            _count: { select: { executions: true } },
          },
        }),
        prisma.job.count({ where }),
      ]);

      return reply.send({
        data: jobs.map((j) => ({
          id: j.id,
          queueId: j.queueId,
          queueName: j.queue.name,
          projectId: j.queue.projectId,
          type: j.type,
          status: j.status,
          priority: j.priority,
          runAt: j.runAt.toISOString(),
          batchId: j.batchId,
          attemptCount: j.attemptCount,
          idempotencyKey: j.idempotencyKey,
          createdAt: j.createdAt.toISOString(),
          updatedAt: j.updatedAt.toISOString(),
          executionCount: j._count.executions,
        })),
        meta: buildMeta(total, page, limit),
      });
    },
  );

  // ── GET /jobs/:id ──────────────────────────────────────────────────────────
  fastify.get(
    '/jobs/:id',
    {
      schema: {
        tags: ['Jobs'],
        summary: 'Get full job detail with latest execution',
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

      const job = await prisma.job.findUnique({
        where: { id },
        include: {
          queue: {
            select: {
              name: true,
              projectId: true,
              project: { select: { orgId: true } },
            },
          },
          retryPolicy: true,
          executions: {
            orderBy: { attemptNumber: 'desc' },
            take: 1,
            include: {
              logs: {
                orderBy: { timestamp: 'asc' },
                take: 50,
              },
            },
          },
          deadLetter: true,
        },
      });

      if (!job) throw new NotFoundError('Job not found');

      // Verify access
      const membership = await prisma.orgMembership.findUnique({
        where: {
          orgId_userId: {
            orgId: job.queue.project.orgId,
            userId: request.user.sub,
          },
        },
      });
      if (!membership) throw new NotFoundError('Job not found');

      return reply.send({
        id: job.id,
        queueId: job.queueId,
        queueName: job.queue.name,
        projectId: job.queue.projectId,
        type: job.type,
        payload: job.payload,
        status: job.status,
        priority: job.priority,
        runAt: job.runAt.toISOString(),
        cronExpression: job.cronExpression,
        batchId: job.batchId,
        attemptCount: job.attemptCount,
        retryPolicyId: job.retryPolicyId,
        retryPolicy: job.retryPolicy,
        idempotencyKey: job.idempotencyKey,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
        latestExecution: job.executions[0] ?? null,
        deadLetter: job.deadLetter ?? null,
      });
    },
  );

  // ── GET /jobs/:id/executions ───────────────────────────────────────────────
  fastify.get(
    '/jobs/:id/executions',
    {
      schema: {
        tags: ['Jobs'],
        summary: 'Get all execution attempts for a job',
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
              data: { type: 'array', items: { type: 'object' } },
              meta: { type: 'object' },
            },
          },
        },
      },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const job = await prisma.job.findUnique({
        where: { id },
        select: {
          queue: { select: { project: { select: { orgId: true } } } },
        },
      });
      if (!job) throw new NotFoundError('Job not found');

      const membership = await prisma.orgMembership.findUnique({
        where: {
          orgId_userId: { orgId: job.queue.project.orgId, userId: request.user.sub },
        },
      });
      if (!membership) throw new NotFoundError('Job not found');

      const { page, limit, skip } = parsePagination(request.query as Record<string, string>);

      const [executions, total] = await Promise.all([
        prisma.jobExecution.findMany({
          where: { jobId: id },
          skip,
          take: limit,
          orderBy: { attemptNumber: 'desc' },
          include: {
            worker: { select: { id: true, hostname: true, pid: true } },
            logs: { orderBy: { timestamp: 'asc' }, take: 100 },
          },
        }),
        prisma.jobExecution.count({ where: { jobId: id } }),
      ]);

      return reply.send({
        data: executions.map((e) => ({
          id: e.id,
          jobId: e.jobId,
          attemptNumber: e.attemptNumber,
          status: e.status,
          workerId: e.workerId,
          worker: e.worker,
          startedAt: e.startedAt.toISOString(),
          finishedAt: e.finishedAt?.toISOString() ?? null,
          durationMs: e.durationMs,
          errorMessage: e.errorMessage,
          logs: e.logs.map((l) => ({
            id: l.id,
            level: l.level,
            message: l.message,
            timestamp: l.timestamp.toISOString(),
          })),
        })),
        meta: buildMeta(total, page, limit),
      });
    },
  );

  // ── GET /jobs/:id/logs ─────────────────────────────────────────────────────
  fastify.get(
    '/jobs/:id/logs',
    {
      schema: {
        tags: ['Jobs'],
        summary: 'Get all logs across all executions for a job',
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
              data: { type: 'array', items: { type: 'object' } },
              meta: { type: 'object' },
            },
          },
        },
      },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const job = await prisma.job.findUnique({
        where: { id },
        select: {
          queue: { select: { project: { select: { orgId: true } } } },
        },
      });
      if (!job) throw new NotFoundError('Job not found');

      const membership = await prisma.orgMembership.findUnique({
        where: {
          orgId_userId: { orgId: job.queue.project.orgId, userId: request.user.sub },
        },
      });
      if (!membership) throw new NotFoundError('Job not found');

      const { page, limit, skip } = parsePagination(request.query as Record<string, string>);

      const executionIds = await prisma.jobExecution.findMany({
        where: { jobId: id },
        select: { id: true },
      });

      const ids = executionIds.map((e) => e.id);

      const [logs, total] = await Promise.all([
        prisma.jobLog.findMany({
          where: { executionId: { in: ids } },
          skip,
          take: limit,
          orderBy: { timestamp: 'asc' },
          include: {
            execution: { select: { attemptNumber: true, workerId: true } },
          },
        }),
        prisma.jobLog.count({ where: { executionId: { in: ids } } }),
      ]);

      return reply.send({
        data: logs.map((l) => ({
          id: l.id,
          executionId: l.executionId,
          attemptNumber: l.execution.attemptNumber,
          workerId: l.execution.workerId,
          level: l.level,
          message: l.message,
          timestamp: l.timestamp.toISOString(),
        })),
        meta: buildMeta(total, page, limit),
      });
    },
  );

  // ── POST /jobs/:id/retry ───────────────────────────────────────────────────
  fastify.post(
    '/jobs/:id/retry',
    {
      schema: {
        tags: ['Jobs'],
        summary: 'Re-queue a failed or dead_letter job',
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
      preHandler: [requireAuth, requireOrgMember('member')],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const job = await prisma.job.findUnique({
        where: { id },
        include: {
          queue: { select: { project: { select: { orgId: true, id: true } }, id: true } },
          deadLetter: true,
        },
      });

      if (!job) throw new NotFoundError('Job not found');

      if (!['failed', 'dead_letter', 'cancelled'].includes(job.status)) {
        throw new ValidationError(
          `Cannot retry a job with status '${job.status}' — only failed, dead_letter, or cancelled jobs can be retried`,
        );
      }

      // Transactionally reset job + remove from DLQ if present
      const updated = await prisma.$transaction(async (tx) => {
        if (job.deadLetter) {
          await tx.deadLetterJob.delete({ where: { originalJobId: id } });
        }

        return tx.job.update({
          where: { id },
          data: {
            status: 'queued',
            runAt: new Date(),
            attemptCount: 0,
          },
        });
      });

      await redis.publish(
        'job:transitions',
        JSON.stringify({
          jobId: id,
          queueId: job.queueId,
          projectId: job.queue.project.id,
          status: 'queued',
          type: 'job:retried',
          timestamp: new Date().toISOString(),
        }),
      );

      return reply.send({
        id: updated.id,
        status: updated.status,
        runAt: updated.runAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      });
    },
  );

  // ── POST /jobs/:id/cancel ──────────────────────────────────────────────────
  fastify.post(
    '/jobs/:id/cancel',
    {
      schema: {
        tags: ['Jobs'],
        summary: 'Cancel a queued or scheduled job',
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
      preHandler: [requireAuth, requireOrgMember('member')],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const job = await prisma.job.findUnique({
        where: { id },
        include: {
          queue: { select: { project: { select: { orgId: true, id: true } } } },
        },
      });
      if (!job) throw new NotFoundError('Job not found');

      if (!['queued', 'scheduled'].includes(job.status)) {
        throw new ValidationError(
          `Cannot cancel a job with status '${job.status}' — only queued or scheduled jobs can be cancelled`,
        );
      }

      const updated = await prisma.job.update({
        where: { id },
        data: { status: 'cancelled' },
      });

      await redis.publish(
        'job:transitions',
        JSON.stringify({
          jobId: id,
          queueId: job.queueId,
          projectId: job.queue.project.id,
          status: 'cancelled',
          type: 'job:cancelled',
          timestamp: new Date().toISOString(),
        }),
      );

      return reply.send({
        id: updated.id,
        status: updated.status,
        updatedAt: updated.updatedAt.toISOString(),
      });
    },
  );
}

export default jobRoutes;

