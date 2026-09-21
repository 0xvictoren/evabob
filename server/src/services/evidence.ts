/**
 * Photos attached to a review conversation: the parcel at the door, the
 * damaged item, the chat where something was agreed.
 *
 * Stored like profile photos (Mongo, with local disk as a cache) but under a
 * random name, so a photo is reachable only by someone given its path — the
 * two people and the reviewer. Size and type are checked the same way.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dataPath } from "../utils/data-path.js";
import { decodeAvatar, type AvatarMime } from "./avatar.js";
import { mongoDeleteAvatars, mongoReady, mongoSaveAvatar } from "./mongo.js";
import { store } from "../store/db.js";

export const EVIDENCE_FILE = /^evidence_[a-f0-9]{32}\.(jpg|png|webp)$/;
/** Photos sent in a chat: the same rules, their own name. */
export const CHAT_PHOTO_FILE = /^chatphoto_[a-f0-9]{32}\.(jpg|png|webp)$/;

export type PrivateMediaContext = {
  ownerUserId: string;
  contextId: string;
  participants: string[];
};

export function storeEvidencePhoto(
  imageBase64: string,
  mime: AvatarMime,
  context: PrivateMediaContext,
): Promise<string> {
  return storePhoto("evidence", "review", imageBase64, mime, context);
}

export function storeChatPhoto(
  imageBase64: string,
  mime: AvatarMime,
  context: PrivateMediaContext,
): Promise<string> {
  return storePhoto("chatphoto", "chat", imageBase64, mime, context);
}

async function storePhoto(
  prefix: "evidence" | "chatphoto",
  kind: "review" | "chat",
  imageBase64: string,
  mime: AvatarMime,
  context: PrivateMediaContext,
): Promise<string> {
  const photo = decodeAvatar(imageBase64, mime);
  const filename = `${prefix}_${randomBytes(16).toString("hex")}.${photo.extension}`;
  if (mongoReady()) await mongoSaveAvatar(filename, photo.mime, photo.bytes);
  const dir = dataPath("uploads");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, filename), photo.bytes);
  const retentionDays = kind === "review" ? 365 : 180;
  store.registerMedia({
    filename,
    kind,
    ownerUserId: context.ownerUserId,
    contextId: context.contextId,
    participants: [...new Set([context.ownerUserId, ...context.participants].filter(Boolean))],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString(),
    retentionState: "active",
  });
  return `/uploads/${filename}`;
}

export async function deleteStoredMedia(filenames: string[]): Promise<void> {
  const safe = filenames.filter(
    (filename) =>
      EVIDENCE_FILE.test(filename) ||
      CHAT_PHOTO_FILE.test(filename) ||
      /^avatar_[a-f0-9]{32}\.(jpg|png|webp)$/.test(filename),
  );
  await mongoDeleteAvatars(safe).catch(() => 0);
  const dir = dataPath("uploads");
  for (const filename of safe) {
    const path = resolve(dir, filename);
    if (!existsSync(path)) continue;
    try {
      unlinkSync(path);
    } catch {
      // The record is inaccessible already; a later retention job may retry
      // removal of a locked local cache file.
    }
  }
}
