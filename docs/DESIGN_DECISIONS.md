# Chronos — Architectural Design Decisions

This document serves as a running log of the core engineering decisions made during the construction of Chronos.

## 1. Database & Schema Design

### `scheduled_jobs` is a separate table from `jobs`
The `scheduled_jobs` table holds cron *definitions* (the schedule and a template of the job). The `jobs` table holds the actual, runnable instances.
**Rationale:** Mixing them into a single table would pollute the claim index with non-claimable rows (cron definitions shouldn't be claimed directly) and require nullable columns for non-recurring fields. Separating them keeps the `jobs` table purely for ephemeral execution state, while `scheduled_jobs` remains a permanent configuration.

### The Claim Index: `(queue_id, status, run_at)`
The index used by the worker polling query is structured precisely in this order.
**Rationale:** The `queue_id` and `status` are exact-match equality filters (high selectivity). The database can quickly narrow down to just the 'queued' jobs for a specific queue, and then use the remaining part of the index (`run_at`) for a fast range-scan and ordered retrieval. This ensures the claim query is a rapid index-only scan, even if there are millions of rows.

### JSONB for `payload` and `job_template`
Job payloads are stored as `JSONB` rather than using a rigid relational schema or EAV (Entity-Attribute-Value) anti-pattern.
**Rationale:** A generic job scheduling platform must support heterogeneous job types (e.g., sending emails, resizing images, HTTP requests). Enforcing a relational schema would be overly restrictive. JSONB allows structural flexibility while still permitting GIN indexing if filtering by payload contents becomes necessary in the future.

### Cascade Choices and Audit Trails
- **Project deletion cascades to queues and jobs:** The project is the definitive owner; deleting a project implies the removal of its queues and jobs.
- **User deletion does NOT cascade to jobs:** Jobs are owned by queues, not by the users who initiated them. Preserving the job history ensures the audit trail remains intact even if the submitting user's account is deleted.

## 2. Concurrency and Reliability

### `FOR UPDATE SKIP LOCKED` vs. Distributed Locking (Redlock)
Chronos relies entirely on PostgreSQL's `SELECT ... FOR UPDATE SKIP LOCKED` for atomic job claiming. Distributed locks (like Redlock) were explicitly **deferred**.
**Rationale:** `SKIP LOCKED` *is* the distributed lock for this system. It instructs PostgreSQL to acquire a row-level lock on the claimed rows; if another worker attempts to claim concurrently, it atomically skips the already-locked rows. This guarantees no duplicate execution with zero application-layer coordination overhead. Redlock solves a different problem (cross-service resource exclusion) which isn't present in this design. Adding it would introduce redundant complexity.

### Concurrency Limit Enforcement: Count-then-Lock inside one Transaction
The claimer (`claimer.ts`) enforces `queue.concurrencyLimit` via a **count query executed before opening the `FOR UPDATE SKIP LOCKED` transaction**:

```typescript
// Step 1 (outside transaction): count in-flight jobs
const inFlight = await prisma.job.count({
  where: { queueId, status: { in: ['claimed', 'running'] } },
})
const available = Math.max(0, concurrencyLimit - inFlight)
if (available === 0) return []

// Step 2 (inside transaction): SKIP LOCKED up to `available` slots
const rows = await tx.$queryRaw`
  SELECT id FROM jobs WHERE ... LIMIT ${available} FOR UPDATE SKIP LOCKED
`
```

**Why not a Redis counter?** A Redis `INCR`/`DECR` counter kept in sync with claims would require an additional atomic operation on every claim and completion, and would need a reconciliation job to handle worker crashes (where the counter could desync from the DB). By deriving the count from the authoritative source (the `jobs` table itself), we avoid a split-brain scenario. The slight race window between the count read and the lock acquisition is acceptable: the `LIMIT ${available}` clause in the SKIP LOCKED query acts as a second safety valve — even if two workers see `available=3` simultaneously, the Postgres lock manager ensures they claim disjoint sets and the total claimed is at most the true available count.

### Heartbeat-Based Crash Recovery
Workers write a heartbeat to `worker_heartbeats` every N seconds. A reaper checks for stale heartbeats (e.g., > 30s old).
**Rationale:** This is far more robust than TCP keepalives. If a Node.js process hangs (e.g., event loop blocked by a CPU-heavy task) or is OOM-killed, the heartbeat stops. The reaper detects the stale `last_heartbeat_at`, marks the worker as dead, and requeues any jobs that were in a `claimed` or `running` state under that worker's ID.

### Cron Materialization via Scheduler Tick
A tick loop (`scheduler.ts`) running inside the worker process bridges `scheduled_jobs` (definitions) to `jobs` (runnable instances).
**Rationale:** By materializing jobs just-in-time when the cron is due, we keep the `jobs` table lean and allow recurring jobs to utilize the exact same retry, locking, and execution logic as one-shot jobs. Running this tick inside the worker process avoids needing a separate cron-deployment unit.

## 3. API & Security

### Tech Stack Selection
- **API (Node.js + Fastify + TypeScript):** Fastify provides excellent JSON schema validation out-of-the-box, giving us free request validation and automatic OpenAPI generation.
- **Worker (Node.js + TypeScript):** Decoupled from the API. Can be scaled horizontally independently of the ingest API.
- **Database (PostgreSQL 15):** Relational integrity is paramount for job state. Version 15 handles SKIP LOCKED and JSONB exceptionally well.
- **Coordination (Redis 7):** Used exclusively for ephemeral pub/sub (WebSocket fan-out) and token-bucket rate limiting. Not used for persistent job storage.
- **Frontend (Next.js App Router + shadcn/ui):** Minimal build effort for a professional-looking, functional dashboard.

### RBAC at the Organization Level
Roles (`owner`, `admin`, `member`) are defined on `org_memberships`, not directly on projects or queues.
**Rationale:** Organizations span multiple projects. Defining roles at the org level naturally cascades permissions down to all constituent projects and queues, simplifying the authorization model.

### Security Group Hardening
The EC2 deployment requires strict security group rules: SSH (port 22) restricted to the deployer's IP only, while ports 80/443 are open to `0.0.0.0/0`.
**Rationale:** The AWS access keys were previously exposed. Alongside credential rotation, network-level isolation prevents unauthorized SSH access even if keys were compromised. Furthermore, since the app stores payloads in Postgres, it requires no AWS SDK credentials on the EC2 instance, significantly reducing the attack surface.
