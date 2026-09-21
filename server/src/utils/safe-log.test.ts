import assert from "node:assert/strict";
import test from "node:test";
import { routeTemplate, safeError } from "./safe-log.js";

test("safeError removes authentication and personal data", () => {
  const dirty =
    "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.signature " +
    "ada@example.com +234 801 234 5678 0x1111111111111111111111111111111111111111 " +
    "https://example.test/claim?token=secret-value";
  const clean = safeError(dirty);
  assert.doesNotMatch(clean, /eyJ|ada@|234 801|0x1111|secret-value/);
  assert.match(clean, /redacted/);
});

test("routeTemplate removes capability ids and upload names", () => {
  assert.equal(routeTemplate("/uploads/evidence_0123456789abcdef0123456789abcdef.jpg"), "/uploads/:file");
  assert.equal(routeTemplate("/v1/claims/a-very-long-capability-secret"), "/v1/claims/:id");
});
