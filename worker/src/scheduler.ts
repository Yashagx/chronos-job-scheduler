/**
 * scheduler.ts
 * ------------
 * Cron-definition materializer. Runs on a tight tick (every
 * WORKER_SCHEDULER_TICK_MS, default 5 s) and for each active
 * ScheduledJob whose next_run_at is in the past:
 *
 *  1. Creates a real `jobs` row from the definition's job_template
 *  2. Advances next_run_at using the cron expression
 *  3. Updates last_run_at
 *  4. Publishes a "job:created" event to Redis
 *
 * Uses the `croner` package to parse and advance cron expressions.
 * croner is fully compatible with standard 5-field cron syntax as well
 * as 6-field (with seconds) and Quartz-style expressions.
 */

import { Cron } from "croner";
import { prisma } from "./lib/prisma";
import { redis } from "./lib/redis";
import { logger } from "./lib/logger";

const SCHEDULER_TICK_MS =
  Number(process.env.WORKER_SCHEDULER_TICK_MS) || 5_000;

/** Shape of the JSON stored in ScheduledJob.jobTemplate */
interface JobTemplate {
  type: string;
  payload?: Record<string, unknown>;
  priority?: number;
  retryPolicyId?: string;
}

function isJobTemplate(v: unknown): v is JobTemplate {
  return (
    typeof v === "object" &&
    v !== null &&
    "type" in v &&
    typeof (v as Record<string, unknown>).type === "string"
  );
}

async function tick(): Promise<void> {
  // Find all active scheduled job definitions that are due
  let due;
  try {
    due = await prisma.scheduledJob.findMany({
      where: {
        isActive: true,
        nextRunAt: { lte: new Date() },
      },
    });
  } catch (err) {
    logger.error({ err }, "Scheduler tick failed during findMany");
    return;
  }

  if (due.length === 0) return;

  logger.info({ count: due.length }, "Scheduler tick: materializing jobs");

  for (const def of due) {
    const dlog = logger.child({ scheduledJobId: def.id, queueId: def.queueId });

    try {
      if (!isJobTemplate(def.jobTemplate)) {
        dlog.error(
          { jobTemplate: def.jobTemplate },
          "Invalid jobTemplate — skipping"
        );
        continue;
      }

      const template = def.jobTemplate;

      // Compute the NEXT run time before we do anything else
      // so that if cron parsing fails we skip without materializing a job
      const cron = new Cron(def.cronExpression);
      const nextRun = cron.nextRun();

      if (!nextRun) {
        dlog.warn(
          { cronExpression: def.cronExpression },
          "Cron expression has no future run — deactivating"
        );
        await prisma.scheduledJob.update({
          where: { id: def.id },
          data: { isActive: false },
        });
        continue;
      }

      // Materialize a new job row from the template
      const newJob = await prisma.job.create({
        data: {
          queueId: def.queueId,
          type: template.type,
          payload: template.payload ?? {},
          priority: template.priority ?? 0,
          retryPolicyId: template.retryPolicyId ?? null,
          status: "queued",
          runAt: new Date(),
        },
      });

      // Advance the scheduled job definition
      await prisma.scheduledJob.update({
        where: { id: def.id },
        data: {
          lastRunAt: new Date(),
          nextRunAt: nextRun,
        },
      });

      // Publish event so API can notify subscribers
      await redis.publish(
        "job:transitions",
        JSON.stringify({
          event: "job:created",
          jobId: newJob.id,
          queueId: def.queueId,
          scheduledJobId: def.id,
          timestamp: new Date().toISOString(),
        })
      );

      dlog.info(
        { newJobId: newJob.id, nextRunAt: nextRun.toISOString() },
        "Materialized job from scheduled definition"
      );
    } catch (err) {
      dlog.error({ err }, "Failed to materialize scheduled job");
    }
  }
}

/**
 * Starts the scheduler tick loop. Calls tick() immediately on start,
 * then every WORKER_SCHEDULER_TICK_MS milliseconds.
 */
export async function startScheduler(): Promise<void> {
  logger.info(
    { tickIntervalMs: SCHEDULER_TICK_MS },
    "Scheduler starting"
  );

  // Run immediately on startup
  await tick();

  setInterval(() => void tick(), SCHEDULER_TICK_MS);
}
