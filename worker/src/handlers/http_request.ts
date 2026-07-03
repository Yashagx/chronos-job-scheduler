/**
 * http_request.ts
 * ---------------
 * Makes an HTTP GET request to `payload.url` using the built-in Node.js
 * `fetch` (available since Node 18). Logs the response status code and
 * the Content-Length header if present.
 *
 * Expected payload shape:
 *   { url: string; timeoutMs?: number }
 */

interface HttpRequestPayload {
  url: string;
  timeoutMs?: number;
}

function isHttpRequestPayload(p: unknown): p is HttpRequestPayload {
  return (
    typeof p === "object" &&
    p !== null &&
    "url" in p &&
    typeof (p as Record<string, unknown>).url === "string"
  );
}

export async function httpRequestHandler(
  payload: unknown,
  log: (level: string, msg: string) => void
): Promise<void> {
  if (!isHttpRequestPayload(payload)) {
    throw new Error(
      `http_request handler requires payload.url (string), got: ${JSON.stringify(payload)}`
    );
  }

  const { url, timeoutMs = 30_000 } = payload;

  log("info", `Making GET request to ${url}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": "Chronos-Worker/1.0" },
    });

    const contentLength = response.headers.get("content-length");

    log(
      response.ok ? "info" : "warn",
      `GET ${url} ? ${response.status} ${response.statusText}` +
        (contentLength ? ` (Content-Length: ${contentLength})` : "")
    );

    // Drain the body to release the socket
    await response.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("error", `GET ${url} failed: ${message}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
