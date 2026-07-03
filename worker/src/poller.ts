/**
 * poller.ts
 * ---------
 * Main claim-and-execute poll loop. Every WORKER_POLL_INTERVAL_MS:
 *
 *  1. Fetch all non-paused queues
 *  2. For each queue, call claimJobs to atomically grab available jobs
 *  3. For each claimed job, launch executeJob concurrently
 *  4. Track in-flight job set so graceful shutdown can wait for completion
 *
 * Concurrency note: We do NOT await all executions before moving on — jobs
 * from different queues run concurrently. The per-queue concurrencyLimit is
 * enforced at claim time (claimer.ts) so we never over-claim.
 *
 * Graceful shutdown: stopPoller() sets a flag to exit the loop. The caller
 * (index.ts) then waits on `waitForInFlight()` before exiting the process.
 */

import { prisma } from "./lib/prisma";
import { logger } from "./lib/logger";
import { claimJobs } from "./claimer";
import { executeJob } from "./executor";
import {
  incrementActiveJobs,
  decrementActiveJobs,
} from "./heartbeat";

const POLL_INTERVAL_MS =
  Number(process.env.WORKER_POLL_INTERVAL_MS) || 1_000;

let running = false;
let stopping = false;

/** Tracks currently executing job promises. */
const inFlight = new Set<Promise<void>>();

/** Exported so index.ts can await all in-flight jobs during shutdown. */
export function getInFlightCount(): number {
  return inFlight.size;
}

/** Signal the poller to stop after the current cycle finishes. */
export function stopPoller(): void {
  stopping = true;
  logger.info("Poller stop requested");
}

/**
 * Returns a promise that resolves when all in-flight jobs have settled,
 * or after `timeoutMs` milliseconds (whichever comes first).
 */
export async function waitForInFlight(
  timeoutMs = 30_000
): Promise<void> {
  if (inFlight.size === 0) return;

  logger.info(
    { inFlight: inFlight.size },
    "Waiting for in-flight jobs to complete…"
  );

  const timeout = new Promise<void>((resolve) =>
    setTimeout(() => {
      logger.warn(
        { inFlight: inFlight.size },
        "Graceful shutdown timeout — some jobs may still be running"
      );
      resolve();
    }, timeoutMs)
  );

  const allSettled = Promise.allSettled([...inFlight]).then(() => undefined);

  return Promise.race([allSettled, timeout]);
}

/**
 * Launches one cycle of the poll loop:
 * - Fetch queues
 * - Claim jobs
 * - Execute concurrently
 */
async function pollCycle(workerId: string): Promise<void> {
  // Fetch all active (non-paused) queues
  let queues: Array<{ id: string; concurrencyLimit: number; name: string }>;

  try {
    queues = await prisma.queue.findMany({
      where: { isPaused: false },
      select: { id: true, concurrencyLimit: true, name: true },
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch queues — skipping cycle");
    return;
  }

  if (queues.length === 0) return;

  for (const queue of queues) {
    if (stopping) break;

    let claimedIds: string[];
    try {
      claimedIds = await claimJobs(queue.id, workerId, queue.concurrencyLimit);
    } catch (err) {
      logger.error({ err, queueId: queue.id }, "claimJobs threw unexpectedly");
      continue;
    }

    for (const jobId of claimedIds) {
      if (stopping) break;

      incrementActiveJobs();

      // Build the execution promise
      const jobPromise: Promise<void> = executeJob(jobId, workerId)
        .catch((err) => {
          // executeJob handles its own errors internally; this catches
          // truly unexpected top-level failures
          logger.error(
            { err, jobId, workerId },
            "Unexpected error from executeJob"
          );
        })
        .finally(() => {
          decrementActiveJobs();
          inFlight.delete(jobPromise);
        });

      inFlight.add(jobPromise);

      logger.debug(
        { jobId, queueId: queue.id, queueName: queue.name, inFlight: inFlight.size },
        "Job launched"
      );
    }
  }
}

/** Utility sleep */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Starts the continuous poll loop. Returns when `stopPoller()` is called.
 */
export async function startPoller(workerId: string): Promise<void> {
  if (running) {
    logger.warn("startPoller called while already running");
    return;
  }

  running = true;
  stopping = false;
  logger.info({ pollIntervalMs: POLL_INTERVAL_MS }, "Poller started");

  while (!stopping) {
    const cycleStart = Date.now();

    await pollCycle(workerId);

    // Sleep for the remaining poll interval
    const elapsed = Date.now() - cycleStart;
    const remaining = Math.max(0, POLL_INTERVAL_MS - elapsed);
    if (remaining > 0 && !stopping) {
      await sleep(remaining);
    }
  }

  running = false;
  logger.info("Poller loop exited");
}
