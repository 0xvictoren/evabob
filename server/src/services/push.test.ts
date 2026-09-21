/**
 * Push device registration and the FCM message shape.
 *
 * The rule most worth pinning is ownership: a token belongs to one app
 * install, and when a different person signs in on that phone the previous
 * account's alerts — amounts, names, held payments — must stop going there.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "evabob-push-"));
mkdirSync(join(scratch, "data"), { recursive: true });
process.chdir(scratch);
delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

const {
  fcmMessage,
  listPushDevices,
  parseServiceAccount,
  pushConfigured,
  registerPushDevice,
  sendPush,
  unregisterPushDevice,
} = await import("./push.js");

const token = (n: number) => `device-token-${String(n).padStart(20, "0")}`;

describe("push devices", () => {
  it("registers a phone for a user", () => {
    registerPushDevice({ userId: "ada", token: token(1), platform: "android" });
    assert.deepEqual(listPushDevices("ada").map((d) => d.token), [token(1)]);
  });

  it("moves a token to whoever signs in on that phone next", () => {
    registerPushDevice({ userId: "bola", token: token(1), platform: "android" });
    assert.equal(listPushDevices("ada").length, 0, "ada's alerts must stop reaching it");
    assert.deepEqual(listPushDevices("bola").map((d) => d.token), [token(1)]);
  });

  it("keeps at most five phones per person", () => {
    for (let i = 10; i < 17; i++) {
      registerPushDevice({ userId: "chidi", token: token(i), platform: "ios" });
    }
    const mine = listPushDevices("chidi").map((d) => d.token);
    assert.equal(mine.length, 5);
    assert.ok(mine.includes(token(16)), "the newest registration is kept");
  });

  it("lets a person remove only their own registration", () => {
    assert.equal(unregisterPushDevice("ada", token(1)), false, "not ada's any more");
    assert.equal(unregisterPushDevice("bola", token(1)), true);
    assert.equal(listPushDevices("bola").length, 0);
  });

  it("sends nothing and throws nothing while FCM is not configured", async () => {
    assert.equal(pushConfigured(), false);
    assert.equal(await sendPush("chidi", { title: "t", body: "b", tag: "x" }), 0);
  });
});

describe("service account", () => {
  const json = JSON.stringify({
    project_id: "evabob-test",
    client_email: "push@evabob-test.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n",
  });

  it("accepts the JSON as pasted, restoring escaped newlines in the key", () => {
    const sa = parseServiceAccount(json);
    assert.equal(sa?.project_id, "evabob-test");
    assert.ok(sa?.private_key.includes("\nabc\n"));
  });

  it("accepts it base64-encoded", () => {
    const sa = parseServiceAccount(Buffer.from(json).toString("base64"));
    assert.equal(sa?.client_email, "push@evabob-test.iam.gserviceaccount.com");
  });

  it("rejects anything incomplete", () => {
    assert.equal(parseServiceAccount(""), null);
    assert.equal(parseServiceAccount("{\"project_id\":\"x\"}"), null);
    assert.equal(parseServiceAccount("not json"), null);
  });
});

describe("FCM message", () => {
  it("carries the tag both platforms use to collapse duplicates", () => {
    const m = fcmMessage(
      {
        token: token(99),
        userId: "u",
        platform: "android",
        createdAt: "",
        lastSeenAt: "",
      },
      {
        title: "Money received",
        body: "5 USDC from @maya",
        tag: "money_in:0xabc",
        data: { kind: "money_in", transferId: undefined, txHash: "0xabc" },
      },
    );
    assert.equal(m.message.token, token(99));
    assert.deepEqual(m.message.notification, {
      title: "Evabob",
      body: "You have a new private update.",
    });
    assert.equal(m.message.android.notification.tag, "money_in:0xabc");
    assert.equal(m.message.android.notification.channel_id, "evabob_money");
    assert.equal(m.message.apns.headers["apns-collapse-id"], "money_in:0xabc");
    // FCM data values must all be strings; absent fields are dropped.
    assert.deepEqual(m.message.data, { kind: "money_in", txHash: "0xabc", tag: "money_in:0xabc" });
  });
});
