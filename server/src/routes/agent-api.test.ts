/**
 * The agent's own API (/v1/agent-api/*) authenticates with an agent key, not a
 * user session. The /v1 route group's write guard used to run for these paths
 * too — Hono mounts a sub-app's middleware at /v1/* — so every agent POST was
 * refused with "verified_user_required" before its handler ran.
 *
 * Mounted the way index.ts mounts them, so the test sees the same ordering.
 * Runs against a temp working directory: the store resolves its file from
 * process.cwd().
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALLOW_HEADER_AUTH = "false";

const originalCwd = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "evabob-agent-api-"));
mkdirSync(join(scratch, "data"), { recursive: true });
process.chdir(scratch);

const { Hono } = await import("hono");
const { createAuthMiddleware } = await import("../middleware/auth.js");
const { api } = await import("./api.js");
const { agentCommerceRoutes, agentApiRoutes } = await import("./agentCommerce.js");
const { store } = await import("../store/db.js");

const OWNER = "user-agent-owner";
const KEY = `sk_evabob_${"a".repeat(32)}`;
const REVOKED_KEY = `sk_evabob_${"b".repeat(32)}`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function app() {
  const a = new Hono();
  a.use("/v1/*", createAuthMiddleware({ allowHeaderFallback: false }));
  a.route("/v1", api);
  a.route("/v1", agentCommerceRoutes);
  a.route("/v1/agent-api", agentApiRoutes);
  return a;
}

function post(path: string, key: string | null, body: unknown = {}) {
  return app().request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

before(() => {
  store.upsertUser({ id: OWNER, email: "owner@example.com" });
  store.createAgent({
    userId: OWNER,
    label: "Research agent",
    dailyLimitUsdc: 10,
    apiKeyHash: sha(KEY),
    apiKeyPrefix: KEY.slice(0, 16),
  });
  const revoked = store.createAgent({
    userId: OWNER,
    label: "Old agent",
    dailyLimitUsdc: 10,
    apiKeyHash: sha(REVOKED_KEY),
    apiKeyPrefix: REVOKED_KEY.slice(0, 16),
  });
  revoked.revokedAt = new Date().toISOString();
  store.save();
});

after(() => {
  process.chdir(originalCwd);
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // Windows holds the store file open; a stray temp dir is not worth a red suite.
  }
});

describe("agent API with an agent key", () => {
  it("reads the agent's own allowance", async () => {
    const res = await app().request("/v1/agent-api/me", {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).label, "Research agent");
  });

  it("reaches the handler on a POST instead of being refused as a non-user", async () => {
    const res = await post("/v1/agent-api/tasks/task_missing/cancel", KEY);
    const body = await res.json();
    assert.notEqual(body.error, "verified_user_required");
    assert.equal(res.status, 404);
    assert.equal(body.error, "No such task");
  });

  it("still refuses a POST with no key", async () => {
    const res = await post("/v1/agent-api/tasks/task_missing/cancel", null);
    assert.equal(res.status, 401);
  });

  it("still refuses a revoked key", async () => {
    const res = await post("/v1/agent-api/tasks/task_missing/cancel", REVOKED_KEY);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, "AGENT_KEY_REVOKED");
  });

  it("does not let an agent key write anywhere else under /v1", async () => {
    const res = await post("/v1/contacts", KEY, { name: "x", address: `0x${"1".repeat(40)}` });
    assert.equal(res.status, 401);
  });

  it("keeps /v1/x402/pay open to agent keys", async () => {
    const res = await post("/v1/x402/pay", null);
    // No key: the auth layer answers, not the user-session guard.
    assert.equal(res.status, 401);
    assert.notEqual((await res.json()).error, "verified_user_required");
  });
});
