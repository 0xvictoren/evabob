import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UcwSessionStore } from "./ucw-sessions.js";

test("UCW ownership survives restart without persisting the raw token", () => {
  const dir = mkdtempSync(join(tmpdir(), "evabob-ucw-session-"));
  const path = join(dir, "sessions.json");
  const token = "circle-user-token-high-entropy-example";
  try {
    new UcwSessionStore(path).remember("user-a", token, 1_000);

    const afterRestart = new UcwSessionStore(path);
    assert.equal(afterRestart.owns("user-a", token, 2_000), true);
    assert.equal(afterRestart.owns("user-b", token, 2_000), false);
    assert.equal(readFileSync(path, "utf8").includes(token), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expired UCW fingerprints fail closed after restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "evabob-ucw-expiry-"));
  const path = join(dir, "sessions.json");
  try {
    new UcwSessionStore(path).remember("user-a", "token", 1_000);
    assert.equal(
      new UcwSessionStore(path).owns("user-a", "token", 1_000 + 56 * 60_000),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
