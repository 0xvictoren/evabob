/**
 * The ways outside software reaches an agent wallet: the text guide anyone
 * can read, and the MCP endpoint Claude and other MCP clients add.
 * Mounted the way index.ts mounts them, against a temp working directory.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALLOW_HEADER_AUTH = "false";

const originalCwd = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "evabob-agent-connect-"));
mkdirSync(join(scratch, "data"), { recursive: true });
process.chdir(scratch);

const { Hono } = await import("hono");
const { createAuthMiddleware } = await import("../middleware/auth.js");
const { api } = await import("./api.js");
const { agentGuideRoutes, agentMcpRoutes, payStatus } = await import("./agentConnect.js");
const { store } = await import("../store/db.js");

const OWNER = "user-connect-owner";
const KEY = `sk_evabob_${"c".repeat(32)}`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function app() {
  const a = new Hono();
  a.use("/v1/*", createAuthMiddleware({ allowHeaderFallback: false }));
  a.route("/v1", api);
  a.route("/v1", agentGuideRoutes);
  a.route("/v1/agent-api", agentMcpRoutes);
  return a;
}

function rpc(body: unknown, key: string | null = KEY) {
  return app().request("/v1/agent-api/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

before(() => {
  store.upsertUser({ id: OWNER, email: "connect@example.com" });
  store.createAgent({
    userId: OWNER,
    label: "Connect agent",
    dailyLimitUsdc: 5,
    apiKeyHash: sha(KEY),
    apiKeyPrefix: KEY.slice(0, 16),
  });
});

after(() => {
  process.chdir(originalCwd);
  rmSync(scratch, { recursive: true, force: true });
});

describe("the agent guide", () => {
  it("is readable by anyone, without a key", async () => {
    const res = await app().request("/v1/public/agent-guide");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/markdown/);
    const text = await res.text();
    assert.match(text, /POST .*\/v1\/x402\/pay/);
    assert.match(text, /APPROVAL_PENDING/);
    assert.match(text, /\/v1\/agent-api\/mcp/);
  });
});

describe("the MCP endpoint", () => {
  it("refuses a caller with no agent key", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, null);
    assert.equal(res.status, 401);
  });

  it("answers initialize with the version the client asked for", async () => {
    const res = await rpc({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { result: { protocolVersion: string; capabilities: { tools: object } } };
    assert.equal(body.result.protocolVersion, "2025-03-26");
    assert.ok(body.result.capabilities.tools);
  });

  it("accepts the initialized notification with no body", async () => {
    const res = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(res.status, 202);
  });

  it("lists the three tools", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const body = await res.json() as { result: { tools: Array<{ name: string }> } };
    assert.deepEqual(body.result.tools.map((t) => t.name), ["evabob_pay", "evabob_wallet", "evabob_find_services"]);
  });

  it("shows the wallet through evabob_wallet", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "evabob_wallet", arguments: {} } });
    const body = await res.json() as { result: { isError: boolean; content: Array<{ text: string }> } };
    assert.equal(body.result.isError, false);
    assert.equal(JSON.parse(body.result.content[0]!.text).label, "Connect agent");
  });

  it("turns bad pay arguments into a tool error, not a crash", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "evabob_pay", arguments: { url: "not a url" } } });
    const body = await res.json() as { result: { isError: boolean } };
    assert.equal(body.result.isError, true);
  });

  it("says so for a method it does not have", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 5, method: "resources/list" });
    const body = await res.json() as { error: { code: number } };
    assert.equal(body.error.code, -32601);
  });
});

describe("/v1/x402/pay", () => {
  const pay = (body: unknown) => app().request("/v1/x402/pay", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });

  it("explains a malformed request instead of failing with a 500", async () => {
    const res = await pay({ url: "nope" });
    assert.equal(res.status, 400);
    const body = await res.json() as { code: string; hint: string };
    assert.equal(body.code, "INVALID_REQUEST");
    assert.match(body.hint, /agent-guide/);
  });

  it("refuses a method it cannot send, before any request leaves", async () => {
    const res = await pay({ url: "https://seller.example/x", method: "TRACE" });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /not supported/);
  });

  it("answers 202 while the owner is being asked, 200 when paid, 400 when refused", () => {
    assert.equal(payStatus({ ok: true, costUsdc: 0.01, paid: true }), 200);
    assert.equal(payStatus({ ok: false, costUsdc: 0, paid: false, code: "APPROVAL_PENDING" }), 202);
    assert.equal(payStatus({ ok: false, costUsdc: 0, paid: false, reconciliationRequired: true }), 202);
    assert.equal(payStatus({ ok: false, costUsdc: 0, paid: false, code: "OVER_ALLOWANCE" }), 400);
  });
});
