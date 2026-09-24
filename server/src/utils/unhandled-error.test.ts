import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyUnhandled } from "./unhandled-error.js";

test("unhandled: a Circle session failure asks for a fresh session", () => {
  const e = { response: { status: 401, data: { code: 155104, message: "invalid user token" } } };
  const r = classifyUnhandled(e, "R1");
  assert.equal(r.status, 401);
  assert.equal(r.body.code, "UCW_SESSION_EXPIRED");
});

test("unhandled: any other Circle refusal is not called our fault", () => {
  const e = { response: { status: 400, data: { code: 2, message: "API parameter invalid" } } };
  const r = classifyUnhandled(e, "R2");
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Ref R2/);
});

test("unhandled: an RPC failure reads as a busy network", () => {
  const e = Object.assign(new Error("HTTP request failed"), { name: "HttpRequestError" });
  assert.equal(classifyUnhandled(e, "R3").status, 503);
  const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  assert.equal(classifyUnhandled(reset, "R4").status, 503);
});

test("unhandled: a real bug stays a 500, with a reference to find it", () => {
  const r = classifyUnhandled(new TypeError("x is undefined"), "R5");
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { error: "internal_error", code: "R5" });
});
