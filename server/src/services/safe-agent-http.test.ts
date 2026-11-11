import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAgentRequest, validateAgentUrl } from "./safe-agent-http.js";

const allowed = ["https://api.example.com"];

test("agent egress accepts only an exact approved HTTPS origin", () => {
  assert.equal(
    validateAgentUrl("https://api.example.com/data?q=1", allowed).pathname,
    "/data",
  );
  for (const url of [
    "http://api.example.com/data",
    "https://api.example.com:444/data",
    "https://user:pass@api.example.com/data",
    "https://other.example.com/data",
    "https://127.0.0.1/data",
    "https://169.254.169.254/latest/meta-data",
  ]) {
    assert.throws(() => validateAgentUrl(url, allowed));
  }
});

test("an approved URL cannot carry a fragment", () => {
  assert.throws(() =>
    validateAgentUrl("https://api.example.com/data#secret", allowed),
  );
});

test("an agent's request defaults to a plain GET", () => {
  assert.deepEqual(normalizeAgentRequest({}), { method: "GET", headers: {}, body: undefined });
});

test("a POST carries its body, as JSON when it is not already text", () => {
  const req = normalizeAgentRequest({ method: "post", body: { jsonrpc: "2.0", id: 1 } });
  assert.equal(req.method, "POST");
  assert.equal(req.body, '{"jsonrpc":"2.0","id":1}');
  assert.equal(req.headers["content-type"], "application/json");
  assert.equal(normalizeAgentRequest({ method: "POST", body: "a=1" }).headers["content-type"], undefined);
});

test("an agent cannot set the payment, routing or length headers", () => {
  const req = normalizeAgentRequest({
    headers: {
      "Payment-Signature": "forged",
      "X-Payment": "forged",
      Host: "internal",
      "Content-Length": "1",
      Cookie: "a=b",
      "X-Api-Key": "abc",
      "Bad\nName": "x",
      "X-Split": "a\r\nInjected: 1",
    },
  });
  assert.deepEqual(req.headers, { "x-api-key": "abc" });
});

test("unsupported methods, bodies on GET and oversized bodies are refused", () => {
  assert.throws(() => normalizeAgentRequest({ method: "TRACE" }));
  assert.throws(() => normalizeAgentRequest({ method: "GET", body: { a: 1 } }));
  assert.throws(() => normalizeAgentRequest({ method: "POST", body: "x".repeat(262_145) }));
});
