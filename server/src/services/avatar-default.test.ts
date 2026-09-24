import { test } from "node:test";
import assert from "node:assert/strict";
import { avatarBundleFor, defaultAvatarBundle } from "./avatar.js";

// Mirrors mobile/test/avatar_default_test.dart: both sides must agree.
test("default picture matches the app for the same account id", () => {
  assert.equal(defaultAvatarBundle("user_abc"), 21);
  assert.equal(defaultAvatarBundle("ekuma-123"), 15);
  assert.equal(defaultAvatarBundle("0f3a9c1e-77aa-4b4b-9d2e-1c2b3a4d5e6f"), 3);
});

test("a chosen picture or an upload wins over the default", () => {
  assert.equal(avatarBundleFor({ id: "u", avatarBundleIndex: 4 }), 4);
  assert.equal(avatarBundleFor({ id: "u", avatarUrl: "/uploads/u.jpg" }), null);
  assert.equal(avatarBundleFor({ id: "user_abc" }), 21);
});
