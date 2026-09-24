/**
 * Behind a proxy, the left-most X-Forwarded-For entry is whatever the client
 * sent, so a fresh value per request used to mean a fresh rate-limit bucket.
 * With CLIENT_IP_HEADER set, the edge's own client-address header wins.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

// config.ts reads these at import time.
process.env.TRUST_PROXY = "true";
process.env.CLIENT_IP_HEADER = "true-client-ip";

const { Hono } = await import("hono");
const { __resetRateLimitState, rateLimit } = await import("./rate-limit.js");

const RULE = { name: "client-ip", limit: 2, windowMs: 60_000 };

function app() {
  const a = new Hono();
  a.use("/x", rateLimit(RULE));
  a.get("/x", (c) => c.json({ ok: true }));
  return a;
}

describe("client address behind a proxy", () => {
  beforeEach(() => __resetRateLimitState());

  it("ignores a forged X-Forwarded-For when the edge header is present", async () => {
    const a = app();
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await a.request("/x", {
        headers: {
          "true-client-ip": "203.0.113.7",
          // A different forged address on every request.
          "x-forwarded-for": `198.51.100.${i + 1}, 10.0.0.1`,
        },
      });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [200, 200, 429]);
  });

  it("keeps separate buckets for separate real clients", async () => {
    const a = app();
    for (let i = 0; i < 2; i++) {
      await a.request("/x", { headers: { "true-client-ip": "203.0.113.7" } });
    }
    const other = await a.request("/x", { headers: { "true-client-ip": "203.0.113.8" } });
    assert.equal(other.status, 200);
  });

  it("falls back to X-Forwarded-For when the edge header is missing", async () => {
    const a = app();
    for (let i = 0; i < 2; i++) {
      await a.request("/x", { headers: { "x-forwarded-for": "192.0.2.10" } });
    }
    const third = await a.request("/x", { headers: { "x-forwarded-for": "192.0.2.10" } });
    assert.equal(third.status, 429);
  });
});
