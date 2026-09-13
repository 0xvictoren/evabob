import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readOrNull } from "./read-or-null.js";

describe("readOrNull", () => {
  it("returns the value when the read succeeds", async () => {
    const got = await readOrNull(async () => 42n, { retryDelayMs: 0 });
    assert.equal(got, 42n);
  });

  it("preserves a genuine zero rather than treating it as failure", async () => {
    const got = await readOrNull(async () => 0n, { retryDelayMs: 0 });
    assert.equal(got, 0n);
  });

  it("retries once and returns the value when the first attempt fails", async () => {
    let calls = 0;
    const got = await readOrNull(
      async () => {
        calls++;
        if (calls === 1) throw new Error("transient RPC error");
        return 7n;
      },
      { retryDelayMs: 0 },
    );
    assert.equal(got, 7n);
    assert.equal(calls, 2);
  });

  it("returns null — never zero — when both attempts fail", async () => {
    let calls = 0;
    const got = await readOrNull(
      async () => {
        calls++;
        throw new Error("RPC down");
      },
      { retryDelayMs: 0 },
    );
    assert.equal(got, null);
    assert.equal(calls, 2);
  });

  it("does not retry more than once", async () => {
    let calls = 0;
    await readOrNull(
      async () => {
        calls++;
        throw new Error("nope");
      },
      { retryDelayMs: 0 },
    );
    assert.equal(calls, 2);
  });
});
