/**
 * executor.ts
 * -----------
 * Executes a single claimed job end-to-end:
 *
 *  queued ? claimed ? running ? completed
 *                            ? failed ? queued (retry) or dead_letter
 *
 * Every status transition publishes a Redis event on the "job:transitions"
 * channel so the API server can fan-out over WebSockets to connected clients.
 *
 * Retry logic is fully resolved here: we look up the job-level retryPolicy
 * first, falling back to the queue's defaultRetryPolicy, then to hard-coded
 * defaults. This mirrors the intent that individual jobs can override the
 * queue's policy.
 */

import { prisma } from "./lib/prisma";
import { redis } from "./lib/redis";
import { logger } from "./lib/logger";
import { getHandler } from "./handlers";
import { calculateDelay, RetryStrategy } from "./retry";

// Default retry policy if neither job nor queue specifies one
const DEFAULT_RETRY = {
  strategy: "exponential" as RetryStrategy,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  maxAttempts: 3,
};

/** Publishes a job state-transition event to Redis pub/sub. */
async function publishTransition(event: {
  event: string;
  jobId: string;
  status: string;
  queueId: string;
  timestamp: string;
}): Promise<void> {
  try {
    await redis.publish("job:transitions", JSON.stringify(event));
  } catch (err) {
    // Non-fatal — a Redis publish failure must not affect job execution
    logger.warn({ err, jobId: event.jobId }, "Failed to publish job transition to Redis");
  }
}

/**
 * Executes the job identified by `jobId`.
 * Safe to call concurrently; each invocation is isolated.
 */
