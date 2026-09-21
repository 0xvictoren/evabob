import { createHmac, randomBytes } from "node:crypto";

const logKey = randomBytes(32);

export function logPseudonym(value: string | undefined): string | null {
  if (!value) return null;
  return createHmac("sha256", logKey).update(value).digest("hex").slice(0, 12);
}

export function routeTemplate(path: string): string {
  const parts = path.split("/").map((part, index, all) => {
    if (!part) return part;
    const parent = all[index - 1]?.toLowerCase();
    if (parent === "uploads") return ":file";
    if (
      ["receipts", "hold-links", "claims", "payment-requests", "groups", "agents", "paywalls", "tasks"].includes(
        parent,
      )
    ) return ":id";
    if (/^[A-Za-z0-9_-]{20,}$/.test(part) || /^0x[a-fA-F0-9]{40,64}$/.test(part)) {
      return ":id";
    }
    return part;
  });
  return parts.join("/");
}

export function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-jwt]")
    .replace(/sk_(?:evabob|sendit)_[A-Za-z0-9_-]+/gi, "[redacted-agent-key]")
    .replace(/(?:mongodb(?:\+srv)?):\/\/[^\s@/]+@/gi, "mongodb://[redacted]@")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "[redacted-phone]")
    .replace(/\b0x[a-fA-F0-9]{40,64}\b/g, "[redacted-chain-id]")
    .replace(/([?&](?:token|secret|key|code)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(?:avatar|evidence|chatphoto)_[a-f0-9]{24,32}\.(?:jpg|png|webp)/gi, "[redacted-upload]")
    .replace(/\/(receipts|hold-links|claims|payment-requests)\/[A-Za-z0-9_-]+/gi, "/$1/[redacted]")
    .slice(0, 500);
}

let safeConsoleInstalled = false;

/** Defense in depth for third-party errors and older call sites. */
export function installSafeConsole(): void {
  if (safeConsoleInstalled) return;
  safeConsoleInstalled = true;
  for (const name of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[name].bind(console);
    console[name] = ((...values: unknown[]) => {
      original(
        ...values.map((value) => {
          if (typeof value === "string" || value instanceof Error) return safeError(value);
          if (value && typeof value === "object") {
            try {
              return safeError(JSON.stringify(value));
            } catch {
              return "[unserializable-log-value]";
            }
          }
          return value;
        }),
      );
    }) as typeof console[typeof name];
  }
}
