// Local test for the Distill Standard Envelope (bypasses the x402 paywall).
//   bun run test-envelope.ts
//
// Mirrors both entrypoint handlers exactly: parseEnvelope -> forge/processTrace
// -> wrapResponse. Verifies envelope mode + legacy (backward-compat) mode for
// the forge AND trace entrypoints. Runs the real pipelines, so ANTHROPIC_API_KEY
// (trace) and PINATA_JWT (forge IPFS pin) should be set (Bun loads .env).
import { parseEnvelope, wrapResponse, type DistillResponse } from "./src/lib/envelope";
import { forge, type ForgeInput } from "./src/lib/forge";
import { processTrace, type TraceInput } from "./src/lib/trace";

const clientAddress = process.env.PAYMENTS_RECEIVABLE_ADDRESS ?? "0x104b5768FE505c400dd98F447665CB5c6fca388A";

const FORGE_INPUT: ForgeInput = {
  agent_id: "6482",
  chain_id: 8453,
  task: "blockchain data cleaning",
  response_latency_ms: 1200,
  usdc_paid: "20000",
  tx_hash: "0xabc0000000000000000000000000000000000000000000000000000000000def",
  success: true,
  score: 95,
};

const TRACE_INPUT: TraceInput = {
  log: "[2026-06-02 10:00:01] fetch_data completed in 340ms. Tokens: 1200. USDC: 0.02. Status: OK",
};

async function runForge(raw: unknown): Promise<DistillResponse> {
  const { payload, sessionId, agentId } = parseEnvelope<ForgeInput>(raw);
  const output = await forge(payload, clientAddress);
  return wrapResponse(output, sessionId, agentId, "ok");
}

async function runTrace(raw: unknown): Promise<DistillResponse> {
  const { payload, sessionId, agentId } = parseEnvelope<TraceInput>(raw);
  const output = await processTrace(payload);
  return wrapResponse(output, sessionId, agentId, "ok");
}

function assert(cond: boolean, msg: string) {
  console.log(`${cond ? "✅" : "❌"} ${msg}`);
  if (!cond) process.exitCode = 1;
}

function checkEnvelopeResponse(res: DistillResponse, label: string, expectSession: string | null, expectAgent: string | null) {
  assert(res.distill_version === "1.0", `${label}: distill_version === '1.0'`);
  if (expectSession) assert(res.session_id === expectSession, `${label}: session_id preserved`);
  else assert(typeof res.session_id === "string" && res.session_id.length >= 32, `${label}: session_id auto-generated (UUID)`);
  assert(res.agent_id === expectAgent, `${label}: agent_id === ${JSON.stringify(expectAgent)}`);
  assert(res.status === "ok", `${label}: status === 'ok'`);
  assert(typeof res.processed_at === "string" && !isNaN(Date.parse(res.processed_at)), `${label}: processed_at is ISO timestamp`);
  assert(res.output !== undefined, `${label}: output present`);
}

// ── FORGE — Scenario 1: Envelope ──────────────────────────────────
console.log("\n── FORGE · Envelope mode ─────────────────────────");
const fEnv = { distill_version: "1.0", agent_id: "6482", session_id: "test-session-001", payload: FORGE_INPUT };
const fParsed = parseEnvelope<ForgeInput>(fEnv);
assert(fParsed.isEnvelope && JSON.stringify(fParsed.payload) === JSON.stringify(FORGE_INPUT), "forge: payload unwrapped");
checkEnvelopeResponse(await runForge(fEnv), "forge envelope", "test-session-001", "6482");

// ── FORGE — Scenario 2: Legacy ────────────────────────────────────
console.log("\n── FORGE · Legacy mode ───────────────────────────");
checkEnvelopeResponse(await runForge(FORGE_INPUT), "forge legacy", null, null);

// ── TRACE — Scenario 1: Envelope ──────────────────────────────────
console.log("\n── TRACE · Envelope mode ─────────────────────────");
const tEnv = { distill_version: "1.0", agent_id: "6482", session_id: "test-session-001", payload: TRACE_INPUT };
const tParsed = parseEnvelope<TraceInput>(tEnv);
assert(tParsed.isEnvelope && (tParsed.payload as TraceInput).log === TRACE_INPUT.log, "trace: payload unwrapped");
checkEnvelopeResponse(await runTrace(tEnv), "trace envelope", "test-session-001", "6482");

// ── TRACE — Scenario 2: Legacy ────────────────────────────────────
console.log("\n── TRACE · Legacy mode ───────────────────────────");
checkEnvelopeResponse(await runTrace(TRACE_INPUT), "trace legacy", null, null);

console.log(process.exitCode ? "\n❌ SOME CHECKS FAILED" : "\n✅ ALL CHECKS PASSED");