export async function executeJob(
  jobId: string,
  workerId: string
): Promise<void> {
  const jobLog = logger.child({ jobId, workerId });

  // -- 1. Fetch job with its retry policy and queue default ----------------
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: {
      retryPolicy: true,
      queue: {
        include: { defaultRetryPolicy: true },
      },
    },
  });

  if (!job) {
    jobLog.error("Job not found — may have been deleted");
    return;
  }

  // Resolve effective retry policy: job > queue default > hard-coded default
  const policy =
    job.retryPolicy ??
    job.queue.defaultRetryPolicy ??
    DEFAULT_RETRY;

  const {
    strategy,
    baseDelayMs,
    maxDelayMs,
    maxAttempts,
  } = {
    strategy: (policy.strategy as RetryStrategy),
    baseDelayMs: policy.baseDelayMs,
    maxDelayMs: policy.maxDelayMs,
    maxAttempts: policy.maxAttempts,
  };

  // -- 2. Mark job as running -----------------------------------------------
  await prisma.job.update({
    where: { id: jobId },
    data: { status: "running" },
  });

  await publishTransition({
    event: "job:transition",
    jobId,
    status: "running",
    queueId: job.queueId,
    timestamp: new Date().toISOString(),
  });

  // -- 3. Create execution record -------------------------------------------
  const execution = await prisma.jobExecution.create({
    data: {
      jobId,
      workerId,
      attemptNumber: job.attemptCount + 1,
      status: "running",
    },
  });

  const startedAt = Date.now();

  // -- 4. Collect per-job log entries (buffered, flushed on completion) -----
  const logBuffer: Array<{ level: string; message: string }> = [];

  const handlerLog = (level: string, msg: string): void => {
    logBuffer.push({ level, message: msg });
    jobLog[level as "info" | "debug" | "warn" | "error"]?.(msg);
  };

  // -- 5. Call the handler --------------------------------------------------
  try {
    const handler = getHandler(job.type);
    await handler(job.payload, handlerLog);

    const durationMs = Date.now() - startedAt;

    // -- Success path ------------------------------------------------------
    await prisma.$transaction([
      prisma.job.update({
        where: { id: jobId },
        data: { status: "completed", updatedAt: new Date() },
      }),
      prisma.jobExecution.update({
        where: { id: execution.id },
        data: {
          status: "completed",
          finishedAt: new Date(),
          durationMs,
        },
      }),
      prisma.jobLog.create({
        data: {
          executionId: execution.id,
          level: "info",
          message: `Job completed successfully in ${durationMs}ms`,
        },
      }),
      // Flush buffered handler logs
      ...logBuffer.map((entry) =>
        prisma.jobLog.create({
          data: {
            executionId: execution.id,
            level: entry.level,
            message: entry.message,
          },
        })
      ),
    ]);

    await publishTransition({
      event: "job:transition",
      jobId,
      status: "completed",
      queueId: job.queueId,
      timestamp: new Date().toISOString(),
    });

    jobLog.info({ durationMs }, "Job completed successfully");
  } catch (err: unknown) {
    // -- Failure path ------------------------------------------------------
    const durationMs = Date.now() - startedAt;
    const errorMessage =
      err instanceof Error ? err.message : String(err);
    const newAttemptCount = job.attemptCount + 1;

    jobLog.warn(
      { err: errorMessage, attempt: newAttemptCount, maxAttempts },
      "Job handler threw an error"
    );

    if (newAttemptCount < maxAttempts) {
      // -- Retry: schedule next attempt ------------------------------------
      const delayMs = calculateDelay(
        strategy,
        baseDelayMs,
        maxDelayMs,
        newAttemptCount
      );
      const runAt = new Date(Date.now() + delayMs);

      await prisma.$transaction([
        prisma.job.update({
          where: { id: jobId },
          data: {
            status: "queued",
            attemptCount: newAttemptCount,
            runAt,
            updatedAt: new Date(),
          },
        }),
        prisma.jobExecution.update({
          where: { id: execution.id },
          data: {
            status: "failed",
            finishedAt: new Date(),
            durationMs,
            errorMessage,
          },
        }),
        prisma.jobLog.create({
          data: {
            executionId: execution.id,
            level: "error",
            message: `Job failed (attempt ${newAttemptCount}/${maxAttempts}): ${errorMessage}. Retrying in ${delayMs}ms`,
          },
        }),
        ...logBuffer.map((entry) =>
          prisma.jobLog.create({
            data: {
              executionId: execution.id,
              level: entry.level,
              message: entry.message,
            },
          })
        ),
      ]);

      await publishTransition({
        event: "job:transition",
        jobId,
        status: "failed_retrying",
        queueId: job.queueId,
        timestamp: new Date().toISOString(),
      });

      jobLog.info(
        { delayMs, runAt, attempt: newAttemptCount, maxAttempts },
        "Job re-queued for retry"
      );
    } else {
      // -- Dead letter: max attempts exhausted -----------------------------
      jobLog.error(
        { attempt: newAttemptCount, maxAttempts },
        "Max attempts exhausted — moving to dead letter queue"
      );

      await prisma.$transaction([
        prisma.job.update({
          where: { id: jobId },
          data: {
            status: "dead_letter",
            attemptCount: newAttemptCount,
            updatedAt: new Date(),
          },
        }),
        prisma.jobExecution.update({
          where: { id: execution.id },
          data: {
            status: "failed",
            finishedAt: new Date(),
            durationMs,
            errorMessage,
          },
        }),
        prisma.deadLetterJob.create({
          data: {
            originalJobId: jobId,
            queueId: job.queueId,
            payload: job.payload ?? {},
            failureReason: errorMessage,
            attemptCount: newAttemptCount,
          },
        }),
        prisma.jobLog.create({
          data: {
            executionId: execution.id,
            level: "error",
            message: `Job moved to dead letter queue after ${newAttemptCount} attempts: ${errorMessage}`,
          },
        }),
        ...logBuffer.map((entry) =>
          prisma.jobLog.create({
            data: {
              executionId: execution.id,
              level: entry.level,
              message: entry.message,
            },
          })
        ),
      ]);

      await publishTransition({
        event: "job:transition",
        jobId,
        status: "dead_letter",
        queueId: job.queueId,
        timestamp: new Date().toISOString(),
      });
    }
  }
}
