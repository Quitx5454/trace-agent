// ─────────────────────────────────────────────────────────────
// Forge — ERC-8004 on-chain feedback payload generator.
//
// Given an evaluation of an agent task, Forge produces everything a
// client needs to submit reputation feedback on-chain:
//   1. a canonical ERC-8004 feedback JSON document,
//   2. its keccak-256 hash (bytes32),
//   3. the document pinned to IPFS via Pinata,
//   4. ABI-encoded calldata for ReputationRegistry.giveFeedback().
// The client signs & broadcasts the returned calldata themselves —
// Forge never holds keys or sends transactions.
// ─────────────────────────────────────────────────────────────
import { ethers } from "ethers";
import stringify from "fast-json-stable-stringify";

// ERC-8004 registries on Base Mainnet (eip155:8453)
export const AGENT_REGISTRY_ADDRESS = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
export const REPUTATION_REGISTRY_ADDRESS = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";

// ABI for ReputationRegistry.giveFeedback() — the only method we encode.
const GIVE_FEEDBACK_ABI = [
  {
    name: "giveFeedback",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "endpoint", type: "string" },
      { name: "feedbackURI", type: "string" },
      { name: "feedbackHash", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

const reputationInterface = new ethers.Interface(GIVE_FEEDBACK_ABI as any);

export interface ForgeInput {
  agent_id: string | number;
  chain_id?: number;
  task: string;
  response_latency_ms?: number;
  usdc_paid?: string;
  tx_hash: string;
  success?: boolean;
  score: number;
}

export interface FeedbackJson {
  agentRegistry: string;
  agentId: number;
  clientAddress: string;
  createdAt: string;
  value: number;
  valueDecimals: number;
  reasoning: string;
  tag1: string;
  tag2: string;
  endpoint: string;
  metrics: {
    response_latency_ms: number;
    usdc_paid: string;
    tx_hash: string;
  };
}

export interface ForgeOutput {
  feedback_hash: string | null;
  ipfs_uri: string | null;
  contract_payload: string | null;
  ready_to_sign: boolean;
  error?: string;
}

// ── 1. INPUT VALIDATION ───────────────────────────────────────
// Returns an error message string, or null when the input is valid.
export function validateInput(input: any): string | null {
  if (input === null || typeof input !== "object") {
    return "Invalid input: expected a JSON object";
  }
  const agentId = input.agent_id;
  if (agentId === undefined || agentId === null || String(agentId).trim() === "") {
    return "agent_id is required";
  }
  if (!/^\d+$/.test(String(agentId).trim())) {
    return "agent_id must be numeric";
  }
  if (typeof input.score !== "number" || Number.isNaN(input.score)) {
    return "score must be a number";
  }
  if (input.score < 0 || input.score > 100) {
    return "score must be between 0 and 100";
  }
  if (typeof input.task !== "string" || input.task.trim() === "") {
    return "task cannot be empty";
  }
  if (input.tx_hash === undefined || input.tx_hash === null || String(input.tx_hash).trim() === "") {
    return "tx_hash is required";
  }
  return null;
}

// ── 2. BUILD ERC-8004 FEEDBACK JSON ───────────────────────────
export function buildFeedbackJson(input: ForgeInput, clientAddress: string): FeedbackJson {
  const chainId = input.chain_id ?? 8453;
  const success = input.success ?? false;
  const latency = input.response_latency_ms ?? 0;

  return {
    agentRegistry: `eip155:${chainId}:${AGENT_REGISTRY_ADDRESS}`,
    agentId: Number(input.agent_id),
    clientAddress: `eip155:${chainId}:${clientAddress}`,
    createdAt: new Date().toISOString(),
    value: input.score,
    valueDecimals: 0,
    reasoning: `Automated evaluation: ${input.task}. Success: ${success}. Latency: ${latency}ms`,
    tag1: String(input.task).slice(0, 32),
    tag2: success ? "execution_success" : "execution_failed",
    endpoint: "distill-middleware-v1",
    metrics: {
      response_latency_ms: latency,
      usdc_paid: input.usdc_paid ?? "0",
      tx_hash: String(input.tx_hash),
    },
  };
}

// ── 3. KECCAK-256 HASH (canonical JSON → bytes32) ─────────────
export function computeFeedbackHash(feedback: FeedbackJson): string {
  const canonical = stringify(feedback); // deterministic key ordering
  return ethers.keccak256(ethers.toUtf8Bytes(canonical));
}

// ── 4. PIN FEEDBACK JSON TO IPFS (Pinata) ─────────────────────
// Throws on missing JWT or any upload failure so the caller can set
// ready_to_sign:false.
export async function uploadToIpfs(feedback: FeedbackJson): Promise<string> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt || jwt.trim() === "") {
    throw new Error("PINATA_JWT is not configured");
  }

  const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      pinataContent: feedback,
      pinataMetadata: { name: `forge_${Date.now()}.json` },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Pinata upload failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  const data: any = await res.json();
  if (!data?.IpfsHash) {
    throw new Error("Pinata response did not include an IpfsHash");
  }
  return `ipfs://${data.IpfsHash}`;
}

// ── 5. ABI-ENCODE giveFeedback() CALLDATA ─────────────────────
export function encodeGiveFeedback(params: {
  agentId: number | string;
  value: number;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: string;
}): string {
  return reputationInterface.encodeFunctionData("giveFeedback", [
    BigInt(params.agentId),
    BigInt(params.value),
    params.valueDecimals,
    params.tag1,
    params.tag2,
    params.endpoint,
    params.feedbackURI,
    params.feedbackHash,
  ]);
}

// ── ORCHESTRATION ─────────────────────────────────────────────
// Runs the full pipeline. Returns ready_to_sign:false (with an error)
// when validation fails or the IPFS upload cannot complete.
export async function forge(input: ForgeInput, clientAddress: string): Promise<ForgeOutput> {
  const validationError = validateInput(input);
  if (validationError) {
    return { feedback_hash: null, ipfs_uri: null, contract_payload: null, ready_to_sign: false, error: validationError };
  }

  const feedbackJson = buildFeedbackJson(input, clientAddress);
  const feedbackHash = computeFeedbackHash(feedbackJson);

  let ipfsUri: string;
  try {
    ipfsUri = await uploadToIpfs(feedbackJson);
  } catch (err: any) {
    // Pinata failed — surface the hash we computed, but signal not-ready.
    return {
      feedback_hash: feedbackHash,
      ipfs_uri: null,
      contract_payload: null,
      ready_to_sign: false,
      error: err?.message ?? "IPFS upload failed",
    };
  }

  const contractPayload = encodeGiveFeedback({
    agentId: feedbackJson.agentId,
    value: feedbackJson.value,
    valueDecimals: feedbackJson.valueDecimals,
    tag1: feedbackJson.tag1,
    tag2: feedbackJson.tag2,
    endpoint: feedbackJson.endpoint,
    feedbackURI: ipfsUri,
    feedbackHash: feedbackHash,
  });

  return {
    feedback_hash: feedbackHash,
    ipfs_uri: ipfsUri,
    contract_payload: contractPayload,
    ready_to_sign: true,
  };
}
