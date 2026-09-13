import assert from "node:assert/strict";
import test from "node:test";
import { avatarFilename, decodeAvatar } from "./avatar.js";

test("accepts a matching PNG and hides the user id in its filename", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const result = decodeAvatar(`data:image/png;base64,${png.toString("base64")}`, "image/png");
  assert.equal(result.extension, "png");
  const filename = avatarFilename("dynamic-user-secret", result.extension);
  assert.match(filename, /^avatar_[a-f0-9]{32}\.png$/);
  assert.equal(filename.includes("dynamic-user-secret"), false);
});

test("rejects spoofed MIME content and unsupported active image formats", () => {
  const svg = Buffer.from("<svg onload=alert(1)></svg>").toString("base64");
  assert.throws(() => decodeAvatar(`data:image/svg+xml;base64,${svg}`, "image/jpeg"));
  assert.throws(() => decodeAvatar(`data:image/jpeg;base64,${svg}`, "image/jpeg"));
});
