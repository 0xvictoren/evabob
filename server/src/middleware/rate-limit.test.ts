import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { Hono } from "hono";
import {
  __resetRateLimitState,
  rateLimit,
  type RateLimitRule,
} from "./rate-limit.js";

const RULE: RateLimitRule = { name: "test", limit: 3, windowMs: 60_000 };

function app(rule: RateLimitRule = RULE) {
  const a = new Hono();
  a.use("/x", rateLimit(rule));
  a.get("/x", (c) => c.json({ ok: true }));
  return a;
}

describe("rateLimit", () => {
  beforeEach(() => __resetRateLimitState());

  it("allows requests up to the limit", async () => {
    const a = app();
    for (let i = 0; i < RULE.limit; i++) {
      assert.equal((await a.request("/x")).status, 200, `request ${i + 1}`);
    }
  });

  it("rejects the request past the limit with 429", async () => {
    const a = app();
    for (let i = 0; i < RULE.limit; i++) await a.request("/x");
    const res = await a.request("/x");
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error, "rate_limited");
  });

  it("advertises remaining budget and a Retry-After when exhausted", async () => {
    const a = app();
    const first = await a.request("/x");
    assert.equal(first.headers.get("RateLimit-Limit"), "3");
    assert.equal(first.headers.get("RateLimit-Remaining"), "2");

    for (let i = 0; i < RULE.limit; i++) await a.request("/x");
    const blocked = await a.request("/x");
    assert.ok(Number(blocked.headers.get("Retry-After")) > 0);
  });

  it("starts a fresh window after the old one expires", async () => {
    // Margins are deliberately wide: a 20ms window with a 30ms wait left only
    // 10ms of slack and went red when the machine was busy running another
    // suite in parallel.
    const a = app({ name: "quick", limit: 1, windowMs: 150 });
    assert.equal((await a.request("/x")).status, 200);
    assert.equal((await a.request("/x")).status, 429);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await a.request("/x")).status, 200);
  });

  it("counts each rule separately", async () => {
    const shared = new Hono();
    shared.use("/a", rateLimit({ name: "ra", limit: 1, windowMs: 60_000 }));
    shared.use("/b", rateLimit({ name: "rb", limit: 1, windowMs: 60_000 }));
    shared.get("/a", (c) => c.json({ ok: true }));
    shared.get("/b", (c) => c.json({ ok: true }));

    assert.equal((await shared.request("/a")).status, 200);
    assert.equal((await shared.request("/a")).status, 429);
    // A different rule must not inherit the exhausted bucket.
    assert.equal((await shared.request("/b")).status, 200);
  });

  it("keys verified users separately from each other", async () => {
    const a = new Hono();
    a.use("/x", async (c, next) => {
      c.set("auth", {
        userId: c.req.header("test-user") || "anon",
        claims: null,
        verified: true,
        principal: "user",
      });
      await next();
    });
    a.use("/x", rateLimit({ name: "peruser", limit: 1, windowMs: 60_000 }));
    a.get("/x", (c) => c.json({ ok: true }));

    assert.equal(
      (await a.request("/x", { headers: { "test-user": "ada" } })).status,
      200,
    );
    assert.equal(
      (await a.request("/x", { headers: { "test-user": "ada" } })).status,
      429,
    );
    // Exhausting one user must not lock out another.
    assert.equal(
      (await a.request("/x", { headers: { "test-user": "bob" } })).status,
      200,
    );
  });
});
