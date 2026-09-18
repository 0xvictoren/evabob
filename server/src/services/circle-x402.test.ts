/**
 * Which catalog sellers an Evabob agent wallet can actually pay.
 *
 * Fixtures are shaped like real entries from Circle's discovery catalog in
 * September 2026, where every payable seller was on Arc mainnet and none on
 * Arc Testnet — which is why paid agent calls stay off on testnet.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { payableFromCatalog } from "./circle-x402.js";

const ARC_MAINNET = "eip155:5042";
const ARC_TESTNET = "eip155:5042002";
const USDC = "0x3600000000000000000000000000000000000000";

const gatewayOffer = (network: string, amount: string) => ({
  scheme: "exact",
  network,
  asset: USDC,
  amount,
  payTo: "0x0000000000000000000000000000000000000001",
  extra: { name: "GatewayWalletBatched", version: "1" },
});

const catalog = [
  {
    resource: "https://api.aisa.one/apis/v2/coingecko/coins/markets",
    accepts: [gatewayOffer(ARC_MAINNET, "12000")],
    metadata: {
      method: "GET",
      description: "Coin market data",
      provider: { name: "AIsa", category: "FINANCIAL_ANALYSIS" },
    },
  },
  {
    // Same resource offered twice: the cheaper offer wins.
    resource: "https://api.aisa.one/apis/v2/coingecko/coins/markets",
    accepts: [gatewayOffer(ARC_MAINNET, "9000")],
    metadata: { method: "GET", provider: { name: "AIsa" } },
  },
  {
    // POST: the payer only makes GET requests.
    resource: "https://2captcha.x402.paysponge.com/createTask",
    accepts: [gatewayOffer(ARC_MAINNET, "10000")],
    metadata: { method: "POST", provider: { name: "Sponge" } },
  },
  {
    // Plain x402 on Base, no Gateway batching.
    resource: "https://example-seller.com/data",
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "10000",
        extra: { name: "USD Coin", version: "2" },
      },
    ],
    metadata: { method: "GET", provider: { name: "Example" } },
  },
  {
    resource: "http://insecure.example.com/data",
    accepts: [gatewayOffer(ARC_MAINNET, "1000")],
    metadata: { method: "GET" },
  },
];

describe("payable catalog sellers", () => {
  it("keeps only GET, Gateway-batched, HTTPS offers on the agent's network", () => {
    const payable = payableFromCatalog(catalog, ARC_MAINNET);
    assert.equal(payable.length, 1);
    assert.equal(payable[0]!.origin, "https://api.aisa.one");
    assert.equal(payable[0]!.provider, "AIsa");
    assert.equal(payable[0]!.category, "Financial Analysis");
  });

  it("uses the cheapest offer when a resource is listed more than once", () => {
    const [svc] = payableFromCatalog(catalog, ARC_MAINNET);
    assert.equal(svc!.priceUsdc, 0.009);
  });

  it("finds nothing on Arc Testnet when no seller offers it", () => {
    assert.deepEqual(payableFromCatalog(catalog, ARC_TESTNET), []);
  });
});
