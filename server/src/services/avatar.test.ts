import assert from "node:assert/strict";
import test from "node:test";
import { avatarFilename, decodeAvatar, stripImageMetadata } from "./avatar.js";

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

test("strips JPEG EXIF and comment segments before storage", () => {
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe1, 0x00, 0x08]),
    Buffer.from("Exif00"),
    Buffer.from([0xff, 0xfe, 0x00, 0x06]),
    Buffer.from("GPS!"),
    Buffer.from([0xff, 0xda, 0x00, 0x02, 0x01, 0x02, 0xff, 0xd9]),
  ]);
  const stripped = stripImageMetadata(jpeg, "image/jpeg");
  assert.equal(stripped.includes(Buffer.from("Exif")), false);
  assert.equal(stripped.includes(Buffer.from("GPS!")), false);
  assert.deepEqual(stripped.subarray(0, 2), Buffer.from([0xff, 0xd8]));
});

test("strips PNG textual and location metadata chunks", () => {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)]);
  };
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("eXIf", Buffer.from("location")),
    chunk("tEXt", Buffer.from("camera")),
    chunk("IDAT", Buffer.from([1, 2, 3])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const stripped = stripImageMetadata(png, "image/png");
  assert.equal(stripped.includes(Buffer.from("location")), false);
  assert.equal(stripped.includes(Buffer.from("camera")), false);
  assert.equal(stripped.includes(Buffer.from("IDAT")), true);
});
