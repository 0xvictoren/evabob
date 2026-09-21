import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dynamicIssuer,
  validateDynamicClaims,
  verifiedEmailFromClaims,
} from "./dynamic-auth.js";

const environmentId = "6b48d938-66fa-4259-bacc-1142403886f6";
const audience = "https://evabob.app";
const now = 1_800_000_000;

function complete(overrides: Record<string, unknown> = {}) {
  return {
    sub: "dynamic-user-1",
    iss: dynamicIssuer(environmentId),
    aud: audience,
    environment_id: environmentId,
    scope: "user:basic",
    iat: now - 60,
    exp: now + 3600,
    email: "person@example.com",
    verified_credentials: [
      { id: "credential-1", email: "person@example.com", oauth_provider: "emailOnly" },
    ],
    ...overrides,
  };
}

describe("Dynamic session claim validation", () => {
  it("accepts a complete end-user authentication token", () => {
    const claims = validateDynamicClaims(complete(), { environmentId, audience, nowSeconds: now });
    assert.equal(claims?.sub, "dynamic-user-1");
    assert.equal(claims?.email, "person@example.com");
  });

  it("rejects incomplete authentication and a missing user:basic scope", () => {
    assert.equal(
      validateDynamicClaims(complete({ scope: "" }), { environmentId, audience, nowSeconds: now }),
      null,
    );
    assert.equal(
      validateDynamicClaims(complete({ verified_credentials: undefined }), {
        environmentId,
        audience,
        nowSeconds: now,
      }),
      null,
    );
  });

  it("rejects a wrong environment, issuer, audience, and elevated intermediate token", () => {
    for (const patch of [
      { environment_id: "other" },
      { iss: "https://attacker.invalid" },
      { aud: "https://attacker.invalid" },
      { scope: "user:basic requiresAdditionalAuth" },
    ]) {
      assert.equal(
        validateDynamicClaims(complete(patch), { environmentId, audience, nowSeconds: now }),
        null,
      );
    }
  });

  it("rejects expired, future-issued, and invalid-lifetime tokens", () => {
    for (const patch of [
      { exp: now - 31 },
      { iat: now + 31 },
      { iat: now + 100, exp: now + 10 },
    ]) {
      assert.equal(
        validateDynamicClaims(complete(patch), { environmentId, audience, nowSeconds: now }),
        null,
      );
    }
  });

  it("never treats an unverified top-level email as owned", () => {
    const raw = complete({
      email: "attacker@example.com",
      verified_credentials: [{ email: "person@example.com" }],
    });
    assert.equal(verifiedEmailFromClaims(raw), "person@example.com");
  });
});
