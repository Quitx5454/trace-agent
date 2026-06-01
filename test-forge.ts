// Local smoke-test for the Forge core pipeline (bypasses the x402 paywall).
//   bun run test-forge.ts
//
// Exercises validation → feedback JSON → keccak-256 hash → ABI encode, and
// runs the full forge() orchestration (IPFS pin included when PINATA_JWT is set).
import {
  forge,
  buildFeedbackJson,
  computeFeedbackHash,
  encodeGiveFeedback,
  validateInput,
  type ForgeInput,
} from "./src/lib/forge";

const clientAddress = process.env.PAYMENTS_RECEIVABLE_ADDRESS ?? "0x104b5768FE505c400dd98F447665CB5c6fca388A";

const sample: ForgeInput = {
  agent_id: "6482",
  chain_id: 8453,
  task: "blockchain data cleaning",
  response_latency_ms: 1200,
  usdc_paid: "20000",
  tx_hash: "0xabc0000000000000000000000000000000000000000000000000000000000def",
  success: true,
  score: 95,
};

console.log("── INPUT ─────────────────────────────────────────");
console.log(JSON.stringify(sample, null, 2));

console.log("\n── VALIDATION ────────────────────────────────────");
console.log("validateInput:", validateInput(sample) ?? "OK");
console.log("  bad score   :", validateInput({ ...sample, score: 150 }));
console.log("  empty task  :", validateInput({ ...sample, task: "" }));
console.log("  no tx_hash  :", validateInput({ ...sample, tx_hash: "" }));
console.log("  non-numeric :", validateInput({ ...sample, agent_id: "abc" }));

const feedbackJson = buildFeedbackJson(sample, clientAddress);
console.log("\n── FEEDBACK JSON (ERC-8004) ──────────────────────");
console.log(JSON.stringify(feedbackJson, null, 2));

const hash = computeFeedbackHash(feedbackJson);
console.log("\n── KECCAK-256 HASH (bytes32) ─────────────────────");
console.log(hash);

console.log("\n── ABI-ENCODED giveFeedback() CALLDATA ───────────");
console.log("(demonstrated with a placeholder IPFS URI)");
const demoPayload = encodeGiveFeedback({
  agentId: feedbackJson.agentId,
  value: feedbackJson.value,
  valueDecimals: feedbackJson.valueDecimals,
  tag1: feedbackJson.tag1,
  tag2: feedbackJson.tag2,
  endpoint: feedbackJson.endpoint,
  feedbackURI: "ipfs://QmDemoPlaceholderHashForLocalEncodingPreviewOnly",
  feedbackHash: hash,
});
console.log(demoPayload);

console.log("\n── FULL forge() OUTPUT ───────────────────────────");
console.log("(ready_to_sign is false until PINATA_JWT is configured)");
const result = await forge(sample, clientAddress);
console.log(JSON.stringify(result, null, 2));
