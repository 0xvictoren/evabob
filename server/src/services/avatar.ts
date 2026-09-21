import { createHash } from "node:crypto";

export type AvatarMime = "image/jpeg" | "image/png" | "image/webp";

const allowed = new Set<AvatarMime>(["image/jpeg", "image/png", "image/webp"]);

function stripJpegMetadata(bytes: Buffer): Buffer {
  const parts: Buffer[] = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1]!;
    if (marker === 0xda || marker === 0xd9) {
      parts.push(bytes.subarray(offset));
      return Buffer.concat(parts);
    }
    const size = bytes.readUInt16BE(offset + 2);
    const end = offset + 2 + size;
    if (size < 2 || end > bytes.length) return bytes;
    const metadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!metadata) parts.push(bytes.subarray(offset, end));
    offset = end;
  }
  return bytes;
}

function stripPngMetadata(bytes: Buffer): Buffer {
  const parts: Buffer[] = [bytes.subarray(0, 8)];
  const privateChunks = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (end > bytes.length) return bytes;
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (!privateChunks.has(type)) parts.push(bytes.subarray(offset, end));
    offset = end;
    if (type === "IEND") return Buffer.concat(parts);
  }
  return bytes;
}

function stripWebpMetadata(bytes: Buffer): Buffer {
  const parts: Buffer[] = [bytes.subarray(0, 12)];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = bytes.subarray(offset, offset + 4).toString("ascii");
    const size = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size % 2);
    if (end > bytes.length) return bytes;
    if (type !== "EXIF" && type !== "XMP ") parts.push(bytes.subarray(offset, end));
    offset = end;
  }
  const result = Buffer.concat(parts);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

/** Removes EXIF, GPS, comments and textual metadata before persistence. */
export function stripImageMetadata(bytes: Buffer, mime: AvatarMime): Buffer {
  if (mime === "image/jpeg") return stripJpegMetadata(bytes);
  if (mime === "image/png") return stripPngMetadata(bytes);
  return stripWebpMetadata(bytes);
}

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
  let bytes: Buffer = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > 256 * 1024) {
    throw new Error("Avatar must be 256 KB or smaller");
  }
  if (!hasMagic(bytes, mime)) throw new Error("Avatar content does not match its MIME type");
  bytes = stripImageMetadata(bytes, mime);
  const extension = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  return { bytes, mime, extension };
}

export function avatarFilename(userId: string, extension: string): string {
  const owner = createHash("sha256").update(userId).digest("hex").slice(0, 32);
  return `avatar_${owner}.${extension}`;
}
