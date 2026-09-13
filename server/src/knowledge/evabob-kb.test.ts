/**
 * Whether the help content can be found by the words people actually use.
 *
 * Retrieval is the whole point: an entry the search never returns is an entry
 * the agent never sees, and the model then answers from generic knowledge of
 * payment apps — which is how it came to invent a card-and-bank top-up flow.
 *
 * These cases are phrased the way a user would type them, not the way the
 * entries are titled.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KB, searchKb } from "./evabob-kb.js";

/** question → the entry that must come back first. */
const MUST_FIND: Array<[string, string]> = [
  ["how do i top up my wallet?", "adding-money"],
  ["can i add money with my debit card", "adding-money"],
  ["how do i put money in", "adding-money"],
  ["whats my address so someone can pay me", "receiving-money"],
  ["how do i send money to a friend", "sending-money"],
  ["how do i ask someone to pay me", "requesting-money"],
  ["how do i make an invoice", "requesting-money"],
  ["how do i convert dollars to euros", "swapping"],
  ["what is a bridge", "bridging"],
  ["what is usdc", "usdc-eurc"],
  ["why is it taking so long", "how-long-things-take"],
  ["how much are the fees", "fees"],
  ["why does it keep asking for my pin", "pin-and-confirming"],
  ["my payment is stuck", "stuck-payment"],
  ["where is my money", "stuck-payment"],
  ["what is an agent wallet", "agent-wallets"],
  ["i lost my phone", "security-and-recovery"],
  ["someone hacked my account", "security-and-recovery"],
  ["how do i change my handle", "handles-and-contacts"],
  ["i just signed up what do i do", "getting-started"],
  // GA is what the pooled spendable balance is called, so the agent has to
  // recognise it in the shape users actually say it.
  ["what is my ga", "ga-balance"],
  ["how do i top up my ga", "ga-balance"],
  // Holding money for undelivered work.
  ["what is escrow", "escrow"],
  ["can i hold the money until the job is done", "escrow"],
  ["how do i release the money to them", "escrow"],
  ["they never delivered can i get a refund", "escrow"],
];

describe("help content retrieval", () => {
  for (const [question, expected] of MUST_FIND) {
    it(`"${question}" finds ${expected}`, () => {
      const hits = searchKb(question, 3);
      assert.ok(hits.length > 0, "should return something");
      assert.equal(
        hits[0]!.id,
        expected,
        `got ${hits.map((h) => h.id).join(", ")}`,
      );
    });
  }

  it("returns nothing for a question the content does not cover", () => {
    // Better an empty result the model reports honestly than a bad match it
    // reads out as fact.
    assert.deepEqual(searchKb("what is the weather in lagos tomorrow"), []);
  });

  it("returns at most the requested number of entries", () => {
    assert.ok(searchKb("money", 3).length <= 3);
  });
});

describe("help content itself", () => {
  it("has unique ids", () => {
    const ids = KB.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("gives every entry keywords and a body", () => {
    for (const e of KB) {
      assert.ok(e.keywords.length >= 3, `${e.id} needs more keywords`);
      assert.ok(e.body.trim().length > 80, `${e.id} body is too thin`);
    }
  });

  it("stays small enough to spend three at a time", () => {
    // Three entries ride along with the tool schemas and the conversation
    // inside an 8,000 token-per-minute budget.
    for (const e of KB) {
      assert.ok(
        e.body.length < 1200,
        `${e.id} is ${e.body.length} chars — too long to retrieve three of`,
      );
    }
  });

  it("does not promise a card or bank top-up anywhere", () => {
    // The exact fabrication this content exists to prevent.
    const adding = KB.find((e) => e.id === "adding-money")!;
    assert.match(adding.body, /no card or bank top-up/i);
  });
});
