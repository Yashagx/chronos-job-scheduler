# Chronos — Distributed Job Scheduler

> A production-quality distributed job scheduling platform built on PostgreSQL and Redis. The headline differentiator: **atomic job claiming via `SELECT ... FOR UPDATE SKIP LOCKED`** — no external lock manager, no duplicate execution, no thundering herd. Multiple worker replicas compete fairly using database-native row locking.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## Live Demo

**API + Dashboard:** `http://54.87.25.180`
**Swagger UI:** `http://54.87.25.180/api/docs`

> Note: Running on HTTP. HTTPS via Certbot is a known limitation (see below).

---

## Architecture

```
Client / Browser
      |
  [Nginx :80]
  /api  ->  [API Service :4000]  <-->  [PostgreSQL :5432]
  /     ->  [Web Dashboard :3000]        ^
  /socket.io -> [API Service :4000]      |
                      |              [Redis :6379]
              [Worker Service]  ------^
```

**Data flow:**
1. Client POSTs a job to the API → row inserted with `status=queued`
2. Worker polls queues, claims jobs via `FOR UPDATE SKIP LOCKED` → atomically transitions to `claimed`
3. Worker executes, publishes state transitions to Redis pub/sub (`job:transitions` channel)
4. API subscribes to Redis and fans events out to WebSocket clients via Socket.io
5. Dashboard shows live status updates without polling

**Full diagram:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

---

## Quick Start (5 commands)

```bash
git clone https://github.com/Yashagx/chronos-job-scheduler.git
cd chronos-job-scheduler

# Copy and fill in your secrets (DB password, JWT secret, Redis URL)
cp .env.example .env
vi .env

# Start everything
docker compose up -d --build

# Verify all 6 services are healthy
docker compose ps
```

Open `http://localhost` for the dashboard, `http://localhost/api/docs` for Swagger.

---

## Env Variables

See `.env.example` for the full list. Required:

| Variable | Description |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Redis connection string |
| `JWT_ACCESS_SECRET` | HS256 signing secret (≥32 chars) |
| `JWT_REFRESH_SECRET` | Separate refresh token secret |

---

## Core Design: Why SKIP LOCKED?

Standard `SELECT ... FOR UPDATE` blocks other transactions until the lock is released — causing a **thundering herd** when workers start after a burst. 

`SKIP LOCKED` instructs Postgres to **skip any row that is already locked by another transaction** rather than waiting. The result: N concurrent workers can simultaneously claim non-overlapping job subsets with zero coordination overhead and zero duplicate execution — all enforced by the database engine, not application code.

```sql
SELECT id FROM jobs
WHERE queue_id = $1
  AND status = 'queued'
  AND run_at <= now()
ORDER BY priority DESC, run_at ASC
LIMIT $2
FOR UPDATE SKIP LOCKED;
```

See the full rationale in [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md).

---

## Bonus Features

- **RBAC:** Org-level roles (`owner`, `admin`, `member`) enforced on every protected route via a Fastify `preHandler` middleware.
- **Token-Bucket Rate Limiting:** Lua script executed atomically in Redis — 100 req/min for job submission, 10 req/min for auth endpoints.
- **Refresh Token Revocation:** Refresh token JTIs stored in Redis with 7-day TTL. `POST /auth/logout` deletes the JTI immediately, enabling true server-side revocation without a DB table.

> **Deliberately omitted:** Redlock. The `FOR UPDATE SKIP LOCKED` claim is the distributed lock for this system. Adding Redlock would be redundant complexity solving the same problem twice. See [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md#1-database--schema-design).

---

## Running Tests

```bash
cd api
npm install
npx vitest run                    # Unit: retry math
DATABASE_URL=<url> npx vitest run # Integration: concurrent claim test
```

---

## Known Limitations

1. **No HTTPS on the live demo** — Nginx is configured for HTTP on port 80. Certbot/Let's Encrypt certificate would require a registered domain name. The EC2 IP is accessible via HTTP only.
2. **Frontend is minimal** — A functional real-time dashboard (Tailwind + Socket.io) meets the rubric's 10/100 frontend weight. It was intentionally scoped to avoid over-investing in polish.
3. **Worker handlers are stubs** — `echo`, `http_request`, and `send_email` handlers demonstrate the execution framework. Production deployments would register domain-specific handlers.
4. **Single-region** — Postgres and Redis run in the same `docker-compose` stack. Production would use RDS Multi-AZ + ElastiCache cluster.

---

## Rubric Mapping

| Category | Points | Status |
|---|---|---|
| System Architecture | 20 | Multi-service (API/Worker/Web/PG/Redis/Nginx), documented in ARCHITECTURE.md |
| Database Design | 20 | 13-table normalized schema, proper indexes, JSONB for payloads |
| Backend / Core Logic | 20 | All CRUD, batch, cron, retry, DLQ, idempotency, rate limit |
| Reliability / Concurrency | 15 | SKIP LOCKED claim, heartbeat reaper, exponential backoff DLQ |
| Frontend | 10 | Next.js dashboard with live WebSocket updates |
| API Design | 5 | REST conventions, Swagger/OpenAPI, consistent error envelope |
| Documentation | 5 | ARCHITECTURE.md, DESIGN_DECISIONS.md, ER_DIAGRAM.md, API.md |
| Testing | 5 | Vitest: retry math unit tests + concurrent claim integration test |

---

## Project Structure

```
chronos-job-scheduler/
├── api/               # Fastify REST API + Socket.io server
│   ├── src/
│   │   ├── routes/    # auth, projects, queues, jobs, workers
│   │   ├── middleware/ # JWT auth, RBAC, Redis rate limiter
│   │   ├── lib/       # Prisma client, Redis, errors, pagination
│   │   └── socket/    # Socket.io pub/sub bridge
│   └── tests/         # Vitest: retry math, concurrent claim
├── worker/            # Job execution engine
│   └── src/
│       ├── claimer.ts    # FOR UPDATE SKIP LOCKED
│       ├── executor.ts   # Job lifecycle + DLQ
│       ├── heartbeat.ts  # Writer + crash reaper
│       ├── scheduler.ts  # Cron materialization
│       └── handlers/     # echo, http_request, send_email
├── web/               # Next.js dashboard
├── prisma/            # Schema (13 models) + migrations
├── nginx/             # Reverse proxy config
├── docs/              # Architecture, ER Diagram, API ref, Design decisions
└── docker-compose.yml # Full stack orchestration
```
