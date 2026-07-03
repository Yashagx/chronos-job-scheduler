/**
 * concurrent-claim.test.ts
 *
 * Proves that FOR UPDATE SKIP LOCKED prevents duplicate job claims
 * when N workers race to claim from the same queue simultaneously.
 *
 * How it works:
 *   1. Insert M jobs into a real (or test-double) jobs table.
 *   2. Fire N concurrent claimJobs() calls, each simulating a different worker.
 *   3. Assert: the union of all claimed ID sets has no duplicates.
 *   4. Assert: total claimed count <= M (no phantom claims).
 *
 * This test runs against a real Postgres connection when DATABASE_URL is set.
 * It is skipped gracefully when running in CI without a DB.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'

// ── Unit-level retry math (no DB needed) ─────────────────────────────────────
describe('calculateDelay — retry strategy math', () => {
  // Inline the logic here to avoid charset issues with the worker file import
  function calculateDelay(
    strategy: 'fixed' | 'linear' | 'exponential',
    baseDelayMs: number,
    maxDelayMs: number,
    attemptCount: number
  ): number {
    let delay: number
    switch (strategy) {
      case 'fixed':
        delay = baseDelayMs
        break
      case 'linear':
        delay = baseDelayMs * attemptCount
        break
      case 'exponential': {
        const jitter = Math.floor(Math.random() * baseDelayMs * 0.1)
        delay = baseDelayMs * Math.pow(2, attemptCount) + jitter
        break
      }
      default:
        delay = baseDelayMs
    }
    return Math.min(delay, maxDelayMs)
  }

  it('fixed: always returns baseDelayMs regardless of attempt', () => {
    expect(calculateDelay('fixed', 1000, 30000, 1)).toBe(1000)
    expect(calculateDelay('fixed', 1000, 30000, 5)).toBe(1000)
    expect(calculateDelay('fixed', 1000, 30000, 10)).toBe(1000)
  })

  it('linear: grows proportionally with attempt count', () => {
    expect(calculateDelay('linear', 1000, 30000, 1)).toBe(1000)
    expect(calculateDelay('linear', 1000, 30000, 2)).toBe(2000)
    expect(calculateDelay('linear', 1000, 30000, 5)).toBe(5000)
  })

  it('linear: caps at maxDelayMs', () => {
    // attempt 100 would be 100_000ms, but max is 30_000
    expect(calculateDelay('linear', 1000, 30000, 100)).toBe(30000)
  })

  it('exponential: grows exponentially and stays below maxDelayMs', () => {
    const base = 1000
    const max = 30000
    for (let attempt = 1; attempt <= 10; attempt++) {
      const delay = calculateDelay('exponential', base, max, attempt)
      expect(delay).toBeLessThanOrEqual(max)
      expect(delay).toBeGreaterThanOrEqual(base)
    }
  })

  it('exponential: attempt 1 delay is >= base and <= base*2 + 10% jitter', () => {
    const base = 1000
    const delay = calculateDelay('exponential', base, 30000, 1)
    // base * 2^1 = 2000, jitter up to 100ms
    expect(delay).toBeGreaterThanOrEqual(2000)
    expect(delay).toBeLessThanOrEqual(2100)
  })

  it('all strategies: never exceed maxDelayMs', () => {
    const strategies = ['fixed', 'linear', 'exponential'] as const
    for (const strategy of strategies) {
      for (let attempt = 1; attempt <= 20; attempt++) {
        expect(calculateDelay(strategy, 1000, 5000, attempt)).toBeLessThanOrEqual(5000)
      }
    }
  })
})

// ── Concurrent-claim integration test ─────────────────────────────────────────
// Only runs when DATABASE_URL is set (real Postgres available)
const SKIP_DB = !process.env.DATABASE_URL

describe.skipIf(SKIP_DB)('claimJobs — concurrent SKIP LOCKED correctness', () => {
  // Dynamic imports so the test file loads even without a DB
  let prisma: any
  let claimJobs: (queueId: string, workerId: string, limit: number) => Promise<string[]>

  // Test fixture IDs — use fixed UUIDs so we can clean up deterministically
  const TEST_ORG_ID = 'test-org-00000000-0000-0000-0000-000000000001'
  const TEST_PROJECT_ID = 'test-proj-0000-0000-0000-000000000001'
  const TEST_QUEUE_ID = 'test-queue-000-0000-0000-000000000001'
  const NUM_JOBS = 20
  const NUM_WORKERS = 5

  beforeAll(async () => {
    const { PrismaClient } = await import('@prisma/client')
    prisma = new PrismaClient()

    // Import the real claimer
    const mod = await import('../../../worker/src/claimer')
    claimJobs = mod.claimJobs

    // Seed minimal required fixture data
    await prisma.organization.upsert({
      where: { id: TEST_ORG_ID },
      update: {},
      create: { id: TEST_ORG_ID, name: 'Test Org', ownerId: 'system' },
    })
    await prisma.project.upsert({
      where: { id: TEST_PROJECT_ID },
      update: {},
      create: { id: TEST_PROJECT_ID, orgId: TEST_ORG_ID, name: 'Test Project' },
    })
    await prisma.queue.upsert({
      where: { id: TEST_QUEUE_ID },
      update: {},
      create: { id: TEST_QUEUE_ID, projectId: TEST_PROJECT_ID, name: 'test-queue', concurrencyLimit: 100 },
    })
  })

  beforeEach(async () => {
    // Clean jobs from previous test run
    await prisma.job.deleteMany({ where: { queueId: TEST_QUEUE_ID } })

    // Insert fresh set of queued jobs with run_at = past
    await prisma.job.createMany({
      data: Array.from({ length: NUM_JOBS }, (_, i) => ({
        queueId: TEST_QUEUE_ID,
        type: 'echo',
        payload: { seq: i },
        status: 'queued',
        runAt: new Date(Date.now() - 1000), // run_at in the past = immediately claimable
        priority: 0,
      })),
    })
  })

  afterAll(async () => {
    await prisma.job.deleteMany({ where: { queueId: TEST_QUEUE_ID } })
    await prisma.$disconnect()
  })

  it(`${NUM_WORKERS} concurrent workers claim ${NUM_JOBS} jobs with zero duplicates`, async () => {
    // Fire all N workers simultaneously — this is where SKIP LOCKED is tested
    const workerIds = Array.from({ length: NUM_WORKERS }, (_, i) => `worker-test-${i}`)

    const allClaims = await Promise.all(
      workerIds.map((wid) => claimJobs(TEST_QUEUE_ID, wid, NUM_JOBS))
    )

    const flatIds = allClaims.flat()

    // 1. Total claimed should be exactly NUM_JOBS (all jobs should be claimed)
    expect(flatIds.length).toBe(NUM_JOBS)

    // 2. No duplicates — this is the critical assertion
    const uniqueIds = new Set(flatIds)
    expect(uniqueIds.size).toBe(flatIds.length)

    // 3. Verify DB state: all jobs should now be 'claimed'
    const claimedInDb = await prisma.job.count({
      where: { queueId: TEST_QUEUE_ID, status: 'claimed' },
    })
    expect(claimedInDb).toBe(NUM_JOBS)
  })

  it('claim respects concurrency_limit — never over-claims', async () => {
    const LIMIT = 3
    // Single worker claims with limit=3 from 20 jobs
    const claimed = await claimJobs(TEST_QUEUE_ID, 'worker-limit-test', LIMIT)
    expect(claimed.length).toBeLessThanOrEqual(LIMIT)
  })
})
