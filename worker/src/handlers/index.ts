/**
 * handlers/index.ts
 * -----------------
 * Central handler registry. Maps job `type` strings to async handler
 * functions. The executor imports `getHandler` to dispatch jobs.
 *
 * Adding a new handler:
 *  1. Create handlers/<name>.ts exporting an async function matching `Handler`
 *  2. Import it here and register it in the `handlers` map
 */

import { echoHandler } from "./echo";
import { httpRequestHandler } from "./http_request";
import { sendEmailHandler } from "./send_email";

export type HandlerLogFn = (level: string, msg: string) => void;

export type Handler = (
  payload: unknown,
  log: HandlerLogFn
) => Promise<void>;

const handlers: Record<string, Handler> = {
  echo: echoHandler,
  http_request: httpRequestHandler,
  send_email: sendEmailHandler,
};

/**
 * Retrieves a handler for the given job type.
 * Throws if no handler is registered for that type.
 */
export function getHandler(type: string): Handler {
  const handler = handlers[type];
  if (!handler) {
    throw new Error(
      `No handler registered for job type "${type}". ` +
        `Registered types: [${Object.keys(handlers).join(", ")}]`
    );
  }
  return handler;
}

/** Returns all registered job type names (useful for logging). */
export function listHandlerTypes(): string[] {
  return Object.keys(handlers);
}
