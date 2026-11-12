import test from "node:test";
import assert from "node:assert/strict";

const { destinationsFrom, parseChains, parseStatus, planFromQuote, SynthraBridgeError, synthraBridgeSwitchedOn } =
  await import("./synthraBridge.js");

const USER = "0x1111111111111111111111111111111111111111";
const USDC = "0x3600000000000000000000000000000000000000";
const DEPOSIT = "0x4cd00e387622c35bddb9b4c962c136462338bc31";
const NOW = 1_800_000_000_000;
const WANT = { user: USER, sourceChainId: 5042, destinationChainId: 8453, amountInUnits: 25_000_000n, tokenIn: USDC };

/** approve(spender, amount) calldata. */
const approve = (amount: bigint) =>
  `0x095ea7b3${DEPOSIT.slice(2).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;

function quote(over: { steps?: unknown[]; quote?: Record<string, unknown>; top?: Record<string, unknown> } = {}) {
  const item = (data: Record<string, unknown>) => ({
    id: "i", status: "incomplete", kind: "transaction",
    data: { from: USER, chainId: 5042, value: "0", ...data },
  });
  return {
    state: "Success",
    quoteId: "tq_abc",
    expiresAt: NOW + 60_000,
    ...over.top,
    quote: {
      source: "external",
      state: "Success",
      sourceChainId: 5042,
      destinationChainId: 8453,
      amountIn: "25000000",
      maximumAmountIn: "25000000",
      amountOut: "24950000",
      minimumAmountOut: "24825000",
      routeSummary: "Arc to Base",
      executionRequestId: "req_0123456789",
      steps: over.steps ?? [
        { id: "approve", description: "Approve USDC", kind: "transaction", items: [item({ to: USDC, data: approve(25_000_000n) })] },
        { id: "deposit", description: "Deposit", kind: "transaction", items: [item({ to: DEPOSIT, data: "0xdeadbeef" })] },
      ],
      ...over.quote,
    },
  };
}

const refuses = (body: unknown, code: string, want = WANT) =>
  assert.throws(() => planFromQuote(body, want, NOW), (e: unknown) => e instanceof SynthraBridgeError && e.code === code);

test("a good quote becomes the steps to sign, in order, with what arrives", () => {
  const plan = planFromQuote(quote(), WANT, NOW);
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0]!.to.toLowerCase(), USDC);
  assert.equal(plan.steps[1]!.to.toLowerCase(), DEPOSIT);
  assert.equal(plan.amountOutUnits, 24_950_000n);
  assert.equal(plan.minimumOutUnits, 24_825_000n);
  assert.equal(plan.requestId, "req_0123456789");
  assert.equal(plan.route, "Arc to Base");
});

test("no route, an expired price, or an answer for somewhere else is refused", () => {
  refuses(quote({ top: { state: "Not found" } }), "NO_ROUTE");
  refuses(quote({ top: { expiresAt: NOW + 1_000 } }), "EXPIRED");
  refuses(quote({ quote: { destinationChainId: 1 } }), "WRONG_ROUTE");
  refuses(quote({ quote: { sourceChainId: 8453 } }), "WRONG_ROUTE");
  refuses(quote({ quote: { executionRequestId: "x" } }), "BAD_QUOTE");
  refuses(quote({ steps: [] }), "BAD_QUOTE");
});

test("a quote for a different amount, or one that delivers nothing, is refused", () => {
  refuses(quote({ quote: { amountIn: "26000000", maximumAmountIn: "26000000" } }), "WRONG_AMOUNT");
  refuses(quote({ quote: { maximumAmountIn: "30000000" } }), "WRONG_AMOUNT");
  refuses(quote({ quote: { minimumAmountOut: "0" } }), "BAD_QUOTE");
  refuses(quote({ quote: { amountOut: "abc" } }), "BAD_QUOTE");
});

test("a step for another wallet, another network, or more money than is being moved is refused", () => {
  const step = (data: Record<string, unknown>, kind = "transaction") => [{
    id: "s", kind, items: [{ kind, data: { from: USER, chainId: 5042, to: DEPOSIT, data: "0xdeadbeef", value: "0", ...data } }],
  }];
  refuses(quote({ steps: step({ from: "0x2222222222222222222222222222222222222222" }) }), "WRONG_WALLET");
  refuses(quote({ steps: step({ chainId: 8453 }) }), "WRONG_ROUTE");
  refuses(quote({ steps: step({ to: "0x0000000000000000000000000000000000000000" }) }), "BAD_STEP");
  refuses(quote({ steps: step({ data: "nonsense" }) }), "BAD_STEP");
  refuses(quote({ steps: step({ data: "0x" }) }), "BAD_STEP");
  // Native value above the amount (18 decimals against 6).
  refuses(quote({ steps: step({ value: (26n * 10n ** 18n).toString() }) }), "WRONG_AMOUNT");
  assert.equal(planFromQuote(quote({ steps: step({ value: (25n * 10n ** 18n).toString(), data: "0x" }) }), WANT, NOW).steps[0]!.value, 25n * 10n ** 18n);
  // Something to sign that is not a transaction.
  refuses(quote({ steps: step({}, "signature") }), "UNSUPPORTED_STEP");
});

test("an approval is only for the token being moved, and never for more than the amount", () => {
  const step = (to: string, data: string) => [{ id: "a", kind: "transaction", items: [{ kind: "transaction", data: { from: USER, chainId: 5042, to, data, value: "0" } }] }];
  refuses(quote({ steps: step(USDC, approve(2n ** 256n - 1n)) }), "WRONG_AMOUNT");
  refuses(quote({ steps: step(USDC, approve(25_000_001n)) }), "WRONG_AMOUNT");
  refuses(quote({ steps: step("0x5555555555555555555555555555555555555555", approve(1n)) }), "WRONG_AMOUNT");
  assert.equal(planFromQuote(quote({ steps: step(USDC, approve(25_000_000n)) }), WANT, NOW).steps.length, 1);
});

test("destinations: only when this network is served, and only where USDC is known", () => {
  const chains = parseChains({
    chains: [
      { chainId: 5042, label: "Arc", crossChain: "bidirectional" },
      { chainId: 8453, label: "Base", crossChain: "bidirectional" },
      { chainId: 1, label: "Ethereum", crossChain: "bidirectional" },
      { chainId: 999, label: "HyperEVM", crossChain: "bidirectional" },
      { chainId: 792703809, label: "Solana", crossChain: "bidirectional" },
      { chainId: "bad" },
    ],
  });
  assert.equal(chains.length, 5);
  assert.deepEqual(destinationsFrom(chains, 5042).map((d) => d.chainId).sort((a, b) => a - b), [1, 8453]);
  // Arc Testnet is not on the list: nothing is offered.
  assert.deepEqual(destinationsFrom(chains, 5042002), []);
  // The older host lists chains without saying they bridge: nothing either.
  assert.deepEqual(destinationsFrom(parseChains({ chains: [{ chainId: 5042002, label: "Arc" }, { chainId: 11155111, label: "Sepolia" }] }), 5042002), []);
});

test("status: arrived only with a transaction on the other side", () => {
  const tx = "0x" + "ab".repeat(32);
  assert.deepEqual(parseStatus({ status: "success", destinationTxHash: tx }), { state: "arrived", destinationTx: tx, final: true });
  assert.equal(parseStatus({ status: "success" }).state, "pending", "success without proof still waits");
  assert.equal(parseStatus({ status: "success" }).final, false);
  assert.equal(parseStatus({ status: "pending" }).state, "pending");
  assert.equal(parseStatus({ status: "delayed" }).state, "pending");
  assert.equal(parseStatus({ status: "waiting" }).state, "waiting");
  assert.equal(parseStatus({ status: "unknown" }).state, "waiting");
  assert.deepEqual(parseStatus({ status: "failure" }), { state: "failed", destinationTx: null, final: true });
  assert.equal(parseStatus({ status: "refund" }).state, "returned");
  assert.equal(parseStatus(null).state, "waiting");
});

test("it is off unless switched on", () => {
  delete process.env.SYNTHRA_BRIDGE;
  assert.equal(synthraBridgeSwitchedOn(), false);
});
