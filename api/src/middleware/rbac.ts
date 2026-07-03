// src/middleware/rbac.ts
// RBAC preHandler factory using org_memberships.role.
// requireOrgMember(minRole) returns a preHandler that:
//  1. Reads orgId from route params (or query for flexibility)
//  2. Looks up membership for (orgId, request.user.sub)
//  3. Compares role against hierarchy — throws ForbiddenError if insufficient

import { FastifyRequest, FastifyReply } from 'fastify';
import { OrgMemberRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../lib/errors';
import { ROLE_HIERARCHY } from '../types';

type ParamsWithOrg = { orgId?: string; projectId?: string };

/**
 * Returns a Fastify preHandler that enforces a minimum OrgMemberRole.
 *
 * The orgId is resolved in this order:
 *  1. `params.orgId` (direct org routes)
 *  2. The project's orgId (project/queue/job routes via `params.projectId`)
 *  3. The queue's project's orgId (via `params.queueId`)
 */
export function requireOrgMember(minRole: OrgMemberRole) {
  return async function rbacPreHandler(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    if (!request.user) {
      throw new UnauthorizedError('Authentication required');
    }

    const userId = request.user.sub;
    const params = request.params as ParamsWithOrg & Record<string, string>;

    let orgId: string | undefined = params.orgId;

    // Resolve orgId from projectId
    if (!orgId && params.projectId) {
      const project = await prisma.project.findUnique({
        where: { id: params.projectId },
        select: { orgId: true },
      });
      if (!project) throw new NotFoundError('Project not found');
      orgId = project.orgId;
    }

    // Resolve orgId from queueId
    if (!orgId && params.queueId) {
      const queue = await prisma.queue.findUnique({
        where: { id: params.queueId },
        select: { project: { select: { orgId: true } } },
      });
      if (!queue) throw new NotFoundError('Queue not found');
      orgId = queue.project.orgId;
    }

    // Resolve orgId from jobId
    if (!orgId && params.id) {
      const job = await prisma.job.findUnique({
        where: { id: params.id },
        select: { queue: { select: { project: { select: { orgId: true } } } } },
      });
      if (job) {
        orgId = job.queue.project.orgId;
      }
    }

    if (!orgId) {
      throw new ForbiddenError('Cannot determine organization for this resource');
    }

    const membership = await prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId, userId } },
      select: { role: true },
    });

    if (!membership) {
      throw new ForbiddenError('You are not a member of this organization');
    }

    const userRoleLevel = ROLE_HIERARCHY[membership.role];
    const requiredLevel = ROLE_HIERARCHY[minRole];

    if (userRoleLevel < requiredLevel) {
      throw new ForbiddenError(
        `This action requires at least '${minRole}' role in the organization`,
      );
    }
  };
}

export default requireOrgMember;
