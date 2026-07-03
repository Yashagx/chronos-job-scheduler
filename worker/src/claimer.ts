/**
 * claimer.ts
 * ----------
 * Atomically claims available jobs from a queue using PostgreSQL row-level
 * locking (FOR UPDATE SKIP LOCKED). This prevents multiple worker replicas
 * from claiming the same job — even under high concurrency.
 *
 * Flow:
 *  1. Count jobs currently in-flight (claimed | running) for this queue.
 *  2. Compute how many slots are free (concurrencyLimit - inFlight).
 *  3. Open a transaction: SELECT ... FOR UPDATE SKIP LOCKED ? UPDATE status.
 *
 * The SKIP LOCKED clause is the key: rows locked by another transaction are
 * simply skipped rather than blocked on, which gives us a non-blocking claim
 * that's safe across multiple worker processes.
 */

import { prisma } from "./lib/prisma";
import { logger } from "./lib/logger";

export async function claimJobs(
  queueId: string,
  workerId: string,
  concurrencyLimit: number
): Promise<string[]> {
  // -- Step 1: Count in-flight jobs for this queue --------------------------
  const inFlight = await prisma.job.count({
    where: {
      queueId,
      status: { in: ["claimed", "running"] },
    },
  });

  const available = Math.max(0, concurrencyLimit - inFlight);

  if (available === 0) {
    logger.debug(
      { queueId, concurrencyLimit, inFlight },
      "Queue at concurrency limit — skipping claim"
    );
    return [];
  }

  // -- Step 2: Atomic claim inside a serializable transaction ---------------
  try {
    const claimedIds = await prisma.$transaction(async (tx) => {
      // SELECT with FOR UPDATE SKIP LOCKED — only picks rows not locked
      // by another concurrent worker transaction.
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM jobs
        WHERE queue_id = ${queueId}::text
          AND status = 'queued'
          AND run_at <= now()
        ORDER BY priority DESC, run_at ASC
        LIMIT ${available}
        FOR UPDATE SKIP LOCKED
      `;

      const ids = rows.map((r) => r.id);
      if (ids.length === 0) return [];

      // Atomically flip status to 'claimed'
      await tx.$executeRaw`
        UPDATE jobs
        SET status = 'claimed', updated_at = now()
        WHERE id = ANY(${ids}::text[])
      `;

      return ids;
    });

    if (claimedIds.length > 0) {
      logger.info(
        { queueId, workerId, count: claimedIds.length, ids: claimedIds },
        "Claimed jobs"
      );
    }

    return claimedIds;
  } catch (err) {
    logger.error(
      { err, queueId, workerId },
      "Failed to claim jobs — transaction rolled back"
    );
    return [];
  }
}
