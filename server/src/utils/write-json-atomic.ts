import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Serialises `value` to `path` without ever leaving a partial file behind.
 *
 * The stores here previously called
 * `writeFileSync(path, JSON.stringify(db))` directly. That truncates the
 * destination first, so a crash, a full disk, or the process being killed
 * part-way through left a half-written file that `JSON.parse` rejects on the
 * next boot — and the loaders fall back to an empty database, silently
 * discarding every user, escrow job and ledger row.
 *
 * Writing to a sibling temp file and renaming makes the swap atomic: readers
 * see either the previous complete file or the new complete one. The temp
 * file must share a directory with the target so the rename stays within one
 * filesystem.
 *
 * NOTE: this makes each write safe, not each read-modify-write sequence.
 * Callers that read, await, mutate and then write can still lose an update
 * when two requests interleave. Serialising those is a separate change.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  const tmp = join(dir, `.${Date.now()}-${process.pid}.tmp`);
  const body = JSON.stringify(value, null, 2);

  let fd: number | undefined;
  try {
    fd = openSync(tmp, "w");
    writeSync(fd, body);
    // Flush to disk before the rename, so a crash right after cannot leave
    // the directory entry pointing at unwritten data.
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (e) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw e;
  }
}
