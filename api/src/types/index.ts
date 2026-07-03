// src/types/index.ts
import { OrgMemberRole } from '@prisma/client';
import '@fastify/jwt';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  type: 'access' | 'refresh';
  iat?: number;
  exp?: number;
  jti?: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

export interface PaginationQuery { page?: string; limit?: string; }
export interface PaginationMeta { page: number; limit: number; total: number; totalPages: number; }
export interface PaginatedResponse<T> { data: T[]; meta: PaginationMeta; }
export interface RegisterBody { email: string; password: string; orgName?: string; }
export interface LoginBody { email: string; password: string; }
export interface AuthResponse { user: { id: string; email: string; role: string; createdAt: string; }; accessToken: string; }
export interface CreateProjectBody { orgId: string; name: string; }
export interface CreateQueueBody { name: string; priority?: number; concurrencyLimit?: number; defaultRetryPolicyId?: string; }
export interface UpdateQueueBody { priority?: number; concurrencyLimit?: number; isPaused?: boolean; }
export interface QueueStats { totalJobs: number; byStatus: { queued: number; scheduled: number; claimed: number; running: number; completed: number; failed: number; dead_letter: number; cancelled: number; }; jobsPerMinute: number; }
export interface CreateJobBody { type: string; payload?: Record<string, unknown>; runAt?: string; cronExpression?: string; retryPolicyId?: string; idempotencyKey?: string; priority?: number; }
export interface BatchJobItem { type: string; payload?: Record<string, unknown>; runAt?: string; priority?: number; idempotencyKey?: string; }
export interface CreateBatchBody { jobs: BatchJobItem[]; }
export interface JobListQuery { queueId?: string; status?: string; type?: string; batchId?: string; page?: string; limit?: string; }
export interface WorkerListQuery { status?: string; page?: string; limit?: string; }
export interface JobTransitionEvent { jobId: string; queueId: string; projectId: string; status: string; timestamp: string; }
export interface WorkerHeartbeatEvent { workerId: string; status: string; activeJobCount: number; cpuLoad?: number; timestamp: string; }
export const ROLE_HIERARCHY: Record<OrgMemberRole, number> = { owner: 3, admin: 2, member: 1 };
