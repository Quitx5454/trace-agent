import { z } from "zod";
import { ethers } from "ethers";
import { createAgentApp } from "@lucid-agents/express";
import { createAgent } from "@lucid-agents/core";
import { http } from "@lucid-agents/http";
import { payments, paymentsFromEnv } from "@lucid-agents/payments";
import { wallets } from "@lucid-agents/wallet";
import { identity, identityFromEnv } from "@lucid-agents/identity";
import { paymentMiddleware } from "@x402/express";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { getAuthHeaders } from "@coinbase/cdp-sdk/auth";
import { forge, type ForgeInput, AGENT_REGISTRY_ADDRESS } from "./forge";
import { processTrace, type TraceInput } from "./trace";
import { parseEnvelope, wrapResponse, withEnvelope } from "./envelope";

const CHAIN_ID = parseInt(process.env.CHAIN_ID ?? "8453"); // Base Mainnet
const RPC_URL = process.env.RPC_URL ?? "https://mainnet.base.org";

// Resolve the agent wallet private key (PRIVATE_KEY is the canonical name;
// the *_WALLET_PRIVATE_KEY variants are kept for parity with sibling agents).
const RAW_PK =
  process.env.PRIVATE_KEY ??
  process.env.AGENT_WALLET_PRIVATE_KEY ??
  process.env.DEVELOPER_WALLET_PRIVATE_KEY;
const PK = RAW_PK ? (RAW_PK.startsWith("0x") ? RAW_PK : `0x${RAW_PK}`) : undefined;
const AGENT_ADDRESS = PK ? new ethers.Wallet(PK).address : undefined;

const agent = await createAgent({
  name: process.env.AGENT_NAME ?? "forge",
  version: process.env.AGENT_VERSION ?? "0.1.0",
  description:
    process.env.AGENT_DESCRIPTION ??
    "Generates ERC-8004 on-chain feedback payloads: canonical feedback JSON, keccak-256 hash, IPFS pin, and ABI-encoded giveFeedback() calldata ready to sign",
})
  .use(http())
  .use(
    wallets({
      config: (() => {
        if (!PK) return undefined;
        const walletCfg = {
          type: "local" as const,
          privateKey: PK,
          walletClient: {
            rpcUrl: RPC_URL,
            chainId: CHAIN_ID,
          },
        };
        return { agent: walletCfg, developer: walletCfg };
      })(),
    }),
  )
  .use(payments({ config: paymentsFromEnv() }))
  .use(
    identity({
      config: {
        ...identityFromEnv(),
        // ERC-8004 trust config passed manually (bypasses a wallet-connector
        // EIP-1559 bug). Points at the Base-Mainnet Identity/Agent registry.
        trust:
          process.env.AGENT_ID && AGENT_ADDRESS
            ? {
                registrations: [
                  {
                    agentId: process.env.AGENT_ID,
                    agentRegistry: `eip155:${CHAIN_ID}:${AGENT_REGISTRY_ADDRESS}`,
                    agentAddress: `eip155:${CHAIN_ID}:${AGENT_ADDRESS}`,
                    agentURI: `https://${process.env.AGENT_DOMAIN ?? "forge-agent-production.up.railway.app"}/.well-known/agent-registration.json`,
                  },
                ],
                trustModels: ["feedback", "inference-validation"],
              }
            : undefined,
      },
    }),
  )
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// NOTE: CORS is handled by the wrapper Express app in src/index.ts so it runs
// before this agent app's x402 payment middleware (and OPTIONS preflights).
// The public A2A card routes (/.well-known/agent-card.json for Forge and
// /.well-known/trace-agent-card.json for Trace) are also served from the
// wrapper, since agent-card.json must take precedence over the manifest that
// createAgentApp() registers internally at that same path.

// ── x402 payment wall — declared BEFORE addEntrypoint ─────────
const CDP_HOST = "api.cdp.coinbase.com";
const CDP_BASE = "/platform/v2/x402";
const cdpKeyId = process.env.CDP_API_KEY_ID!;
const cdpKeySecret = process.env.CDP_API_KEY_SECRET!;

