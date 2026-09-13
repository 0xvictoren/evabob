import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "./write-json-atomic.js";

const dirs: string[] = [];

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "evabob-atomic-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("writeJsonAtomic", () => {
  it("writes readable JSON", () => {
    const p = join(scratch(), "db.json");
    writeJsonAtomic(p, { users: [{ id: "ada" }] });
    assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), {
      users: [{ id: "ada" }],
    });
  });

  it("creates missing parent directories", () => {
    const p = join(scratch(), "nested", "deep", "db.json");
    writeJsonAtomic(p, [1, 2, 3]);
    assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), [1, 2, 3]);
  });

  it("replaces existing content wholesale", () => {
    const p = join(scratch(), "db.json");
    writeJsonAtomic(p, { v: 1 });
    writeJsonAtomic(p, { v: 2 });
    assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { v: 2 });
  });

  it("leaves no temp files behind on success", () => {
    const dir = scratch();
    writeJsonAtomic(join(dir, "db.json"), { v: 1 });
    assert.deepEqual(readdirSync(dir), ["db.json"]);
  });

  it("leaves the previous file intact when serialisation throws", () => {
    const dir = scratch();
    const p = join(dir, "db.json");
    writeJsonAtomic(p, { v: "good" });

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.throws(() => writeJsonAtomic(p, circular));

    // The old content must still parse — this is the regression that a bare
    // writeFileSync could not offer, since it truncates before writing.
    assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { v: "good" });
    assert.deepEqual(readdirSync(dir), ["db.json"], "temp file cleaned up");
  });

  it("recovers a directory left holding a corrupt previous write", () => {
    const dir = scratch();
    const p = join(dir, "db.json");
    // Simulate the old failure mode: a half-written file on disk.
    writeFileSync(p, '{"users": [{"id": "ad');
    assert.throws(() => JSON.parse(readFileSync(p, "utf8")));

    writeJsonAtomic(p, { users: [] });
    assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { users: [] });
    assert.ok(existsSync(p));
  });
});
