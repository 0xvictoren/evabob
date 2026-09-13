/**
 * Guards the rule that made every route impersonatable: the `x-user-id`
 * header is not an identity claim unless ALLOW_HEADER_AUTH is explicitly on.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Locked before importing config.js, which reads env at module load.
// dotenv does not override already-set variables, so this wins over .env.
process.env.ALLOW_HEADER_AUTH = "false";

const { createAuthMiddleware, getUserId } = await import("./auth.js");
const { Hono } = await import("hono");

function app(allowHeaderFallback = false) {
  const a = new Hono();
  a.use("/v1/*", createAuthMiddleware({ allowHeaderFallback }));
  a.get("/v1/health", (c) => c.json({ ok: true }));
  a.get("/v1/public/payment-requests/:id", (c) => c.json({ id: c.req.param("id") }));
  a.get("/v1/public/claims/:id", (c) => c.json({ id: c.req.param("id") }));
  a.get("/v1/activity", (c) => c.json({ user: getUserId(c) }));
  return a;
}

describe("authMiddleware", () => {
  it("rejects a protected route with no token", async () => {
    const res = await app().request("/v1/activity");
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, "unauthorized");
  });

  it("ignores x-user-id as an identity claim", async () => {
    const res = await app().request("/v1/activity", {
      headers: { "x-user-id": "victim" },
    });
    assert.equal(
      res.status,
      401,
      "x-user-id must not authenticate while the fallback is off",
    );
  });

  it("ignores a ?userId= query override", async () => {
    const res = await app().request("/v1/activity?userId=victim");
    assert.equal(res.status, 401);
  });

  it("rejects a malformed bearer token", async () => {
    const res = await app().request("/v1/activity", {
      headers: { authorization: "Bearer not-a-jwt" },
    });
    assert.equal(res.status, 401);
  });

  it("allows public routes without a token", async () => {
    const res = await app().request("/v1/health");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });

  it("allows only the limited public payment and claim views", async () => {
    const invoice = await app().request("/v1/public/payment-requests/request-1");
    const claim = await app().request("/v1/public/claims/42");
    assert.equal(invoice.status, 200);
    assert.equal(claim.status, 200);
  });

  it("does not treat an unknown path as public", async () => {
    const res = await app().request("/v1/health/../activity");
    assert.notEqual(res.status, 200);
  });
});

describe("the ALLOW_HEADER_AUTH dev fallback", () => {
  it("honours x-user-id only when explicitly enabled", async () => {
    const res = await app(true).request("/v1/activity", {
      headers: { "x-user-id": "ada" },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user, "ada");
  });

  it("falls back to a shared id when the header is absent", async () => {
    const res = await app(true).request("/v1/activity");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).user, "dev-user");
  });

  it("defaults to off so the insecure path is opt-in", async () => {
    const { config } = await import("../config.js");
    assert.equal(config.auth.allowHeaderFallback, false);
  });
});
