import { createHash } from "node:crypto";

export type AvatarMime = "image/jpeg" | "image/png" | "image/webp";

const allowed = new Set<AvatarMime>(["image/jpeg", "image/png", "image/webp"]);

function hasMagic(bytes: Buffer, mime: AvatarMime): boolean {
  if (mime === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mime === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  }
  return bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

export function decodeAvatar(
  input: string,
  declaredMime: AvatarMime = "image/jpeg",
): { bytes: Buffer; mime: AvatarMime; extension: "jpg" | "png" | "webp" } {
  let encoded = input;
  let mime = declaredMime;
  const dataUrl = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input);
  if (input.startsWith("data:") && !dataUrl) throw new Error("Invalid avatar data URL");
  if (dataUrl) {
    if (!allowed.has(dataUrl[1] as AvatarMime)) throw new Error("Unsupported avatar type");
    if (declaredMime && dataUrl[1] !== declaredMime) throw new Error("Avatar MIME type mismatch");
    mime = dataUrl[1] as AvatarMime;
    encoded = dataUrl[2];
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error("Invalid avatar encoding");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > 256 * 1024) {
    throw new Error("Avatar must be 256 KB or smaller");
  }
  if (!hasMagic(bytes, mime)) throw new Error("Avatar content does not match its MIME type");
  const extension = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  return { bytes, mime, extension };
}

export function avatarFilename(userId: string, extension: string): string {
  const owner = createHash("sha256").update(userId).digest("hex").slice(0, 32);
  return `avatar_${owner}.${extension}`;
}
