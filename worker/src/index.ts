/**
 * index.ts
 * --------
 * Worker service entry point. Responsibilities:
 *
 *  1. Self-register in the `workers` table with hostname, pid, status=active
 *  2. Start the heartbeat writer (keeps the DB row alive)
 *  3. Start the reaper (detects and recovers dead siblings)
 *  4. Start the scheduler (materializes cron jobs)
 *  5. Start the poller (claim & execute jobs)
 *  6. Handle SIGTERM / SIGINT for graceful shutdown:
 *       - Stop the poller loop
 *       - Mark self as "draining"
 *       - Wait up to 30 s for in-flight jobs
 *       - Mark self as "dead"
 *       - Disconnect cleanly
 *       - Exit 0
 */

import * as os from "os";
import { prisma } from "./lib/prisma";
import { redis } from "./lib/redis";
import { logger } from "./lib/logger";
import { startHeartbeatWriter, startReaper } from "./heartbeat";
import { startScheduler } from "./scheduler";
import { startPoller, stopPoller, waitForInFlight } from "./poller";
import { listHandlerTypes } from "./handlers";

// -- Env validation -----------------------------------------------------------
const REQUIRED_ENV = ["DATABASE_URL", "REDIS_URL"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    logger.error({ key }, `Required environment variable is missing`);
    process.exit(1);
  }
}

let workerId: string | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;
let reaperInterval: NodeJS.Timeout | null = null;
let shuttingDown = false;

// -- Graceful shutdown logic --------------------------------------------------
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // Prevent double-execution
  shuttingDown = true;

  logger.info({ signal }, "Shutdown signal received — beginning graceful shutdown");

  // 1. Stop accepting new jobs
  stopPoller();

  // 2. Mark self as draining in DB
  if (workerId) {
    try {
      await prisma.worker.update({
        where: { id: workerId },
        data: { status: "draining" },
      });
      logger.info({ workerId }, "Worker marked as draining");
    } catch (err) {
      logger.error({ err }, "Failed to mark worker as draining");
    }
  }

  // 3. Wait for in-flight jobs (max 30 s)
  await waitForInFlight(30_000);

  // 4. Mark self as dead
  if (workerId) {
    try {
      await prisma.worker.update({
        where: { id: workerId },
        data: { status: "dead" },
      });
      logger.info({ workerId }, "Worker marked as dead");
    } catch (err) {
      logger.error({ err }, "Failed to mark worker as dead");
    }
  }

  // 5. Stop heartbeat and reaper intervals
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (reaperInterval) clearInterval(reaperInterval);

  // 6. Disconnect cleanly
  try {
    await prisma.$disconnect();
    logger.info("Prisma disconnected");
  } catch (err) {
    logger.error({ err }, "Prisma disconnect error");
  }

  try {
    redis.disconnect();
    logger.info("Redis disconnected");
  } catch (err) {
    logger.error({ err }, "Redis disconnect error");
  }

  logger.info("Shutdown complete");
  process.exit(0);
}

// -- Main ---------------------------------------------------------------------
async function main(): Promise<void> {
  const hostname = os.hostname();
  const pid = process.pid;

  logger.info(
    {
      hostname,
      pid,
      handlers: listHandlerTypes(),
      nodeVersion: process.version,
    },
    "Chronos Worker starting"
  );

  // -- Step 1: Register this worker instance ------------------------------
  let worker;
  try {
    worker = await prisma.worker.create({
      data: { hostname, pid, status: "active" },
    });
    workerId = worker.id;
    logger.info({ workerId, hostname, pid }, "Worker registered in DB");
  } catch (err) {
    logger.error({ err }, "Failed to register worker — exiting");
    process.exit(1);
  }

  // Register signal handlers AFTER we have a workerId
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT",  () => void shutdown("SIGINT"));

  // Catch unhandled promise rejections (belt-and-suspenders)
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled promise rejection");
  });

  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception — initiating emergency shutdown");
    void shutdown("uncaughtException");
  });

  // -- Step 2: Start heartbeat writer ------------------------------------
  heartbeatInterval = startHeartbeatWriter(workerId);
  logger.info("Heartbeat writer started");

  // -- Step 3: Start reaper ----------------------------------------------
  reaperInterval = startReaper();
  logger.info("Reaper started");

  // -- Step 4: Start scheduler -------------------------------------------
  try {
    await startScheduler();
    logger.info("Scheduler started");
  } catch (err) {
    logger.error({ err }, "Scheduler failed to start");
    // Non-fatal — worker can still process manually-enqueued jobs
  }

  // -- Step 5: Start poller (blocking loop) -----------------------------
  logger.info({ workerId }, "Worker fully started — polling for jobs");
  await startPoller(workerId);

  // startPoller resolves only when stopped (during graceful shutdown)
  logger.info("Poller stopped — finalizing shutdown");
}

// -- Bootstrap ----------------------------------------------------------------
main().catch((err) => {
  logger.fatal({ err }, "Fatal error in worker main — exiting");
  process.exit(1);
});
