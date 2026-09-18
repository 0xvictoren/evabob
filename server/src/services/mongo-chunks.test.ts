/**
 * The primary-store snapshot is split across documents so no single one
 * nears MongoDB's 16 MB cap. Splitting must be lossless and must never cut a
 * character in half — a memo with an emoji is a surrogate pair in JS.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitIntoChunks } from "./mongo.js";

describe("snapshot chunks", () => {
  it("rejoins to exactly the original text", () => {
    const text = JSON.stringify({ memo: "x".repeat(10_001), n: [1, 2, 3] });
    const parts = splitIntoChunks(text, 997);
    assert.ok(parts.length > 10);
    assert.equal(parts.join(""), text);
    assert.ok(parts.every((p) => p.length <= 997));
  });

  it("never splits a surrogate pair across two chunks", () => {
    const text = "ab💸cd💸ef";
    for (let size = 2; size <= text.length; size++) {
      const parts = splitIntoChunks(text, size);
      assert.equal(parts.join(""), text);
      for (const p of parts) {
        const last = p.charCodeAt(p.length - 1);
        assert.ok(!(last >= 0xd800 && last <= 0xdbff), `size ${size} split a pair`);
      }
    }
  });

  it("keeps an empty snapshot as one empty chunk", () => {
    assert.deepEqual(splitIntoChunks(""), [""]);
  });
});
