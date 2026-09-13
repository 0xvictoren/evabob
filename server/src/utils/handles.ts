import { RESERVED_HANDLES } from "../config.js";

export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

export function validateHandle(
  raw: string,
): { ok: true; handle: string } | { ok: false; error: string } {
  const handle = normalizeHandle(raw);
  if (!/^[a-z0-9_]{3,24}$/.test(handle)) {
    return {
      ok: false,
      error: "Handle must be 3–24 chars: letters, numbers, underscore",
    };
  }
  if (RESERVED_HANDLES.has(handle)) {
    return { ok: false, error: "That @handle is reserved" };
  }
  return { ok: true, handle };
}