const facilitator = new HTTPFacilitatorClient({
  url: `https://${CDP_HOST}${CDP_BASE}`,
  createAuthHeaders: async () => {
    const [verify, settle, supported] = await Promise.all([
      getAuthHeaders({ apiKeyId: cdpKeyId, apiKeySecret: cdpKeySecret, requestMethod: "POST", requestHost: CDP_HOST, requestPath: `${CDP_BASE}/verify` }),
      getAuthHeaders({ apiKeyId: cdpKeyId, apiKeySecret: cdpKeySecret, requestMethod: "POST", requestHost: CDP_HOST, requestPath: `${CDP_BASE}/settle` }),
      getAuthHeaders({ apiKeyId: cdpKeyId, apiKeySecret: cdpKeySecret, requestMethod: "GET",  requestHost: CDP_HOST, requestPath: `${CDP_BASE}/supported` }),
    ]);
    return {
      verify:    { Authorization: verify.Authorization },
      settle:    { Authorization: settle.Authorization },
      supported: { Authorization: supported.Authorization },
    };
  },
});
const resourceServer = new x402ResourceServer(facilitator);
registerExactEvmScheme(resourceServer);
// x402 Bazaar discovery extension — registered explicitly BEFORE the payment
// middleware so the CDP facilitator indexes both endpoints (forge + trace) into
// the Bazaar catalog. Per-route schemas are declared in each route's
// `extensions` block below (declareDiscoveryExtension).
resourceServer.registerExtension(bazaarResourceServerExtension);

// Decode PAYMENT-REQUIRED header into the body so crawlers like xgate can
// read resource / accepts[].maxAmountRequired / description from JSON.
app.use((_req: any, res: any, next: any) => {
  const origJson = res.json.bind(res);
  res.json = function (body: any) {
    if (res.statusCode === 402 && (!body || Object.keys(body).length === 0)) {
      const header = (res.getHeader("PAYMENT-REQUIRED") ?? res.getHeader("payment-required")) as string | undefined;
      if (header) {
        try {
          const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
          const resourceUrl: string = typeof decoded.resource === "string"
            ? decoded.resource
            : decoded.resource?.url ?? "";
          const resourceDesc: string = decoded.resource?.description ?? "";
          const xgateBody = {
            x402Version: decoded.x402Version,
            resource: resourceUrl,
            accepts: (decoded.accepts ?? []).map((a: any) => ({
              scheme: a.scheme,
              network: a.network,
              asset: a.asset,
              payTo: a.payTo,
              maxAmountRequired: a.amount ?? a.maxAmountRequired,
              maxTimeoutSeconds: a.maxTimeoutSeconds,
              resource: resourceUrl,
              description: resourceDesc,
              mimeType: a.mimeType ?? "",
              extra: a.extra,
              input: { method: "POST", type: "http", bodyType: "json" },
            })),
          };
          return origJson(xgateBody);
        } catch {}
      }
    }
    return origJson(body);
  };
  next();
});

app.use(paymentMiddleware({
  "/entrypoints/forge/invoke": {
    accepts: [{
      scheme: "exact",
      price: "$0.02",
      network: "eip155:8453",
      payTo: process.env.PAYMENTS_RECEIVABLE_ADDRESS as `0x${string}`,
    }],
    description: "Generate an ERC-8004 on-chain feedback payload (hash + IPFS + giveFeedback calldata)",
    extensions: declareDiscoveryExtension({
      bodyType: "json",
      input: {
        agent_id: "6482",
        chain_id: 8453,
        task: "blockchain data cleaning",
        response_latency_ms: 1200,
        usdc_paid: "20000",
        tx_hash: "0xabc0000000000000000000000000000000000000000000000000000000000000",
        success: true,
        score: 95,
      },
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          agent_id: { type: ["string", "number"], description: "Numeric ERC-8004 agent id" },
          chain_id: { type: "number" },
          task: { type: "string" },
          response_latency_ms: { type: "number" },
          usdc_paid: { type: "string", description: "Amount in USDC base units (6 decimals)" },
          tx_hash: { type: "string" },
          success: { type: "boolean" },
          score: { type: "number", minimum: 0, maximum: 100 },
        },
        required: ["agent_id", "task", "tx_hash", "score"],
        additionalProperties: true,
      },
      output: {
        example: {
          feedback_hash: "0x9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a",
          ipfs_uri: "ipfs://QmExampleFeedbackDocumentHashHere000000000000000000",
          contract_payload: "0xabcdef00",
          ready_to_sign: true,
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            feedback_hash: { type: "string", description: "keccak-256 of the canonical feedback JSON" },
            ipfs_uri: { type: "string" },
            contract_payload: { type: "string", description: "ABI-encoded giveFeedback() calldata" },
            ready_to_sign: { type: "boolean" },
          },
          required: ["feedback_hash", "ipfs_uri", "contract_payload", "ready_to_sign"],
        },
      },
    }),
  },
  "/entrypoints/trace/invoke": {
    accepts: [{
      scheme: "exact",
      price: "$0.01",
      network: "eip155:8453",
      payTo: process.env.PAYMENTS_RECEIVABLE_ADDRESS as `0x${string}`,
    }],
    description: "Parse a raw agent execution log into structured steps + a forge_ready block (suggested score & tags)",
    extensions: declareDiscoveryExtension({
      bodyType: "json",
      input: {
        log: "[2026-06-03T10:00:00Z] step 1: fetch data (320ms)\n[2026-06-03T10:00:01Z] step 2: clean data (180ms)\n[2026-06-03T10:00:02Z] done",
        format: "auto",
        session_id: "8f0c2b1a-1234-4abc-9def-000000000000",
        agent_id: "6482",
      },
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          log: { type: "string", description: "Raw agent execution log" },
          format: { type: "string", enum: ["auto", "plaintext", "json", "opentelemetry", "langchain", "openai"] },
          session_id: { type: "string" },
          agent_id: { type: "string" },
        },
        required: ["log"],
        additionalProperties: true,
      },
      output: {
        example: {
          session_id: "8f0c2b1a-1234-4abc-9def-000000000000",
          agent_id: "6482",
          steps: [
            { index: 1, name: "fetch data", duration_ms: 320, status: "ok" },
            { index: 2, name: "clean data", duration_ms: 180, status: "ok" },
          ],
          summary: {
            total_steps: 2,
            total_duration_ms: 500,
            total_tokens: 0,
            total_cost_usdc: 0.02,
            errors: [],
            retries: 0,
            status: "completed",
          },
          forge_ready: {
            can_submit: true,
            suggested_score: 95,
            suggested_tag1: "x402_execution",
            suggested_tag2: "execution_success",
          },
          processed_at: "2026-06-03T10:00:03Z",
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            session_id: { type: "string" },
            agent_id: { type: "string" },
            steps: { type: "array", items: { type: "object", additionalProperties: true } },
            summary: {
              type: "object",
              properties: {
                total_steps: { type: "integer" },
                total_duration_ms: { type: "integer" },
                total_tokens: { type: "integer" },
                total_cost_usdc: { type: "number" },
                errors: { type: "array", items: { type: "string" } },
                retries: { type: "integer" },
                status: { type: "string", enum: ["completed", "failed", "partial"] },
              },
              required: ["total_steps", "total_duration_ms", "status"],
            },
            forge_ready: {
              type: "object",
              properties: {
                can_submit: { type: "boolean" },
                suggested_score: { type: "number" },
                suggested_tag1: { type: "string" },
                suggested_tag2: { type: "string" },
              },
              required: ["can_submit", "suggested_score"],
            },
            processed_at: { type: "string" },
          },
          required: ["session_id", "agent_id", "steps", "summary", "forge_ready", "processed_at"],
        },
      },
    }),
  },
}, resourceServer));

