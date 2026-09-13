import { resolve } from "node:path";

/**
 * Writable runtime storage.
 *
 * Local development keeps the existing `server/data` layout. Hosted services
 * set DATA_DIR to a mounted persistent volume so uploads, recovery mirrors and
 * the financial-writer lock survive a container replacement.
 */
export const dataDir = process.env.DATA_DIR?.trim()
  ? resolve(process.env.DATA_DIR.trim())
  : process.env.VERCEL
    ? resolve("/tmp", "evabob")
  : resolve(process.cwd(), "data");

export function dataPath(...segments: string[]): string {
  return resolve(dataDir, ...segments);
}
