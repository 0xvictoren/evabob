import assert from "node:assert/strict";
import test from "node:test";
import { validateAgentUrl } from "./safe-agent-http.js";

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
