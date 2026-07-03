/**
 * send_email.ts
 * -------------
 * Stub email handler. In production this would call an email provider
 * (Resend, SendGrid, SES, etc.). For now it logs the intent and sleeps
 * 500ms to simulate the network round-trip.
 *
 * Expected payload shape:
 *   { to: string; subject: string; body?: string }
 */

interface SendEmailPayload {
  to: string;
  subject: string;
  body?: string;
}

function isSendEmailPayload(p: unknown): p is SendEmailPayload {
  return (
    typeof p === "object" &&
    p !== null &&
    "to" in p &&
    typeof (p as Record<string, unknown>).to === "string" &&
    "subject" in p &&
    typeof (p as Record<string, unknown>).subject === "string"
  );
}

export async function sendEmailHandler(
  payload: unknown,
  log: (level: string, msg: string) => void
): Promise<void> {
  if (!isSendEmailPayload(payload)) {
    throw new Error(
      `send_email handler requires payload.to and payload.subject, got: ${JSON.stringify(payload)}`
    );
  }

  const { to, subject, body } = payload;

  log(
    "info",
    `Would send email to "${to}" — Subject: "${subject}"` +
      (body ? ` — Body length: ${body.length} chars` : "")
  );

  // Simulate email provider latency
  await new Promise<void>((resolve) => setTimeout(resolve, 500));

  log("info", `Email stub completed for recipient: ${to}`);
}
