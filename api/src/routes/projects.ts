// src/routes/projects.ts
// Project management routes — all require authentication.

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { requireOrgMember } from '../middleware/rbac';
import { NotFoundError, ValidationError } from '../lib/errors';
import { parsePagination, buildMeta } from '../lib/pagination';

const createProjectSchema = z.object({
  orgId: z.string().min(1),
  name: z.string().min(1).max(128),
});

export async function projectRoutes(fastify: FastifyInstance): Promise<void> {

  // ── POST /projects ─────────────────────────────────────────────────────────
  fastify.post(
    '/projects',
    {
      schema: {
        tags: ['Projects'],
        summary: 'Create a new project',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['orgId', 'name'],
          properties: {
            orgId: { type: 'string' },
            name: { type: 'string' },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              orgId: { type: 'string' },
              name: { type: 'string' },
              apiKey: { type: 'string' },
              createdAt: { type: 'string' },
            },
          },
        },
      },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const parsed = createProjectSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid request body', parsed.error.flatten());
      }

      const { orgId, name } = parsed.data;

      // Verify user is a member of the org
      const membership = await prisma.orgMembership.findUnique({
        where: { orgId_userId: { orgId, userId: request.user.sub } },
      });
      if (!membership) {
        throw new NotFoundError('Organization not found or you are not a member');
      }

      const project = await prisma.project.create({
        data: { orgId, name },
      });

      return reply.code(201).send({
        id: project.id,
        orgId: project.orgId,
        name: project.name,
        apiKey: project.apiKey,
        createdAt: project.createdAt.toISOString(),
      });
    },
  );

  // ── GET /projects ──────────────────────────────────────────────────────────
  fastify.get(
    '/projects',
    {
      schema: {
        tags: ['Projects'],
        summary: 'List projects for the authenticated user',
        security: [{ bearerAuth: [] }],
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
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    orgId: { type: 'string' },
                    name: { type: 'string' },
                    createdAt: { type: 'string' },
                    _count: {
                      type: 'object',
                      properties: { queues: { type: 'number' } },
                    },
                  },
                },
              },
              meta: {
                type: 'object',
                properties: {
                  page: { type: 'number' },
                  limit: { type: 'number' },
                  total: { type: 'number' },
                  totalPages: { type: 'number' },
                },
              },
            },
          },
        },
      },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const { page, limit, skip } = parsePagination(
        request.query as Record<string, string>,
      );

      // Find all orgs where user is a member
      const memberships = await prisma.orgMembership.findMany({
        where: { userId: request.user.sub },
        select: { orgId: true },
      });
      const orgIds = memberships.map((m) => m.orgId);

      const [projects, total] = await Promise.all([
        prisma.project.findMany({
          where: { orgId: { in: orgIds } },
          include: { _count: { select: { queues: true } } },
          skip,
          take: limit,
          orderBy: { createdAt: 'desc' },
        }),
        prisma.project.count({ where: { orgId: { in: orgIds } } }),
      ]);

      return reply.send({
        data: projects.map((p) => ({
          id: p.id,
          orgId: p.orgId,
          name: p.name,
          createdAt: p.createdAt.toISOString(),
          _count: p._count,
        })),
        meta: buildMeta(total, page, limit),
      });
    },
  );

  // ── GET /projects/:id ──────────────────────────────────────────────────────
  fastify.get(
    '/projects/:id',
    {
      schema: {
        tags: ['Projects'],
        summary: 'Get project details with queue count',
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
              id: { type: 'string' },
              orgId: { type: 'string' },
              name: { type: 'string' },
              apiKey: { type: 'string' },
              createdAt: { type: 'string' },
              queues: { type: 'array', items: { type: 'object' } },
              _count: { type: 'object' },
            },
          },
        },
      },
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const project = await prisma.project.findUnique({
        where: { id },
        include: {
          queues: {
            select: {
              id: true,
              name: true,
              priority: true,
              concurrencyLimit: true,
              isPaused: true,
              createdAt: true,
              _count: { select: { jobs: true } },
            },
            orderBy: { createdAt: 'desc' },
          },
          _count: { select: { queues: true, retryPolicies: true } },
        },
      });

      if (!project) throw new NotFoundError('Project not found');

      // Verify user has access
      const membership = await prisma.orgMembership.findUnique({
        where: { orgId_userId: { orgId: project.orgId, userId: request.user.sub } },
      });
      if (!membership) throw new NotFoundError('Project not found');

      return reply.send({
        id: project.id,
        orgId: project.orgId,
        name: project.name,
        apiKey: project.apiKey,
        createdAt: project.createdAt.toISOString(),
        queues: project.queues.map((q) => ({
          ...q,
          createdAt: q.createdAt.toISOString(),
        })),
        _count: project._count,
      });
    },
  );
}

export default projectRoutes;
