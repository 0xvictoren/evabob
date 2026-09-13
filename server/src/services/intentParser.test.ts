import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mergeFollowUp,
  parseAgentIntent,
  parseSendIntent,
  toAppKitChain,
  toOnchainToken,
} from "./intentParser.js";

describe("parseSendIntent", () => {
  it("parses @. send 5 USDC", () => {
    const r = parseSendIntent("@. send 5 USDC");
    assert.equal(r.intent, "send");
    assert.equal(r.amount, 5);
    assert.equal(r.asset, "USDC");
    assert.equal(r.chain, "Arc");
    assert.equal(r.to, null);
    assert.equal(r.toType, "thread");
    assert.equal(r.needsConfirmation, true);
    assert.ok(r.confidence >= 0.9);
  });

  it("parses from-chain variants", () => {
    assert.equal(parseSendIntent("@. send 5 USDC from Arc").chain, "Arc");
    assert.equal(parseSendIntent("@. send 5 USDC from Base").chain, "Base");
    assert.equal(
      parseSendIntent("@. send 5 USDC from Ethereum").chain,
      "Ethereum",
    );
  });

  it("parses address / email recipients and rejects phone", () => {
    const addr = parseSendIntent(
      "@. send 5 USDC to 0x1234567890abcdef1234567890abcdef12345678",
    );
    assert.equal(addr.toType, "address");
    assert.equal(addr.to?.length, 42);

    const phone = parseSendIntent("@. send 5 USDC to +2348012345678");
    assert.equal(phone.intent, "clarification_needed");

    const email = parseSendIntent("@. send 5 USDC to john@gmail.com");
    assert.equal(email.toType, "email");
    assert.equal(email.to, "john@gmail.com");
  });

  it("parses natural language send", () => {
    const r = parseSendIntent("send 10 eurc to john");
    assert.equal(r.intent, "send");
    assert.equal(r.amount, 10);
    assert.equal(r.asset, "EURC");
    assert.equal(r.to, "@john");
    assert.equal(r.toType, "handle");
    assert.equal(r.chain, "Arc");
    assert.equal(r.needsConfirmation, true);
  });

  it("uses thread peer when to is omitted", () => {
    const r = parseSendIntent("send 3 USDC", { peerHandle: "maya" });
    assert.equal(r.to, "@maya");
    assert.equal(r.toType, "handle");
  });

  it("returns clarification_needed when unclear", () => {
    const r = parseSendIntent("hello there");
    assert.equal(r.intent, "clarification_needed");
    assert.ok(r.confidence < 0.5);
  });

  it("maps display names to kit/on-chain ids", () => {
    assert.equal(toAppKitChain("Base"), "Base_Sepolia");
    assert.equal(toOnchainToken("CBTC"), "CIRBTC");
  });
});

describe("parseAgentIntent", () => {
  it("parses bridge / buy / invoice / balance", () => {
    const b = parseAgentIntent("Bridge 50 USDC to Base");
    assert.equal(b.intent, "bridge");
    assert.equal(b.amount, 50);
    assert.equal(b.toChain, "Base");
    assert.equal(b.needsConfirmation, true);

    const bareBridge = parseAgentIntent("Bridge 50 USDC");
    assert.equal(bareBridge.intent, "clarification_needed");

    const buy = parseAgentIntent("Buy 100 USDC with EURC");
    assert.equal(buy.intent, "buy");
    assert.equal(buy.tokenIn, "EURC");
    assert.equal(buy.tokenOut, "USDC");

    const inv = parseAgentIntent("Send an invoice for $150");
    assert.equal(inv.intent, "invoice");
    assert.equal(inv.amount, 150);

    const bal = parseAgentIntent("Check my balance");
    assert.equal(bal.intent, "balance");
    assert.equal(bal.needsConfirmation, false);

    const tx = parseAgentIntent("Show my recent transactions");
    assert.equal(tx.intent, "activity");
  });

  it("parses send to handle", () => {
    const s = parseAgentIntent("Send 25 USDC to @john");
    assert.equal(s.intent, "send");
    assert.equal(s.amount, 25);
    assert.equal(s.to, "@john");
  });

  it("treats \$3 as 3 USDC", () => {
    const s = parseAgentIntent("send \$3 to @john");
    assert.equal(s.intent, "send");
    assert.equal(s.amount, 3);
    assert.equal(s.asset, "USDC");
    assert.equal(s.to, "@john");
  });

  it("answers help questions with something a person can act on", () => {
    const h = parseAgentIntent("what can you help me do?");
    assert.equal(h.intent, "help");
    const reply = (h.reply || "").toLowerCase();

    // Used to assert the reply contained "bob me". That pinned a tagline the
    // brief wants used sparingly rather than as permanent chrome, and it said
    // nothing about whether the answer was useful. What matters is that it
    // offers an example someone could copy.
    assert.ok(reply.includes("try:"), "should offer examples");
    assert.ok(reply.includes("send"), "should show how to send");

    // And that it does not answer with the app's internal vocabulary, which is
    // exactly what it used to do: "send, bridge, swap, invoice, escrow".
    for (const jargon of ["bridge", "escrow", "usdc", "eurc", "chain"]) {
      assert.ok(
        !reply.includes(jargon),
        `help text should not say "${jargon}"`,
      );
    }
  });

  it("counts invoices as a read intent", () => {
    const inv = parseAgentIntent("how many invoices do i have here");
    assert.equal(inv.intent, "invoices");
    assert.equal(inv.needsConfirmation, false);
  });

  it("refuses EURC bridge and does not default dest to Base", () => {
    const eurc = parseAgentIntent("bridge 20 eurc from sepolia to arc");
    assert.equal(eurc.intent, "clarification_needed");
    assert.ok((eurc.reply || eurc.clarification || "").toLowerCase().includes("usdc"));

    const bare = parseAgentIntent("bridge 50 USDC");
    assert.equal(bare.intent, "clarification_needed");
    assert.equal(bare.toChain, undefined);
  });

  it("does not treat send-to-Base as a bridge", () => {
    const s = parseAgentIntent("send 10 USDC to base");
    assert.equal(s.intent, "clarification_needed");
    assert.notEqual(s.intent, "bridge");
  });

  it("picks every 0x in a batch send, not English-as-handle", () => {
    const a = "0x1111111111111111111111111111111111111111";
    const b = "0x2222222222222222222222222222222222222222";
    const c = "0x3333333333333333333333333333333333333333";
    const s = parseAgentIntent(`send 0.3 usdc to these addresses ${a} ${b} ${c}`);
    assert.equal(s.intent, "send");
    assert.equal(s.amount, 0.3);
    assert.equal(s.toType, "address");
    assert.deepEqual(s.recipients, [a, b, c]);
    assert.notEqual(s.to, "@theseaddresses");
  });

  it("merges follow-up amount/asset into the last send", () => {
    const pending = parseAgentIntent("send to @john");
    assert.equal(pending.amount, null);
    assert.equal(pending.to, "@john");
    const merged = mergeFollowUp(pending, "5 usdc");
    assert.equal(merged.intent, "send");
    assert.equal(merged.amount, 5);
    assert.equal(merged.asset, "USDC");
    assert.equal(merged.to, "@john");
    assert.equal(merged.needsConfirmation, true);
  });

  it("swap confirm copy uses tokenIn amount", () => {
    const s = parseAgentIntent("swap 4 usdc for eurc on arc");
    assert.equal(s.intent, "swap");
    assert.equal(s.amount, 4);
    assert.equal(s.tokenIn, "USDC");
    assert.equal(s.tokenOut, "EURC");
  });
});
