import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireLocalWriterLease,
  allowsDeploymentLeaseHandoff,
} from "./financial-writer-lease.js";

test("only managed overlapping deployments use the advisory handoff", () => {
  assert.equal(allowsDeploymentLeaseHandoff({ RENDER: "true" }), true);
  assert.equal(allowsDeploymentLeaseHandoff({ VERCEL: "1" }), true);
  assert.equal(allowsDeploymentLeaseHandoff({ RENDER: "false" }), false);
  assert.equal(allowsDeploymentLeaseHandoff({}), false);
});

test("only one local process may own the financial writer lease", () => {
  const dir = mkdtempSync(join(tmpdir(), "evabob-writer-"));
  const path = join(dir, "writer.lock");
  const first = acquireLocalWriterLease(path);
  try {
    assert.throws(
      () => acquireLocalWriterLease(path),
      /Another Evabob server is already running on this computer \(process \d+\)/,
    );
    first.release();
    const next = acquireLocalWriterLease(path);
    next.release();
  } finally {
    first.release();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale writer lock is recovered", () => {
  const dir = mkdtempSync(join(tmpdir(), "evabob-stale-writer-"));
  const path = join(dir, "writer.lock");
  try {
    writeFileSync(path, JSON.stringify({ pid: 2_147_483_647 }));
    const lease = acquireLocalWriterLease(path);
    lease.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an old lease cannot delete a replacement writer lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "evabob-replaced-writer-"));
  const path = join(dir, "writer.lock");
  try {
    const lease = acquireLocalWriterLease(path);
    writeFileSync(path, JSON.stringify({ pid: process.pid, leaseId: "replacement" }));
    lease.release();
    assert.equal(existsSync(path), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
