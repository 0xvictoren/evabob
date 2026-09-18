/**
 * Boundaries on what the Evabob Agent may read.
 *
 * The agent decides for itself which tools to call, and the arguments come
 * from a language model that a hostile message in a chat thread might steer.
 * So the properties worth pinning are the ones a prompt cannot guarantee: a
 * tool reads the caller's own data and nobody else's, and no tool hands back a
 * credential.
 *
 * These run against a temp working directory, because the store resolves its
 * file from process.cwd() and an earlier test in this repo wrote rows into the
 * real database as a side effect.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "evabob-agent-tools-"));
mkdirSync(join(scratch, "data"), { recursive: true });
process.chdir(scratch);

const { READ_TOOLS, PROPOSE_TOOLS, readToolDefinitions, runReadTool } =
  await import("./agentTools.js");
type Proposal = import("./agentTools.js").Proposal;
const { store } = await import("../store/db.js");

const OWNER = "owner-user";
const STRANGER = "stranger-user";

before(() => {
  store.upsertUser({
    id: OWNER,
    email: "owner@example.com",
    displayName: "Owner",
    evmAddress: "0x1111111111111111111111111111111111111111",
  });
  store.upsertUser({
    id: STRANGER,
    email: "stranger@example.com",
    displayName: "Stranger",
    evmAddress: "0x2222222222222222222222222222222222222222",
  });

  store.addActivity({
    userId: OWNER,
    kind: "receive",
    title: "Received from Maya",
    description: "test",
    amountUsdc: 12.5,
    status: "completed",
    txHash: "0xowner",
  });
  store.addActivity({
    userId: STRANGER,
    kind: "receive",
    title: "STRANGER SECRET PAYMENT",
    description: "test",
    amountUsdc: 999,
    status: "completed",
    txHash: "0xstranger",
  });

  store.addContact({
    ownerUserId: STRANGER,
    name: "Stranger's private contact",
    address: "0x3333333333333333333333333333333333333333",
  });
});

after(() => {
  process.chdir(originalCwd);
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // Windows refuses to unlink a file the store still holds open, and a
    // stray temp directory is not worth failing a green suite over.
  }
});

describe("read tools are scoped to the caller", () => {
  it("returns only the caller's activity", async () => {
    const res = await runReadTool("get_activity", {}, { userId: OWNER });
    assert.equal(res.ok, true);
    const rows = (res as { ok: true; data: Array<{ title: string }> }).data;
    assert.ok(rows.some((r) => r.title === "Received from Maya"));
    assert.ok(
      !rows.some((r) => r.title.includes("STRANGER")),
      "must never surface another user's transactions",
    );
  });

  it("returns only the caller's contacts", async () => {
    const res = await runReadTool("get_contacts", {}, { userId: OWNER });
    assert.equal(res.ok, true);
    assert.deepEqual((res as { ok: true; data: unknown[] }).data, []);
  });

  it("cannot be pointed at another user through its arguments", async () => {
    // A model that has been talked into trying is still confined: identity
    // comes from the verified session, and the schemas carry no user field.
    const res = await runReadTool(
      "get_activity",
      { userId: STRANGER, user: STRANGER, limit: 25 },
      { userId: OWNER },
    );
    assert.equal(res.ok, true);
    const rows = (res as { ok: true; data: Array<{ title: string }> }).data;
    assert.ok(!rows.some((r) => r.title.includes("STRANGER")));
  });

  it("declares no user-identifying parameter on any tool", () => {
    for (const [name, def] of Object.entries(READ_TOOLS)) {
      const props = Object.keys(def.parameters.properties).map((k) =>
        k.toLowerCase(),
      );
      for (const banned of ["userid", "user", "account", "address", "owner"]) {
        assert.ok(
          !props.includes(banned),
          `${name} must not accept "${banned}" as an argument`,
        );
      }
    }
  });
});

describe("read tools never return a credential", () => {
  it("reports an agent wallet's key prefix but not the key or its hash", async () => {
    // The stored record carries a hash and, on older rows, the plaintext key
    // itself. Neither may reach the model: a leaked key spends real money and
    // a chat transcript is the last place it should appear.
    const SECRET_KEY = "sk_evabob_SUPERSECRETVALUE";
    const SECRET_HASH = "hash-of-the-super-secret-value";
    store.createAgent({
      userId: OWNER,
      label: "Research bot",
      dailyLimitUsdc: 5,
      apiKeyHash: SECRET_HASH,
      apiKeyPrefix: "sk_evabob_SUPE",
      apiKeyFull: SECRET_KEY,
    });

    const res = await runReadTool("get_agent_wallets", {}, { userId: OWNER });
    assert.equal(res.ok, true);
    const serialised = JSON.stringify((res as { ok: true; data: unknown }).data);

    assert.ok(serialised.includes("Research bot"), "should list the wallet");
    assert.ok(
      !serialised.includes(SECRET_KEY),
      "the plaintext key must never be returned",
    );
    assert.ok(
      !serialised.includes(SECRET_HASH),
      "the key hash must never be returned",
    );
    for (const field of ["apiKeyFull", "apiKeyHash", "secret", "privateKey"]) {
      assert.ok(
        !serialised.includes(field),
        `agent wallet output must not contain ${field}`,
      );
    }
  });
});

describe("tool dispatch", () => {
  it("fails an unknown tool without throwing", async () => {
    const res = await runReadTool("drop_everything", {}, { userId: OWNER });
    assert.equal(res.ok, false);
    assert.match((res as { ok: false; error: string }).error, /Unknown tool/);
  });

  it("explains itself when the user has no wallet yet", async () => {
    store.upsertUser({ id: "walletless", email: "no@example.com" });
    const res = await runReadTool("get_balance", {}, { userId: "walletless" });
    assert.equal(res.ok, false);
    assert.match(
      (res as { ok: false; error: string }).error,
      /wallet/i,
      "the model needs to be told why, so it can tell the user",
    );
  });

  it("exposes every tool to the model in the OpenAI-compatible schema shape", () => {
    const defs = readToolDefinitions();
    assert.equal(
      defs.length,
      Object.keys(READ_TOOLS).length + Object.keys(PROPOSE_TOOLS).length,
    );
    for (const d of defs) {
      assert.equal(d.type, "function");
      assert.ok(d.function.name && d.function.description);
      assert.equal(d.function.parameters.additionalProperties, false);
    }
  });
});

describe("proposing money actions", () => {
  it("moves nothing and records nothing", async () => {
    // The safety property of the whole design: a propose tool describes an
    // action for the user to approve. If one of these ever writes, a model
    // that has been talked into calling it has spent someone's money.
    const before = {
      activity: store.listActivity(OWNER, 500).length,
      users: store.listUsers().length,
    };

    const res = await runReadTool(
      "propose_send",
      { amount: 5, to: "0x2222222222222222222222222222222222222222" },
      { userId: OWNER },
    );
    assert.equal(res.ok, true);

    assert.equal(store.listActivity(OWNER, 500).length, before.activity);
    assert.equal(store.listUsers().length, before.users);
  });

  it("returns a resolved proposal the card can be built from", async () => {
    const res = await runReadTool(
      "propose_send",
      { amount: 5, to: "0x2222222222222222222222222222222222222222" },
      { userId: OWNER },
    );
    const { proposal } = (res as { ok: true; data: { proposal: Proposal } })
      .data;
    assert.equal(proposal.intent, "send");
    assert.equal(proposal.amount, 5);
    assert.equal(proposal.asset, "USDC");
    assert.equal(
      proposal.resolvedAddress?.toLowerCase(),
      "0x2222222222222222222222222222222222222222",
    );
  });

  it("refuses a payee it cannot resolve", async () => {
    const res = await runReadTool(
      "propose_send",
      { amount: 5, to: "my brother" },
      { userId: OWNER },
    );
    assert.equal(res.ok, false);
  });

  it("refuses to send to yourself", async () => {
    // resolvePayee guards this, and the guard must survive the tool wrapper:
    // a self-send used to fail only after the user had entered their PIN.
    const res = await runReadTool(
      "propose_send",
      { amount: 5, to: "0x1111111111111111111111111111111111111111" },
      { userId: OWNER },
    );
    assert.equal(res.ok, false);
  });

  it("refuses a zero or negative amount", async () => {
    for (const amount of [0, -5]) {
      const res = await runReadTool(
        "propose_send",
        { amount, to: "0x2222222222222222222222222222222222222222" },
        { userId: OWNER },
      );
      assert.equal(res.ok, false, `amount ${amount} must be refused`);
    }
  });

  it("refuses a swap between the same two currencies", async () => {
    const res = await runReadTool(
      "propose_swap",
      { amount: 5, from: "USDC", to: "USDC" },
      { userId: OWNER },
    );
    assert.equal(res.ok, false);
  });

  it("refuses a bridge that does not cross networks", async () => {
    const res = await runReadTool(
      "propose_bridge",
      { amount: 5, from: "Arc", to: "Arc" },
      { userId: OWNER },
    );
    assert.equal(res.ok, false);
  });

  it("holds money for a named payee without moving it", async () => {
    const before = store.listActivity(OWNER, 500).length;
    const res = await runReadTool(
      "propose_escrow",
      {
        amount: 30,
        to: "0x2222222222222222222222222222222222222222",
        description: "logo work",
      },
      { userId: OWNER },
    );
    assert.equal(res.ok, true);
    const { proposal } = (res as { ok: true; data: { proposal: Proposal } })
      .data;
    assert.equal(proposal.intent, "escrow");
    assert.equal(proposal.amount, 30);
    assert.equal(proposal.description, "logo work");
    assert.equal(store.listActivity(OWNER, 500).length, before);
  });

  it("refuses to hold money for an unresolvable payee", async () => {
    const res = await runReadTool(
      "propose_escrow",
      { amount: 30, to: "the designer" },
      { userId: OWNER },
    );
    assert.equal(res.ok, false);
  });

  it("tells the model a proposal is not a completed payment", async () => {
    const res = await runReadTool(
      "propose_request",
      { amount: 20 },
      { userId: OWNER },
    );
    assert.equal(res.ok, true);
    const { note } = (res as { ok: true; data: { note: string } }).data;
    assert.match(note, /not say it is done|nothing has happened/i);
  });
});
