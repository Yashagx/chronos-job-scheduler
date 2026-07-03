/**
 * echo.ts
 * -------
 * Demo handler: echoes the payload back and sleeps 1-3 seconds.
 * The artificial sleep gives time to observe the "running" state in the
 * Chronos dashboard before the job transitions to "completed".
 */

export async function echoHandler(
  payload: unknown,
  log: (level: string, msg: string) => void
): Promise<void> {
  log("info", `Echo handler received payload: ${JSON.stringify(payload)}`);

  // Random sleep between 1 and 3 seconds to simulate real work
  const sleepMs = 1000 + Math.floor(Math.random() * 2000);
  log("debug", `Sleeping ${sleepMs}ms to simulate work`);

  await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));

  log("info", `Echo complete — returned payload as-is`);
}
