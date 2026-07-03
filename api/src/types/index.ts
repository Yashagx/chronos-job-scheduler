// src/types/index.ts
// Shared TypeScript types for route body/response shapes

import { OrgMemberRole } from '@prisma/client';

// ─── JWT Payload ──────────────────────────────────────────────────────────────

export interface JwtPayload {
  sub: string;        // userId
  email: string;
  role: string;
  type: 'access' | 'refresh';
  iat?: number;
  exp?: number;
}

// ─── Augment Fastify ──────────────────────────────────────────────────────────

declare module 'fastify' {
  interface FastifyRequest {
    user: JwtPayload;
  }
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PaginationQuery {
  page?: string;
  limit?: string;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: PaginationMeta;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export interface RegisterBody {
  email: string;
  password: string;
  orgName?: string;
}

export interface LoginBody {
  email: string;
  password: string;
}

export interface AuthResponse {
  user: {
    id: string;
    email: string;
    role: string;
    createdAt: string;
  };
  accessToken: string;
}

// ─── Projects ─────────────────────────────────────────────────────────────────

export interface CreateProjectBody {
  orgId: string;
  name: string;
}

// ─── Queues ───────────────────────────────────────────────────────────────────

export interface CreateQueueBody {
  name: string;
  priority?: number;
  concurrencyLimit?: number;
  defaultRetryPolicyId?: string;
}

export interface UpdateQueueBody {
  priority?: number;
  concurrencyLimit?: number;
  isPaused?: boolean;
}

export interface QueueStats {
  totalJobs: number;
  byStatus: {
    queued: number;
    scheduled: number;
    claimed: number;
    running: number;
    completed: number;
    failed: number;
    dead_letter: number;
    cancelled: number;
  };
  jobsPerMinute: number;
}

// ─── Jobs ─────────────────────────────────────────────────────────────────────

export interface CreateJobBody {
  type: string;
  payload?: Record<string, unknown>;
  runAt?: string;
  cronExpression?: string;
  retryPolicyId?: string;
  idempotencyKey?: string;
  priority?: number;
}

export interface BatchJobItem {
  type: string;
  payload?: Record<string, unknown>;
  runAt?: string;
  priority?: number;
  idempotencyKey?: string;
}

export interface CreateBatchBody {
  jobs: BatchJobItem[];
}

export interface JobListQuery {
  queueId?: string;
  status?: string;
  type?: string;
  batchId?: string;
  page?: string;
  limit?: string;
}

// ─── Workers ──────────────────────────────────────────────────────────────────

export interface WorkerListQuery {
  status?: string;
  page?: string;
  limit?: string;
}

// ─── Socket Events ────────────────────────────────────────────────────────────

export interface JobTransitionEvent {
  jobId: string;
  queueId: string;
  projectId: string;
  status: string;
  timestamp: string;
}

export interface WorkerHeartbeatEvent {
  workerId: string;
  status: string;
  activeJobCount: number;
  cpuLoad?: number;
  timestamp: string;
}

// ─── Role Hierarchy ───────────────────────────────────────────────────────────

export const ROLE_HIERARCHY: Record<OrgMemberRole, number> = {
  owner: 3,
  admin: 2,
  member: 1,
};
