import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeHandle, validateHandle } from "./handles.js";

describe("handles", () => {
  it("normalizes @ prefix", () => {
    assert.equal(normalizeHandle("@Ada_Obi"), "ada_obi");
  });

  it("rejects reserved handles", () => {
    const r = validateHandle("admin");
    assert.equal(r.ok, false);
  });

  it("accepts valid handles", () => {
    const r = validateHandle("victor_97");
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.handle, "victor_97");
  });

  it("rejects short handles", () => {
    const r = validateHandle("ab");
    assert.equal(r.ok, false);
  });
});
