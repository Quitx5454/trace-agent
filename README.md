# Forge

**ERC-8004 on-chain feedback payload generator** — middleware for the agent economy.

Forge takes an evaluation of an agent task and returns everything a client needs to
submit reputation feedback on-chain, without ever holding keys or sending transactions:

1. a canonical **ERC-8004 feedback JSON** document
2. its **keccak-256 hash** (`bytes32`)
3. the document **pinned to IPFS** (via Pinata)
4. **ABI-encoded calldata** for `ReputationRegistry.giveFeedback()`

The client signs and broadcasts the returned `contract_payload` themselves.

## Stack

Bun · Lucid Agents · x402 v2 · Coinbase CDP facilitator · Express · ethers v6

- **Network:** Base Mainnet (`eip155:8453`)
- **Price:** 0.02 USDC / call (x402 paywall)
- **Identity registry:** `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- **Reputation registry:** `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`

## Endpoint

```
POST /entrypoints/forge/invoke
Content-Type: application/json
```

### Input

```json
{
  "agent_id": "6482",
  "chain_id": 8453,
  "task": "blockchain data cleaning",
  "response_latency_ms": 1200,
  "usdc_paid": "20000",
  "tx_hash": "0xabc...",
  "success": true,
  "score": 95
}
```

| field                 | required | notes                          |
| --------------------- | -------- | ------------------------------ |
| `agent_id`            | ✅       | numeric                        |
| `score`               | ✅       | 0–100                          |
| `task`                | ✅       | non-empty                      |
| `tx_hash`             | ✅       |                                |
| `chain_id`            |          | defaults to `8453`             |
| `response_latency_ms` |          |                                |
| `usdc_paid`           |          | base units (string)            |
| `success`             |          | defaults to `false`            |

### Output

```json
{
  "feedback_hash": "0x...",
  "ipfs_uri": "ipfs://Qm...",
  "contract_payload": "0x...",
  "ready_to_sign": true
}
```

If the Pinata upload fails (or `PINATA_JWT` is unset), Forge returns
`ready_to_sign: false` with an `error` and the computed `feedback_hash`.

## Develop

```bash
bun install
cp .env.example .env   # fill in secrets
bun run dev            # watch mode on PORT (default 8787)
```

Smoke-test the core pipeline (no payment required):

```bash
bun run test-forge
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
PINATA_JWT=        # add once you have a Pinata JWT
```
