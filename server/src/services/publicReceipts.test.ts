import test from "node:test";
import assert from "node:assert/strict";

import { newPublicId, stageOf } from "./publicReceipts.js";

const send = { kind: "send" as const, mode: "direct_user" };

test("a payment moves Sending → On the way → Done", () => {
  assert.equal(stageOf({ row: { ...send, status: "pending" } }), "sending");
  assert.equal(
    stageOf({ row: { ...send, status: "pending", txHash: "0x" + "a".repeat(64) } }),
    "on_the_way",
  );
  assert.equal(stageOf({ row: { ...send, status: "completed" } }), "done");
  // Older rows have no status and were only ever written once settled.
  assert.equal(stageOf({ row: send }), "done");
  assert.equal(stageOf({ row: { ...send, status: "failed" } }), "failed");
});

test("a bridge follows its job, not the row", () => {
  const row = { kind: "bridge" as const, status: "pending" as const };
  assert.equal(stageOf({ row, jobStage: "waiting_pin" }), "sending");
  assert.equal(stageOf({ row, jobStage: "sent" }), "on_the_way");
  assert.equal(stageOf({ row, jobStage: "confirming" }), "on_the_way");
  assert.equal(stageOf({ row, jobStage: "arrived" }), "done");
  assert.equal(stageOf({ row, jobStage: "failed" }), "failed");
});

test("held money is held until it is released or given back", () => {
  const row = { kind: "send" as const, mode: "escrow", status: "completed" as const };
  assert.equal(stageOf({ row, heldStatus: "pending" }), "held");
  assert.equal(stageOf({ row, heldStatus: "claimed" }), "done");
  assert.equal(stageOf({ row, heldStatus: "refunded" }), "returned");
});

test("public ids are unguessable and URL-safe", () => {
  const a = newPublicId();
  const b = newPublicId();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{22}$/);
});
