/**
 * Pays real outside x402 sellers from an agent wallet on Arc testnet, through
 * the same payer /v1/x402/pay uses (nanopay), without touching the store —
 * so it can run while the hosted server is up.
 *
 *   npx tsx src/scripts/e2e-x402-outside.ts <agentLabel>
 *
 * The agent is read from the local data snapshot (wallet id and address
 * only). What is spent comes off its Gateway balance; the hosted server's
 * ledger corrects itself downward from Gateway on that agent's next payment.
 */
import { readFileSync } from "node:fs";
import { dataPath } from "../utils/data-path.js";

const label = process.argv[2] || "Research agent";
const db = JSON.parse(readFileSync(dataPath("evabob-db.json"), "utf8")) as {
  agents: Array<{ label: string; circleWalletId?: string; custodyAddress?: string; custodyMode?: string; revokedAt?: string }>;
};
const agent = db.agents.filter((a) => a.label === label && a.custodyMode === "circle-eoa" && !a.revokedAt).pop();
if (!agent?.circleWalletId || !agent.custodyAddress) throw new Error(`No dedicated agent wallet called "${label}"`);

const { fetchGatewayBalances } = await import("../services/gateway.js");
const { nanopay } = await import("../services/nanopay.js");
const { normalizeAgentRequest } = await import("../services/safe-agent-http.js");
const address = agent.custodyAddress as `0x${string}`;

const balance = async () => (await fetchGatewayBalances(address)).totalUsdc;
console.log(`[e2e] agent ${label} ${address} gateway balance ${await balance()}`);

const calls = [
  { url: "https://api.botpay.network/pay", method: "GET", body: undefined as unknown },
  {
    url: "https://x402.quicknode.com/arc-testnet/",
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
  },
];

for (const call of calls) {
  const started = Date.now();
  const out = await nanopay({
    walletId: agent.circleWalletId,
    address,
    url: call.url,
    allowedOrigins: [new URL(call.url).origin],
    request: normalizeAgentRequest({ method: call.method, body: call.body }),
    authorize: async (cost) => (cost > 0.02 ? `refusing ${cost}: this check spends at most $0.02 a call` : null),
    onAuthorized: async () => undefined,
  });
  console.log(`[e2e] ${call.method} ${call.url} (${Date.now() - started} ms)`);
  console.log(JSON.stringify({
    ok: out.ok, paid: out.paid, status: out.status, costUsdc: out.costUsdc,
    error: out.error, settleReference: out.settleReference, payment: out.payment,
    body: typeof out.rawText === "string" ? out.rawText.slice(0, 400) : out.body,
  }, null, 1));
}
console.log(`[e2e] gateway balance after ${await balance()}`);
process.exit(0);
