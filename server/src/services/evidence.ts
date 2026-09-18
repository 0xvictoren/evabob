/**
 * Photos attached to a review conversation: the parcel at the door, the
 * damaged item, the chat where something was agreed.
 *
 * Stored like profile photos (Mongo, with local disk as a cache) but under a
 * random name, so a photo is reachable only by someone given its path — the
 * two people and the reviewer. Size and type are checked the same way.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dataPath } from "../utils/data-path.js";
import { decodeAvatar, type AvatarMime } from "./avatar.js";
import { mongoReady, mongoSaveAvatar } from "./mongo.js";

export const EVIDENCE_FILE = /^evidence_[a-f0-9]{32}\.(jpg|png|webp)$/;

export async function storeEvidencePhoto(imageBase64: string, mime: AvatarMime): Promise<string> {
  const photo = decodeAvatar(imageBase64, mime);
  const filename = `evidence_${randomBytes(16).toString("hex")}.${photo.extension}`;
  if (mongoReady()) await mongoSaveAvatar(filename, photo.mime, photo.bytes);
  const dir = dataPath("uploads");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, filename), photo.bytes);
  return `/uploads/${filename}`;
}
