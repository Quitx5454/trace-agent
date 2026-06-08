# Trace

**Agent execution log normalizer** — middleware for the agent economy.

Trace takes a raw agent execution log and returns structured, machine-readable
JSON, without ever holding keys or sending transactions:

1. ordered, typed **execution steps** (name, duration, status)
2. a roll-up **summary** (total steps, duration, tokens, cost, errors, retries, status)
3. a **`forge_ready`** block — a suggested ERC-8004 reputation score + tags, ready
   to feed into an on-chain feedback flow

> Note: this service was previously the **Forge** agent. Forge has been
> deprecated and removed (pre-TM2); the deployment now serves **Trace** only.

## Stack

Bun · Lucid Agents · x402 v2 · Coinbase CDP facilitator · Express · ethers v6

- **Network:** Base Mainnet (`eip155:8453`)
- **Price:** 0.01 USDC / call (x402 paywall)
- **Identity registry:** `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`

## Endpoint

```
POST /entrypoints/trace/invoke
Content-Type: application/json
```

### Input

```json
{
  "log": "raw log string",
  "format": "auto",
  "session_id": "optional-uuid",
  "agent_id": "6482"
}
```

| field        | required | notes                                                              |
| ------------ | -------- | ------------------------------------------------------------------ |
| `log`        | ✅       | non-empty raw execution log                                        |
| `format`     |          | `auto` · `plaintext` · `json` · `opentelemetry` · `langchain` · `openai` |
| `session_id` |          | generated if omitted                                               |
| `agent_id`   |          | numeric ERC-8004 agent id                                          |

**Parse strategy:** OpenTelemetry / LangChain / OpenAI logs are parsed
rule-based (fast, zero cost); `plaintext` / `json` fall back to Claude Haiku.
Logs over 100KB are auto-chunked and processed in parallel.

### Output

```json
{
  "session_id": "...",
  "agent_id": "6482",
  "steps": [...],
  "summary": {
    "total_steps": 5,
    "total_duration_ms": 2860,
    "total_tokens": 3650,
    "total_cost_usdc": 0.02,
    "errors": [],
    "retries": 1,
    "status": "completed"
  },
  "forge_ready": {
    "can_submit": true,
    "suggested_score": 90,
    "suggested_tag1": "x402_execution",
    "suggested_tag2": "execution_success"
  },
  "processed_at": "2026-06-03T10:00:03Z"
}
```

The suggested score is `100 − (25 × errors) − (5 × retries) − (10 if avg step > 3000ms)`,
clamped to `0–100`.

## Distill Standard Envelope

Every agent in the Distill ecosystem accepts an **optional** standard envelope on input and **always** returns the standard envelope on output. It is fully backward compatible: existing (legacy) requests keep working unchanged.

### Input — envelope mode

Wrap your normal input in `payload`:

```json
{
  "distill_version": "1.0",
  "agent_id": "6482",
  "session_id": "test-session-001",
  "payload": {
    "log": "raw log string",
    "format": "auto"
  }
}
```

`distill_version`, `agent_id`, and `session_id` are all optional. If `session_id` is omitted, a UUID is generated for you (`crypto.randomUUID()`).

### Input — legacy mode (backward compatible)

Send your input directly, with no wrapper — exactly as before:

```json
{
  "log": "raw log string",
  "format": "auto"
}
```

### Output — always enveloped

Both input modes produce the same envelope response:

```json
{
  "distill_version": "1.0",
  "agent_id": "6482",
  "session_id": "test-session-001",
  "status": "ok",
  "output": {
    "session_id": "...",
    "agent_id": "6482",
    "steps": [...],
    "summary": { ... },
    "forge_ready": { ... },
    "processed_at": "2026-06-03T10:00:03Z"
  },
  "processed_at": "2026-06-02T16:21:11.827Z"
}
```

| field          | notes                                                |
| -------------- | ---------------------------------------------------- |
| `status`       | `"ok"` or `"error"`                                  |
| `agent_id`     | echoed from the request, or `null` in legacy mode    |
| `session_id`   | from the request, or a generated UUID                |
| `output`       | the agent's normal output (trace result)             |
| `processed_at` | ISO 8601 timestamp                                   |

> The Lucid runtime nests this envelope under the top-level `output` field of its HTTP response: `{ "run_id": "...", "status": "succeeded", "output": { ...envelope... } }`.

The envelope helpers live in `src/lib/envelope.ts` (`parseEnvelope`, `wrapResponse`, `withEnvelope`). Run `bun run test-envelope.ts` to exercise the entrypoint in both modes.

## Develop

```bash
bun install
cp .env.example .env   # fill in secrets
bun run dev            # watch mode on PORT (default 8787)
```

Smoke-test the core pipeline (no payment required):

```bash
bun run test-trace
```

## Deploy (Railway)

Set these environment variables:

```
ANTHROPIC_API_KEY=...
CDP_API_KEY_ID=...
CDP_API_KEY_SECRET=...
PRIVATE_KEY=...
PAYMENTS_RECEIVABLE_ADDRESS=0x104b5768FE505c400dd98F447665CB5c6fca388A
FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
NETWORK=base
REGISTER_IDENTITY=true
AGENT_ID=6482
```

## Discovery — x402 Bazaar + A2A Agent Card

This service is discoverable two ways:

- **x402 Bazaar** — the server registers `bazaarResourceServerExtension` (from `@x402/extensions`) on the resource server *before* the payment middleware, and the `/entrypoints/trace/invoke` route declares its input/output examples + JSON Schema via `declareDiscoveryExtension({ bodyType: "json", ... })`. That discovery metadata rides in the `PAYMENT-REQUIRED` header of every `402` challenge, so the CDP facilitator indexes it into the [x402 Bazaar](https://docs.cdp.coinbase.com) catalog after a settled payment. (The discovery extension lives in the **header**, not the JSON body — the body is reshaped for crawlers like xgate.)
- **A2A Agent Card** — a full, static [A2A](https://a2a-protocol.org) Agent Card is served at [`/.well-known/agent-card.json`](https://trace-agent-production.up.railway.app/.well-known/agent-card.json) (also mirrored at [`/.well-known/trace-agent-card.json`](https://trace-agent-production.up.railway.app/.well-known/trace-agent-card.json)) — public, no paywall — with skills, `securitySchemes`, x402 payment metadata, and the ERC-8004 registration (agentId `6482`).

The MCP Gateway also exposes this as the `trace` tool — see the [MCP Gateway docs](https://quitx5454.github.io/pulse/docs/mcp-gateway.html).

## Part of Distill

This agent is part of the **Distill** middleware suite (Refine · Shield · Trace).
