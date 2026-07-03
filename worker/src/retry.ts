/**
 * retry.ts
 * --------
 * Calculates the retry delay in milliseconds based on the configured strategy.
 * All three strategies cap at maxDelayMs.
 *
 * Strategies:
 *  - fixed:       constant delay every attempt
 *  - linear:      delay grows linearly with attempt number
 *  - exponential: delay doubles each attempt with ±10% jitter to prevent thundering herd
 */

export type RetryStrategy = "fixed" | "linear" | "exponential";

/**
 * @param strategy    - Which strategy to apply
 * @param baseDelayMs - Base delay in milliseconds (from RetryPolicy)
 * @param maxDelayMs  - Hard ceiling on the delay (from RetryPolicy)
 * @param attemptCount - The current attempt number (1-indexed after first failure)
 * @returns Delay in milliseconds before the next attempt
 */
export function calculateDelay(
  strategy: RetryStrategy,
  baseDelayMs: number,
  maxDelayMs: number,
  attemptCount: number
): number {
  switch (strategy) {
    case "fixed": {
      return Math.min(baseDelayMs, maxDelayMs);
    }

    case "linear": {
      return Math.min(baseDelayMs * attemptCount, maxDelayMs);
    }

    case "exponential": {
      // jitter: up to 10% of baseDelayMs to spread retries across workers
      const jitter = Math.floor(Math.random() * baseDelayMs * 0.1);
      const raw = baseDelayMs * Math.pow(2, attemptCount) + jitter;
      return Math.min(raw, maxDelayMs);
    }

    default: {
      // Exhaustive check — TypeScript will warn if a case is missed
      const _exhaustive: never = strategy;
      throw new Error(`Unknown retry strategy: ${_exhaustive as string}`);
    }
  }
}
