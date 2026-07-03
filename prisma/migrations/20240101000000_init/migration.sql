-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('member', 'admin', 'superadmin');

-- CreateEnum
CREATE TYPE "OrgMemberRole" AS ENUM ('owner', 'admin', 'member');

-- CreateEnum
CREATE TYPE "RetryStrategy" AS ENUM ('fixed', 'linear', 'exponential');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('queued', 'claimed', 'running', 'completed', 'failed', 'dead_letter', 'cancelled', 'scheduled');

-- CreateEnum
CREATE TYPE "WorkerStatus" AS ENUM ('active', 'draining', 'dead');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'member',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "name" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_memberships" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "org_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "OrgMemberRole" NOT NULL DEFAULT 'member',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "api_key" TEXT NOT NULL DEFAULT concat('chron_', gen_random_uuid()::text),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retry_policies" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'default',
    "strategy" "RetryStrategy" NOT NULL DEFAULT 'exponential',
    "base_delay_ms" INTEGER NOT NULL DEFAULT 1000,
    "max_delay_ms" INTEGER NOT NULL DEFAULT 30000,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retry_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queues" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "concurrency_limit" INTEGER NOT NULL DEFAULT 10,
    "is_paused" BOOLEAN NOT NULL DEFAULT false,
    "default_retry_policy_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "queues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "queue_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "batch_id" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "retry_policy_id" TEXT,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_executions" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "job_id" TEXT NOT NULL,
    "worker_id" TEXT NOT NULL,
    "attempt_number" INTEGER NOT NULL DEFAULT 1,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "error_message" TEXT,
    "duration_ms" INTEGER,

    CONSTRAINT "job_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_logs" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "execution_id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,

    CONSTRAINT "job_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workers" (
    "id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "pid" INTEGER NOT NULL,
    "status" "WorkerStatus" NOT NULL DEFAULT 'active',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_heartbeats" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "worker_id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "active_job_count" INTEGER NOT NULL DEFAULT 0,
    "cpu_load" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_jobs" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "project_id" TEXT NOT NULL,
    "queue_id" TEXT NOT NULL,
    "cron_expression" TEXT NOT NULL,
    "job_template" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMP(3),
    "next_run_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dead_letter_jobs" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "original_job_id" TEXT NOT NULL,
    "queue_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "failure_reason" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL,
    "moved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dead_letter_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "org_memberships_org_id_user_id_key" ON "org_memberships"("org_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_api_key_key" ON "projects"("api_key");

-- CreateIndex
CREATE UNIQUE INDEX "queues_project_id_name_key" ON "queues"("project_id", "name");

-- CreateIndex -- Critical: this index makes the SKIP LOCKED claim query O(log n)
CREATE INDEX "jobs_claim_idx" ON "jobs"("queue_id", "status", "run_at");

-- CreateIndex
CREATE INDEX "jobs_batch_id_idx" ON "jobs"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_queue_id_idempotency_key_key" ON "jobs"("queue_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "job_executions_job_id_idx" ON "job_executions"("job_id");

-- CreateIndex
CREATE INDEX "job_logs_execution_id_idx" ON "job_logs"("execution_id");

-- CreateIndex
CREATE INDEX "worker_heartbeats_worker_id_timestamp_idx" ON "worker_heartbeats"("worker_id", "timestamp");

-- CreateIndex
CREATE INDEX "scheduled_jobs_next_run_at_idx" ON "scheduled_jobs"("is_active", "next_run_at");

-- CreateIndex
CREATE UNIQUE INDEX "dead_letter_jobs_original_job_id_key" ON "dead_letter_jobs"("original_job_id");

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retry_policies" ADD CONSTRAINT "retry_policies_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queues" ADD CONSTRAINT "queues_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queues" ADD CONSTRAINT "queues_default_retry_policy_id_fkey" FOREIGN KEY ("default_retry_policy_id") REFERENCES "retry_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_retry_policy_id_fkey" FOREIGN KEY ("retry_policy_id") REFERENCES "retry_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_logs" ADD CONSTRAINT "job_logs_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "job_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_heartbeats" ADD CONSTRAINT "worker_heartbeats_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_queue_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dead_letter_jobs" ADD CONSTRAINT "dead_letter_jobs_original_job_id_fkey" FOREIGN KEY ("original_job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
