import assert from "node:assert/strict";
import test from "node:test";
import { remediatePlaintextAgentKeys } from "./credential-remediation.js";

const incidentAt = "2026-09-21T10:11:00.000Z";

test("first remediation revokes plaintext keys and records a permanent marker", () => {
  const app: Record<string, unknown> & {
    agents: Record<string, unknown>[];
  } = {
    agents: [
      { id: "a", apiKeyFull: "secret-a" },
      { id: "b", apiKeyFull: "secret-b" },
      { id: "c" },
    ],
  };

  assert.deepEqual(remediatePlaintextAgentKeys(app, incidentAt), {
    firstRun: true,
    revoked: 2,
  });
  assert.equal(app.agents.some((agent) => "apiKeyFull" in agent), false);
  assert.equal(app.agents[0]?.revokedAt, incidentAt);
  assert.equal(app.agents[1]?.revokedAt, incidentAt);
  assert.deepEqual(app.security, { plaintextAgentKeysPurgedAt: incidentAt });
});

test("subsequent clean startup is a no-op", () => {
  const app = {
    agents: [{ id: "a", revokedAt: incidentAt }],
    security: { plaintextAgentKeysPurgedAt: incidentAt },
  };

  assert.deepEqual(remediatePlaintextAgentKeys(app, incidentAt), {
    firstRun: false,
    revoked: 0,
  });
});

test("startup refuses plaintext keys that reappear after remediation", () => {
  const app = {
    agents: [{ id: "a", apiKeyFull: "regression" }],
    security: { plaintextAgentKeysPurgedAt: incidentAt },
  };

  assert.throws(
    () => remediatePlaintextAgentKeys(app, incidentAt),
    /plaintext agent keys reappeared/,
  );
});
