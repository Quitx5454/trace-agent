// ── Distill Standard Envelope ─────────────────────────────────────────────
// Shared wrapper used by every agent in the Distill ecosystem. The envelope is
// OPT-IN on input: a request may wrap its normal input in a `payload` field
// (envelope mode) or send the bare input as before (legacy mode). The response
// is ALWAYS emitted in the standard envelope shape so callers get a uniform,
// session-tagged result regardless of which input mode they used.
import { z } from "zod";

export const DISTILL_VERSION = "1.0";

// Inbound wrapper. Every field except `payload` is optional; `session_id`
// defaults to a fresh UUID when omitted.
export interface DistillEnvelope<T = unknown> {
  distill_version?: string;
  agent_id?: string;
  session_id?: string;
  payload: T;
}

// Outbound wrapper. Always returned by an agent, in both input modes.
export interface DistillResponse<O = unknown> {
  distill_version: string;
  agent_id: string | null;
  session_id: string;
  status: "ok" | "error";
  output: O;
  processed_at: string;
}

// Result of normalizing a raw request body into payload + envelope metadata.
export interface ParsedEnvelope<T = unknown> {
  // true when the caller used the `payload` wrapper, false for legacy input.
  isEnvelope: boolean;
  // The actual agent input (unwrapped from `payload`, or the body itself).
  payload: T;
  // Resolved session id — the caller's, or a freshly generated UUID.
  sessionId: string;
  // The caller's agent id, or null when not supplied.
  agentId: string | null;
  // The caller's declared protocol version, defaulting to DISTILL_VERSION.
  distillVersion: string;
}

// A body is in envelope mode when it is an object carrying a defined `payload`.
export function isEnvelope(body: unknown): body is DistillEnvelope {
  return (
    typeof body === "object" &&
    body !== null &&
    "payload" in body &&
    (body as Record<string, unknown>).payload !== undefined
  );
}

// Normalize a raw request body (the value of the entrypoint `input`) into a
// payload plus envelope metadata. Works for both envelope and legacy bodies.
export function parseEnvelope<T = unknown>(body: unknown): ParsedEnvelope<T> {
  if (isEnvelope(body)) {
    const env = body as DistillEnvelope<T> & {
      agent_id?: string | number;
    };
    const sessionId =
      typeof env.session_id === "string" && env.session_id.length > 0
        ? env.session_id
        : crypto.randomUUID();
    const agentId =
      env.agent_id === undefined || env.agent_id === null
        ? null
        : String(env.agent_id);
    return {
      isEnvelope: true,
      payload: env.payload,
      sessionId,
      agentId,
      distillVersion:
        typeof env.distill_version === "string"
          ? env.distill_version
          : DISTILL_VERSION,
    };
  }

  // Legacy mode: the body IS the payload. Still gets a session id so the
  // response is a well-formed envelope.
  return {
    isEnvelope: false,
    payload: body as T,
    sessionId: crypto.randomUUID(),
    agentId: null,
    distillVersion: DISTILL_VERSION,
  };
}

// Build the standard outbound envelope around an agent's output.
export function wrapResponse<O>(
  output: O,
  sessionId: string,
  agentId: string | null = null,
  status: "ok" | "error" = "ok",
): DistillResponse<O> {
  return {
    distill_version: DISTILL_VERSION,
    agent_id: agentId,
    session_id: sessionId,
    status,
    output,
    processed_at: new Date().toISOString(),
  };
}

// Wrap an entrypoint's input schema so it accepts EITHER the envelope form
// ({ distill_version?, agent_id?, session_id?, payload: <T> }) OR the legacy
// bare input <T>. The handler then calls parseEnvelope() to unwrap. Keeping the
// original payload schema inside the envelope preserves existing validation
// (and its 400s) for both modes.
export function withEnvelope<S extends z.ZodTypeAny>(payloadSchema: S) {
  const envelopeShape = z.object({
    distill_version: z.string().optional(),
    agent_id: z.union([z.string(), z.number()]).optional(),
    session_id: z.string().optional(),
    payload: payloadSchema,
  });
  return z.union([envelopeShape, payloadSchema]);
}
