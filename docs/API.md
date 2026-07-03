# Chronos API Reference

Base URL: `/api` (e.g., `http://localhost:4000/api`)

All requests must use `Content-Type: application/json`.
Protected routes require the `Authorization` header with a valid JWT access token:
`Authorization: Bearer <access_token>`

---

## Auth

### `POST /auth/register`
Register a new user and create an organization.
**Auth Required:** None
**Body:**
```json
{
  "email": "user@example.com",
  "password": "strongpassword123",
  "orgName": "My Company" // Optional
}
```
**Response (201 Created):**
Returns the user, organization, and a short-lived `accessToken`. A `refreshToken` is set as an `httpOnly` cookie.

### `POST /auth/login`
**Auth Required:** None
**Body:** `{ "email": "user@example.com", "password": "strongpassword123" }`
**Response (200 OK):** User data and `accessToken`.

### `POST /auth/refresh`
**Auth Required:** None (uses `refreshToken` cookie)
**Response (200 OK):** `{ "accessToken": "new_token" }`

---

## Projects

### `POST /projects`
Create a new project.
**Auth Required:** Bearer (requires `admin` role in the org)
**Body:** `{ "orgId": "org_123", "name": "Main Platform" }`
**Response (201 Created):** Returns project details including the auto-generated `apiKey`.

### `GET /projects`
List all projects accessible to the user.
**Auth Required:** Bearer
**Query Params:** `?page=1&limit=20`
**Response (200 OK):** `{ "data": [...], "meta": { "page": 1, "limit": 20, "total": 1 } }`

### `GET /projects/:id`
Get detailed project information.
**Auth Required:** Bearer

---

## Queues

### `POST /projects/:projectId/queues`
Create a new queue within a project.
**Auth Required:** Bearer (requires `admin` role)
**Body:**
```json
{
  "name": "email-queue",
  "priority": 10,
  "concurrencyLimit": 5,
  "defaultRetryPolicyId": "retry_123" // Optional
}
```

### `GET /projects/:projectId/queues`
List all queues in a project with job counts by status.
**Auth Required:** Bearer

### `PATCH /queues/:id`
Update queue settings.
**Auth Required:** Bearer (requires `admin` role)
**Body (any combination of):** `{ "priority": 20, "concurrencyLimit": 10, "isPaused": true }`

### `GET /queues/:id/stats`
Get queue statistics including throughput.
**Auth Required:** Bearer
**Response:** `totalJobs`, `byStatus`, and `jobsPerMinute`.

---

## Jobs

### `POST /queues/:queueId/jobs`
Submit a new job. Rate limited to 100 req/min per user.
**Auth Required:** Bearer (requires `member` role)
**Body:**
```json
{
  "type": "send_email",
  "payload": { "to": "user@test.com", "subject": "Welcome!" },
  "runAt": "2026-07-04T12:00:00Z", // Optional, defaults to immediate
  "cronExpression": "0 12 * * *", // Optional, makes it a recurring definition
  "idempotencyKey": "unique_msg_8891", // Optional
  "priority": 5 // Optional
}
```

### `POST /queues/:queueId/jobs/batch`
Submit multiple jobs atomically.
**Auth Required:** Bearer
**Body:** `{ "jobs": [ { "type": "task1" }, { "type": "task2" } ] }`

### `GET /jobs`
List jobs.
**Auth Required:** Bearer
**Query Params:** `?queueId=123&status=queued&type=send_email&page=1&limit=20`

### `GET /jobs/:id`
Get job details, including the latest execution attempt.
**Auth Required:** Bearer

### `GET /jobs/:id/executions`
Get all execution history attempts.
**Auth Required:** Bearer

### `GET /jobs/:id/logs`
Get all logs recorded during all executions of the job.
**Auth Required:** Bearer

### `POST /jobs/:id/retry`
Manually retry a failed or dead-letter job. Resets status to `queued`.
**Auth Required:** Bearer

### `POST /jobs/:id/cancel`
Cancel a queued or scheduled job.
**Auth Required:** Bearer

---

## Workers

### `GET /workers`
List all registered workers.
**Auth Required:** Bearer
**Query Params:** `?status=active`

### `GET /workers/:id`
Get worker details and active job count.
**Auth Required:** Bearer

### `GET /workers/:id/heartbeats`
Get the last N heartbeats for health/load visualization.
**Auth Required:** Bearer