// ── Forge entrypoint ──────────────────────────────────────────
// Input is validated inside forge() so we can return ERC-8004-specific
// error messages; the zod schema here only enforces the JSON shape.
const inputSchema = z.object({
  agent_id: z.union([z.string(), z.number()]),
  chain_id: z.number().optional(),
  task: z.string(),
  response_latency_ms: z.number().optional(),
  usdc_paid: z.string().optional(),
  tx_hash: z.string(),
  success: z.boolean().optional(),
  score: z.number(),
}).passthrough();

addEntrypoint({
  key: "forge",
  description: "Produce an ERC-8004 feedback document, its keccak-256 hash, an IPFS pin, and ABI-encoded giveFeedback() calldata",
  // Accept either the Distill envelope ({ ..., payload: <ForgeInput> }) or the
  // legacy bare ForgeInput. The handler unwraps via parseEnvelope.
  input: withEnvelope(inputSchema),
  handler: async (ctx) => {
    const { payload, sessionId, agentId } = parseEnvelope<ForgeInput>(ctx.input);
    const clientAddress = process.env.PAYMENTS_RECEIVABLE_ADDRESS ?? "";
    const output = await forge(payload, clientAddress);
    return { output: wrapResponse(output, sessionId, agentId, "ok") };
  },
});

// ── Trace entrypoint ──────────────────────────────────────────
// An empty/whitespace log is rejected here as a 400 (invalid_input);
// deeper parsing + the failed-output fallback live in processTrace().
const traceInputSchema = z.object({
  log: z.string().refine((v) => v.trim().length > 0, { message: "log is required and cannot be empty" }),
  format: z.enum(["auto", "plaintext", "json", "opentelemetry", "langchain", "openai"]).optional(),
  session_id: z.string().optional(),
  agent_id: z.string().optional(),
}).passthrough();

addEntrypoint({
  key: "trace",
  description: "Normalize a raw agent execution log into structured steps + summary, and emit a forge_ready block (suggested ERC-8004 score & tags)",
  // Accept either the Distill envelope ({ ..., payload: <TraceInput> }) or the
  // legacy bare TraceInput. The handler unwraps via parseEnvelope.
  input: withEnvelope(traceInputSchema),
  handler: async (ctx) => {
    const { payload, sessionId, agentId } = parseEnvelope<TraceInput>(ctx.input);
    const output = await processTrace(payload);
    return { output: wrapResponse(output, sessionId, agentId, "ok") };
  },
});

export { app };
