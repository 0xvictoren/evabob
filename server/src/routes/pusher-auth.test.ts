/**
 * Who may listen on which Pusher channel.
 *
 * Worth testing directly rather than by inspection, because the failure is
 * silent: a channel that is wrongly signed does not error, it just quietly
 * streams someone else's money alerts or conversation to a stranger. The
 * caller's id always comes from the verified session, so the only question
 * these cover is whether the requested channel name belongs to it.
 *
 * Runs against a temp working directory: the store resolves its file from
 * process.cwd().
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "evabob-pusher-auth-"));
mkdirSync(join(scratch, "data"), { recursive: true });
process.chdir(scratch);

const { canJoinChannel } = await import("./api.js");
const { store } = await import("../store/db.js");

const ME = "user-me";
const THEM = "user-them";
let threadId = "";

before(() => {
  store.upsertUser({ id: ME, email: "me@example.com" });
  store.upsertUser({ id: THEM, email: "them@example.com" });
  const thread = store.addThread({
    title: "ours",
    members: [ME, THEM],
  } as never);
  threadId = thread.id;
});

after(() => {
  process.chdir(originalCwd);
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // Windows holds the store file open; a stray temp dir is not worth a red suite.
  }
});

describe("user alert channels", () => {
  it("lets a user listen to their own", () => {
    assert.equal(canJoinChannel(`private-user-${ME}`, ME), true);
  });

  it("refuses someone else's, which is the whole point", () => {
    assert.equal(canJoinChannel(`private-user-${THEM}`, ME), false);
  });

  it("refuses a channel that merely starts with the id", () => {
    // A prefix match here would hand `private-user-user-me-extra` to user-me.
    assert.equal(canJoinChannel(`private-user-${ME}-extra`, ME), false);
    assert.equal(canJoinChannel(`private-user-`, ME), false);
  });
});

describe("chat channels", () => {
  it("lets a member listen", () => {
    assert.equal(canJoinChannel(`private-chat-${threadId}`, ME), true);
  });

  it("refuses a non-member", () => {
    assert.equal(canJoinChannel(`private-chat-${threadId}`, "stranger"), false);
  });

  it("refuses a thread that does not exist", () => {
    assert.equal(canJoinChannel("private-chat-t_guessed_id", ME), false);
  });
});

describe("anything else", () => {
  it("is refused rather than signed", () => {
    for (const channel of [
      "private-admin",
      "presence-user-" + ME,
      "public",
      "",
      "private-user",
    ]) {
      assert.equal(canJoinChannel(channel, ME), false, `${channel} must be refused`);
    }
  });
});
