/**
 * heartbeat.ts
 * ------------
 * Two responsibilities:
 *
 * 1. WRITER — Keeps the current worker alive in the DB:
 *    - Updates `workers.last_heartbeat_at` every WORKER_HEARTBEAT_INTERVAL_MS
 *    - Inserts a `worker_heartbeats` row (CPU load, active job count)
 *    - Prunes old heartbeats, keeping only the last 100 per worker
 *    - Publishes to Redis "worker:heartbeat" channel
 *
 * 2. REAPER — Detects and recovers from dead workers:
 *    - Runs every 30 seconds
 *    - Finds workers with stale heartbeats (> WORKER_HEARTBEAT_TTL_SECONDS old)
 *    - Marks them "dead"
 *    - Re-queues any jobs they had claimed or were running
 *    - Publishes "job:transition" for each re-queued job
 */

import * as os from "os";
import { prisma } from "./lib/prisma";
import { redis } from "./lib/redis";
import { logger } from "./lib/logger";

const HEARTBEAT_INTERVAL_MS =
  Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS) || 5_000;

const HEARTBEAT_TTL_SECONDS =
  Number(process.env.WORKER_HEARTBEAT_TTL_SECONDS) || 30;

const REAPER_INTERVAL_MS = 30_000;

/** Shared counter — incremented by poller, decremented when jobs complete. */
let _activeJobCount = 0;

export function incrementActiveJobs(): void { _activeJobCount++; }
export function decrementActiveJobs(): void { _activeJobCount = Math.max(0, _activeJobCount - 1); }
export function getActiveJobCount(): number  { return _activeJobCount; }

// -- 1. Heartbeat Writer -----------------------------------------------------

export function startHeartbeatWriter(workerId: string): NodeJS.Timeout {
  const write = async () => {
    try {
      const activeJobCount = _activeJobCount;
      const cpuLoad = os.loadavg()[0]; // 1-minute load average

      // Update worker record
      await prisma.worker.update({
        where: { id: workerId },
        data: { lastHeartbeatAt: new Date() },
      });

      // Insert heartbeat sample
      await prisma.workerHeartbeat.create({
        data: { workerId, activeJobCount, cpuLoad },
      });

      // Prune: keep only last 100 heartbeats for this worker
      // Sub-select trick: Prisma does not expose OFFSET directly, so we
      // use a raw query to find the cutoff ID.
      await prisma.$executeRaw`
        DELETE FROM worker_heartbeats
        WHERE worker_id = ${workerId}::text
          AND id NOT IN (
            SELECT id FROM worker_heartbeats
            WHERE worker_id = ${workerId}::text
            ORDER BY timestamp DESC
            LIMIT 100
          )
      `;

      // Publish to Redis for live dashboard updates
      await redis.publish(
        "worker:heartbeat",
        JSON.stringify({
          workerId,
          activeJobCount,
          cpuLoad,
          timestamp: new Date().toISOString(),
        })
      );

      logger.debug(
        { workerId, activeJobCount, cpuLoad: cpuLoad.toFixed(2) },
        "Heartbeat written"
      );
    } catch (err) {
      logger.error({ err, workerId }, "Heartbeat write failed");
    }
  };

  // Write immediately on start, then on interval
  void write();
  return setInterval(() => void write(), HEARTBEAT_INTERVAL_MS);
}

// -- 2. Reaper ---------------------------------------------------------------

export function startReaper(): NodeJS.Timeout {
  const reap = async () => {
    try {
      const staleThreshold = new Date(
        Date.now() - HEARTBEAT_TTL_SECONDS * 1000
      );

      // Find active workers whose heartbeat has gone stale
      const staleWorkers = await prisma.worker.findMany({
        where: {
          status: "active",
          lastHeartbeatAt: { lt: staleThreshold },
        },
      });

      if (staleWorkers.length === 0) return;

      logger.warn(
        { count: staleWorkers.length },
        "Reaper found stale workers"
      );

      for (const staleWorker of staleWorkers) {
        const wlog = logger.child({ staleWorkerId: staleWorker.id });

        // Mark worker dead
        await prisma.worker.update({
          where: { id: staleWorker.id },
          data: { status: "dead" },
        });

        wlog.warn("Worker marked dead");

        // Find job executions from this worker that are not yet terminal
        const orphanedExecutions = await prisma.jobExecution.findMany({
          where: {
            workerId: staleWorker.id,
            status: { in: ["running"] },
          },
          select: { jobId: true },
        });

        const orphanedJobIds = [
          ...new Set(orphanedExecutions.map((e) => e.jobId)),
        ];

        if (orphanedJobIds.length === 0) {
          wlog.info("No orphaned jobs to requeue");
          continue;
        }

        wlog.info(
          { count: orphanedJobIds.length, jobIds: orphanedJobIds },
          "Requeueing orphaned jobs"
        );

        // Also pick up jobs in 'claimed' state assigned to this worker
        // (claimed jobs may not have a running execution yet)
        const claimedJobs = await prisma.job.findMany({
          where: {
            status: { in: ["claimed", "running"] },
            executions: {
              some: {
                workerId: staleWorker.id,
                status: "running",
              },
            },
          },
          select: { id: true, queueId: true },
        });

        const allJobIds = [
          ...new Set([
            ...orphanedJobIds,
            ...claimedJobs.map((j) => j.id),
          ]),
        ];

        // Requeue each orphaned job and mark its open execution as failed
        for (const jid of allJobIds) {
          try {
            const updatedJob = await prisma.job.update({
              where: { id: jid },
              data: {
                status: "queued",
                attemptCount: { increment: 1 },
                updatedAt: new Date(),
              },
            });

            // Mark the open execution as failed
            await prisma.jobExecution.updateMany({
              where: { jobId: jid, status: "running" },
              data: {
                status: "failed",
                finishedAt: new Date(),
                errorMessage: `Worker ${staleWorker.id} died (stale heartbeat)`,
              },
            });

            await redis.publish(
              "job:transitions",
              JSON.stringify({
                event: "job:transition",
                jobId: jid,
                status: "queued",
                queueId: updatedJob.queueId,
                reason: "worker_dead",
                timestamp: new Date().toISOString(),
              })
            );

            wlog.info({ jobId: jid }, "Orphaned job requeued");
          } catch (err) {
            wlog.error({ err, jobId: jid }, "Failed to requeue orphaned job");
          }
        }
      }
    } catch (err) {
      logger.error({ err }, "Reaper cycle failed");
    }
  };

  // Run first reap cycle after a short delay, then on interval
  const initialDelay = setTimeout(() => {
    void reap();
  }, 10_000);

  const interval = setInterval(() => void reap(), REAPER_INTERVAL_MS);

  // Return the interval handle for cleanup; also clear the initial delay
  // by piggybacking — caller only needs the interval ref for shutdown
  interval.unref?.(); // don't prevent process exit
  clearTimeout(initialDelay); // will have already run or be cleared

  // Actually kick it off properly
  setTimeout(() => void reap(), 10_000);

  return setInterval(() => void reap(), REAPER_INTERVAL_MS);
}
