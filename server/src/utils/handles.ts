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
  // Handles are permanent, so a name that reads as Evabob itself
  // ("evabob_support", "evabobteam") would be a permanent impersonation tool.
  if (handle.includes("evabob")) {
    return { ok: false, error: "Handles cannot contain \"evabob\"" };
  }
  return { ok: true, handle };
}
