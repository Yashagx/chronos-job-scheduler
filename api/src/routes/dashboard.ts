// src/routes/dashboard.ts
// Aggregate stats endpoint for the dashboard.

import { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';

export async function dashboardRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /dashboard/summary
  fastify.get(
    '/dashboard/summary',
    {
      schema: {
        tags: ['Dashboard'],
        summary: 'Aggregate stats for the authenticated user\'s resources',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              totalQueues: { type: 'number' },
              activeWorkers: { type: 'number' },
              totalWorkers: { type: 'number' },
              failedJobs: { type: 'number' },
              queuedJobs: { type: 'number' },
              runningJobs: { type: 'number' },
              completedJobsToday: { type: 'number' },
              jobsPerMinute: { type: 'number' },
            },
          },
        },
      },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const memberships = await prisma.orgMembership.findMany({
        where: { userId: request.user.sub },
        select: { orgId: true },
      });
      const orgIds = memberships.map((m) => m.orgId);

      const projects = await prisma.project.findMany({
        where: { orgId: { in: orgIds } },
        select: { id: true },
      });
      const projectIds = projects.map((p) => p.id);

      const queues = await prisma.queue.findMany({
        where: { projectId: { in: projectIds } },
        select: { id: true },
      });
      const queueIds = queues.map((q) => q.id);

      const [
        totalQueues,
        activeWorkers,
        totalWorkers,
        failedJobs,
        queuedJobs,
        runningJobs,
        completedJobsToday,
        recentCompleted,
      ] = await Promise.all([
        prisma.queue.count({ where: { projectId: { in: projectIds } } }),
        prisma.worker.count({ where: { status: 'active' } }),
        prisma.worker.count({}),
        prisma.job.count({ where: { queueId: { in: queueIds }, status: { in: ['failed', 'dead_letter'] } } }),
        prisma.job.count({ where: { queueId: { in: queueIds }, status: 'queued' } }),
        prisma.job.count({ where: { queueId: { in: queueIds }, status: { in: ['claimed', 'running'] } } }),
        prisma.job.count({
          where: {
            queueId: { in: queueIds },
            status: 'completed',
            updatedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
          },
        }),
        prisma.job.count({
          where: {
            queueId: { in: queueIds },
            status: { in: ['completed', 'failed'] },
            updatedAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
          },
        }),
      ]);

      return reply.send({
        totalQueues,
        activeWorkers,
        totalWorkers,
        failedJobs,
        queuedJobs,
        runningJobs,
        completedJobsToday,
        jobsPerMinute: Math.round((recentCompleted / 5) * 10) / 10,
      });
    },
  );
}

export default dashboardRoutes;
