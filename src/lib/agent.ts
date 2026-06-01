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
import { getAuthHeaders } from "@coinbase/cdp-sdk/auth";
import { forge, type ForgeInput, AGENT_REGISTRY_ADDRESS } from "./forge";

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
  input: inputSchema,
  handler: async (ctx) => {
    const input = ctx.input as ForgeInput;
    const clientAddress = process.env.PAYMENTS_RECEIVABLE_ADDRESS ?? "";
    const output = await forge(input, clientAddress);
    return { output };
  },
});

export { app };
