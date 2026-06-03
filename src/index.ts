import express from 'express';
import { app as agentApp } from './lib/agent';
import forgeCard from '../agent-card.json';
import traceCard from '../trace-agent-card.json';

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

console.log(`Starting Forge agent server on port ${port}...`);

// CORS runs FIRST — before the Lucid agent app and its x402 payment middleware —
// so browser clients can read the PAYMENT-REQUIRED header and OPTIONS preflights
// short-circuit with 200 instead of hitting the paywall.
const wrapper = express();
wrapper.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, PAYMENT-SIGNATURE, X-Payment");
  res.header("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, WWW-Authenticate");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});
// Public A2A Agent Cards — static, no payment wall. Registered on the wrapper
// BEFORE the agent app so agent-card.json takes precedence over the manifest
// that Lucid's createAgentApp() serves at this same path. This repo hosts two
// agents, so it serves two cards: Forge and Trace.
wrapper.get('/.well-known/agent-card.json', (_req, res) => {
  res.type('application/json').send(JSON.stringify(forgeCard));
});
wrapper.get('/.well-known/trace-agent-card.json', (_req, res) => {
  res.type('application/json').send(JSON.stringify(traceCard));
});
// xgate fetches the root URL expecting JSON — redirect to the Lucid manifest
wrapper.get('/', (_req, res) => res.redirect(301, '/.well-known/agent.json'));
wrapper.use('/', agentApp);

const server = wrapper.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

export default server;
