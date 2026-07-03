<div align="center">

# ⏱️ Chronos — Distributed Job Scheduler

**A production-grade, horizontally scalable job scheduling platform built on PostgreSQL and Redis.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20-green?logo=node.js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://typescriptlang.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15-blue?logo=postgresql)](https://postgresql.org)
[![Redis](https://img.shields.io/badge/Redis-7-red?logo=redis)](https://redis.io)
[![Docker](https://img.shields.io/badge/Docker-Compose-blue?logo=docker)](https://docs.docker.com/compose)

[**🌐 Live Demo**](http://54.87.25.180) • [**📚 Swagger UI**](http://54.87.25.180/api/docs) • [**📖 In-App Guide**](http://54.87.25.180/guide)

</div>

---

## 🧠 What Makes Chronos Different

Most job schedulers use Redis lists, external lock managers (Redlock), or application-level mutexes to prevent duplicate execution. Chronos does none of that.

The core insight: **PostgreSQL's `SELECT ... FOR UPDATE SKIP LOCKED` is itself a distributed lock.** When N worker replicas poll simultaneously, each atomically acquires an exclusive row-lock on a disjoint subset of jobs. Workers never see each other's rows. No thundering herd. No duplicates. Zero coordination overhead beyond what the database already provides.

```sql
-- The entire claim mechanism, in one atomic statement
SELECT id FROM jobs
WHERE queue_id = $1
  AND status    = 'queued'
  AND run_at   <= now()
ORDER BY priority DESC, run_at ASC
LIMIT $2
FOR UPDATE SKIP LOCKED;
```

---

## ✨ Feature Highlights

| Feature | Description |
|---|---|
| 🔒 **Atomic job claiming** | `FOR UPDATE SKIP LOCKED` — no duplicate execution, no thundering herd |
| ⏰ **Flexible scheduling** | Immediate, delayed (`run_at`), or recurring (cron expressions) |
| 🔁 **Automatic retries** | Configurable retry policies with exponential backoff per queue |
| ☠️ **Dead-letter queue** | Exhausted jobs moved to DLQ for manual inspection and replay |
| 💓 **Crash recovery** | Heartbeat-based worker health; stale workers auto-detected and their jobs requeued |
| 📡 **Real-time dashboard** | Socket.io WebSocket fan-out of job state transitions — live updates, no polling |
| 🛡️ **RBAC** | Org-level roles (`owner`, `admin`, `member`) enforced on every route |
| 🚦 **Rate limiting** | Token-bucket rate limiter via Lua script in Redis — 100 req/min (jobs), 10 req/min (auth) |
| 🔑 **Token revocation** | Refresh token JTIs stored in Redis; `POST /auth/logout` revokes immediately |
| 📦 **Batch jobs** | Submit multiple related jobs under a single `batchId` |
| 🔑 **Idempotency keys** | Prevent duplicate submissions with client-supplied idempotency keys |
| 🌐 **REST + OpenAPI** | Full Fastify-powered REST API with auto-generated Swagger UI |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser / API Client                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP / WebSocket
                 ┌─────────▼─────────┐
                 │   Nginx :80        │  Reverse proxy
                 └─────┬──────┬──────┘
              /api      │      │  /
         ┌───▼──────┐   │  ┌──▼────────────┐
         │ API      │   │  │ Web Dashboard  │
         │ Fastify  │   │  │  Next.js :3000 │
         │ :4000    │   │  └────────────────┘
         └────┬──┬──┘   │
              │  │ /socket.io
     ┌────────┘  └──────────────┐
     │                          │
┌────▼──────┐           ┌───────▼──────┐
│PostgreSQL │           │   Redis :6379 │
│   :5432   │           │  pub/sub +    │
│ (source   │           │  rate limits  │
│ of truth) │           └──────▲────────┘
└────▲──────┘                  │
     │                         │
┌────┴──────────────────────────┴──────┐
│          Worker Service (Node.js)     │
│  ┌──────────┐  ┌──────────────────┐  │
│  │ Claimer  │  │   Heartbeat +    │  │
│  │ SKIP     │  │   Crash Reaper   │  │
│  │ LOCKED   │  └──────────────────┘  │
│  └──────────┘  ┌──────────────────┐  │
│  ┌──────────┐  │   Cron           │  │
│  │ Executor │  │   Materializer   │  │
│  │ + DLQ    │  └──────────────────┘  │
│  └──────────┘                        │
└──────────────────────────────────────┘
```

### Data Flow

1. **Job Submission** — Client `POST /queues/:id/jobs` → API validates + rate-limits via Redis → inserts row with `status=queued` (or `scheduled` if `run_at` is future).
2. **Atomic Claiming** — Worker polls with `SKIP LOCKED`, atomically transitions to `claimed`, immediately starts execution.
3. **Execution** — Worker runs the handler, transitions to `running`, writes logs to `job_logs`, finally marks `completed` or `failed`.
4. **Real-time Fan-out** — On every transition, Worker publishes to Redis `job:transitions` channel → API subscriber fans out to all connected Socket.io clients → dashboard updates live.
5. **Crash Recovery** — Worker emits heartbeat every 10 s. Reaper detects staleness > 30 s, marks worker `dead`, requeues orphaned `claimed`/`running` jobs.
6. **Cron Materialization** — Scheduler tick checks `scheduled_jobs`, materializes runnable `jobs` rows on due crons, advances `next_run_at`.

---

## 🗄️ Database Schema (13 Tables)

```mermaid
erDiagram
    users ||--o{ organizations : owns
    users ||--o{ org_memberships : "belongs to"
    organizations ||--o{ org_memberships : has
    organizations ||--o{ projects : contains
    projects ||--o{ queues : contains
    projects ||--o{ retry_policies : defines
    projects ||--o{ scheduled_jobs : defines
    retry_policies |o--o{ queues : "default policy"
    retry_policies |o--o{ jobs : "policy for"
    queues ||--o{ jobs : contains
    queues ||--o{ scheduled_jobs : contains
    jobs ||--o{ job_executions : "attempted via"
    jobs ||--o| dead_letter_jobs : "moved to DLQ"
    job_executions ||--o{ job_logs : generates
    workers ||--o{ job_executions : executes
    workers ||--o{ worker_heartbeats : emits
```

**Key design decisions:**

- **`scheduled_jobs` ≠ `jobs`** — Cron *definitions* live separately from runnable *instances*. Keeps the hot claim index lean and query-friendly.
- **JSONB payloads** — Supports heterogeneous job types (email, HTTP, image resize, etc.) without schema migrations per type. Future GIN indexing is possible.
- **Claim index `(queue_id, status, run_at)`** — Ordered for maximum selectivity on the worker's polling query. Ensures near-instant index-only scans even at millions of rows.
- **Cascade policy** — Project deletion cascades to queues/jobs. User deletion does *not* cascade to jobs — preserves audit trail integrity.

---

## 🚀 Quick Start

### Prerequisites
- Docker + Docker Compose
- Git

### 1. Clone & Configure

```bash
git clone https://github.com/Yashagx/chronos-job-scheduler.git
cd chronos-job-scheduler

# Copy the example env and fill in your secrets
cp .env.example .env
```

Edit `.env` — the required variables:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `JWT_ACCESS_SECRET` | HS256 secret, ≥ 32 characters |
| `JWT_REFRESH_SECRET` | Separate refresh-token secret |
| `POSTGRES_USER` | Postgres username |
| `POSTGRES_PASSWORD` | Postgres password |
| `POSTGRES_DB` | Database name |

### 2. Start the Stack

```bash
docker compose up -d --build
```

This starts 6 services: `postgres`, `redis`, `api`, `worker`, `web`, `nginx`.

### 3. Verify

```bash
docker compose ps        # All services should be "healthy"
curl http://localhost/health   # → 200 OK
```

Open **http://localhost** for the dashboard, **http://localhost/api/docs** for Swagger.

### 4. Run Migrations (first time)

Migrations run automatically on container start via the API's `prisma migrate deploy` step. To run manually:

```bash
docker compose exec api npx prisma migrate deploy
```

---

## 📁 Project Structure

```
chronos-job-scheduler/
│
├── api/                       # Fastify REST API + Socket.io
│   ├── src/
│   │   ├── routes/
│   │   │   ├── auth.ts        # Register, Login, Refresh, Logout
│   │   │   ├── projects.ts    # Project CRUD
│   │   │   ├── queues.ts      # Queue management + pause/resume
│   │   │   ├── jobs.ts        # Submit, list, cancel, retry, DLQ
│   │   │   ├── workers.ts     # Worker registry + heartbeat
│   │   │   └── dashboard.ts   # Aggregated stats endpoint
│   │   ├── middleware/
│   │   │   ├── auth.ts        # JWT verify + cookie extraction
│   │   │   ├── rbac.ts        # requireOrgMember(minRole) factory
│   │   │   └── rateLimit.ts   # Redis token-bucket via Lua
│   │   ├── lib/
│   │   │   ├── prisma.ts      # Singleton PrismaClient
│   │   │   ├── redis.ts       # ioredis + pub/sub
│   │   │   ├── errors.ts      # Typed HTTP error classes
│   │   │   └── pagination.ts  # Cursor + offset pagination helpers
│   │   └── socket/
│   │       └── bridge.ts      # Redis sub → Socket.io fan-out
│   └── tests/
│       ├── retry.test.ts      # Unit: backoff math
│       └── claim.test.ts      # Integration: concurrent SKIP LOCKED
│
├── worker/                    # Job execution engine
│   └── src/
│       ├── claimer.ts         # FOR UPDATE SKIP LOCKED polling loop
│       ├── executor.ts        # Job handler dispatch + lifecycle
│       ├── heartbeat.ts       # Heartbeat writer + crash reaper
│       ├── scheduler.ts       # Cron materialization tick
│       └── handlers/
│           ├── echo.ts        # Built-in: log + complete
│           ├── http_request.ts # Built-in: outbound HTTP
│           └── send_email.ts  # Stub: extend for your SMTP
│
├── web/                       # Next.js App Router dashboard
│   └── app/
│       ├── page.tsx           # Dashboard with live events
│       ├── queues/page.tsx    # Queue management UI
│       ├── jobs/page.tsx      # Job list, submit, retry
│       ├── workers/page.tsx   # Worker health monitor
│       └── guide/page.tsx     # Interactive user guide
│
├── prisma/
│   ├── schema.prisma          # 13-model schema
│   └── migrations/            # All SQL migrations
│
├── nginx/
│   └── nginx.conf             # Reverse proxy + WS upgrade rules
│
├── docs/
│   ├── ARCHITECTURE.md        # Full system diagram + data flow
│   ├── DESIGN_DECISIONS.md    # Engineering rationale
│   ├── ER_DIAGRAM.md          # Entity relationship diagram (Mermaid)
│   └── API.md                 # Endpoint reference
│
└── docker-compose.yml         # Full-stack orchestration
```

---

## 🔌 API Overview

All endpoints are prefixed `/api`. Full interactive docs at `/api/docs`.

### Auth

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/auth/register` | Create account + org + default project |
| `POST` | `/auth/login` | Get access + refresh token |
| `POST` | `/auth/refresh` | Rotate expired access token |
| `POST` | `/auth/logout` | Revoke refresh token (Redis JTI delete) |

### Projects & Queues

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/projects` | List your projects |
| `POST` | `/projects` | Create a project |
| `GET` | `/projects/:id/queues` | List queues |
| `POST` | `/projects/:id/queues` | Create a queue |
| `PATCH` | `/queues/:id` | Update concurrency / pause |
| `DELETE` | `/queues/:id` | Delete a queue |

### Jobs

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/queues/:id/jobs` | Submit a job (immediate, delayed, or cron) |
| `GET` | `/jobs` | List jobs (filter by status, queue, pagination) |
| `GET` | `/jobs/:id` | Job detail |
| `POST` | `/jobs/:id/retry` | Re-queue a failed/DLQ job |
| `POST` | `/jobs/:id/cancel` | Cancel a pending job |
| `GET` | `/jobs/:id/executions` | Execution history |
| `GET` | `/jobs/:id/logs` | Structured log output |

### Workers & Dashboard

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/workers` | List registered workers + status |
| `GET` | `/dashboard/summary` | Aggregated stats (queued, running, failed, etc.) |

### Example: Submit a Cron Job

```bash
curl -X POST http://localhost/api/queues/<queue-id>/jobs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "send_email",
    "payload": { "to": "user@example.com", "subject": "Daily report" },
    "cronExpression": "0 9 * * 1-5"
  }'
```

### Example: Submit a Delayed Job

```bash
curl -X POST http://localhost/api/queues/<queue-id>/jobs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "http_request",
    "payload": { "url": "https://example.com/webhook", "method": "POST" },
    "runAt": "2024-12-25T09:00:00Z",
    "priority": 8
  }'
```

---

## 🧪 Testing

```bash
cd api
npm install

# Unit tests (retry backoff math)
npx vitest run tests/retry.test.ts

# Integration tests (concurrent SKIP LOCKED claim)
# Requires a running Postgres instance
DATABASE_URL=postgresql://chronos:password@localhost:5432/chronos \
  npx vitest run tests/claim.test.ts
```

The integration test spins up 5 concurrent workers that all try to claim the same pool of jobs simultaneously, asserting each job is claimed exactly once.

---

## 🔐 Security Model

- **JWT Access Tokens** — 15-minute lifetime, HS256, verified on every protected route.
- **Refresh Tokens** — 7-day lifetime. JTIs stored in Redis. Logout = instant Redis `DEL`. No DB table needed.
- **RBAC** — `requireOrgMember(minRole)` Fastify `preHandler` resolves `orgId` from route params, looks up membership, and throws `403` if the user's role is insufficient.
- **Rate Limiting** — Redis Lua script implementing a sliding token bucket. Auth endpoints: 10 req/min. Job submission: 100 req/min. Per-IP enforcement.
- **Password Hashing** — bcrypt with cost factor 12.
- **No secrets in repo** — All credentials via `.env` (gitignored). `.env.example` ships with placeholder values only.

---

## ⚙️ Configuration Reference

```env
# Database
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# Redis
REDIS_URL=redis://:password@host:6379

# Auth
JWT_ACCESS_SECRET=<32+ char secret>
JWT_REFRESH_SECRET=<32+ char secret>
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# API Service
API_PORT=4000
API_HOST=0.0.0.0
NODE_ENV=production
LOG_LEVEL=info
CORS_ORIGIN=http://localhost:3000

# Worker Tuning
WORKER_POLL_INTERVAL_MS=2000        # How often workers poll for new jobs
WORKER_HEARTBEAT_INTERVAL_MS=10000  # How often workers emit heartbeats
WORKER_HEARTBEAT_TTL_SECONDS=30     # Staleness threshold for crash detection
WORKER_SCHEDULER_TICK_MS=5000       # Cron materialization interval
WORKER_CONCURRENCY=5                # Max jobs per worker process

# Web
NEXT_PUBLIC_API_URL=http://localhost/api
NEXT_PUBLIC_WS_URL=http://localhost
```

---

## 📊 Concurrency Deep Dive

### Why not Redlock?

Redlock solves cross-service resource exclusion when you have *multiple Redis nodes*. Chronos doesn't have that problem — PostgreSQL's row-locking is the single authoritative coordination point.

`FOR UPDATE SKIP LOCKED` gives us:
- ✅ Atomic acquisition — lock granted or skipped, no waiting
- ✅ Transaction-scoped — lock released automatically on commit/rollback
- ✅ No split-brain — the same DB that stores jobs enforces the lock
- ✅ Crash-safe — if a worker dies mid-transaction, Postgres rolls back and releases the lock

### Concurrency Limit Enforcement

The claimer enforces `queue.concurrencyLimit` without a Redis counter:

```typescript
// Count in-flight jobs from the source of truth
const inFlight = await prisma.job.count({
  where: { queueId, status: { in: ['claimed', 'running'] } }
})
const slots = Math.max(0, concurrencyLimit - inFlight)
if (slots === 0) return []

// Claim up to available slots
const claimed = await tx.$queryRaw`
  SELECT id FROM jobs
  WHERE queue_id = ${queueId} AND status = 'queued' AND run_at <= now()
  ORDER BY priority DESC, run_at ASC
  LIMIT ${slots}
  FOR UPDATE SKIP LOCKED
`
```

Even if two workers read `slots=3` simultaneously, the `LIMIT` clause inside the `SKIP LOCKED` transaction means they claim *disjoint subsets* — total claims never exceed the true available capacity.

---

## 🗺️ Roadmap

- [ ] Multi-tenant API key support (per-project keys for programmatic access)
- [ ] Prometheus metrics endpoint (`/metrics`)
- [ ] Dead-letter queue UI (view, bulk-retry, purge)
- [ ] Job dependencies / DAG workflows
- [ ] HTTPS support (Certbot + registered domain)
- [ ] Horizontal worker scaling with auto-load-balancing
- [ ] SDK clients (TypeScript, Python)

---

## 📖 Documentation

| Document | Description |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Full system diagram and service-level data flow |
| [DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md) | Engineering rationale for every major technical choice |
| [ER_DIAGRAM.md](docs/ER_DIAGRAM.md) | Full 13-table entity relationship diagram |
| [API.md](docs/API.md) | Endpoint reference with request/response examples |
| [In-App Guide](http://54.87.25.180/guide) | Interactive new-user guide built into the dashboard |

---

## ⚠️ Known Limitations

1. **HTTP only on live demo** — The EC2 instance runs behind Nginx on port 80. HTTPS requires a registered domain for Certbot/Let's Encrypt. The bare IP is HTTP-only.
2. **Single-region deployment** — Postgres and Redis run in the same `docker-compose` stack. Production would use RDS Multi-AZ + ElastiCache cluster mode.
3. **Worker handlers are illustrative** — `echo`, `http_request`, and `send_email` demonstrate the execution framework. Production deployments register domain-specific handlers against a worker SDK.
4. **No job dependency graph** — Jobs are independent. DAG-style workflows (job B starts only after job A) are on the roadmap.

---

## 📜 License

[MIT](LICENSE) — free to use, modify, and distribute.

---

<div align="center">

Built with ❤️ using **Fastify · Prisma · PostgreSQL · Redis · Next.js · Docker**

</div>
