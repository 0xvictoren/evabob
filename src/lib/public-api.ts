/**
 * Reads the Evabob API's public, no-account endpoints from server components.
 * Returns null for an unknown id and throws when the API cannot be reached, so
 * a page can tell "this link is wrong" apart from "try again in a moment".
 */
export async function loadPublic<T>(path: string): Promise<T | null> {
  const base = (
    process.env.EVABOB_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    "http://127.0.0.1:8787"
  ).replace(/\/$/, "");
  const response = await fetch(`${base}/v1/public/${path}`, { cache: "no-store" });
  if (response.status === 400 || response.status === 404) return null;
  if (!response.ok) throw new Error("Evabob is temporarily unavailable");
  return response.json();
}

export function shortDate(iso: string): string {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(iso));
}
