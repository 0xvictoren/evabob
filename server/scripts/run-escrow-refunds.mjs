const apiOrigin = process.env.API_PUBLIC_URL?.trim().replace(/\/$/, "");
const cronSecret = process.env.CRON_SECRET?.trim();

if (!apiOrigin || !cronSecret) {
  console.error("[refund-cron] API_PUBLIC_URL and CRON_SECRET are required");
  process.exit(1);
}

let endpoint;
try {
  // The route may be passed as an argument (or CRON_PATH), so one script
  // drives any internal cron route — e.g. "/internal/cron/tick?refunds=1".
  const url = new URL(
    process.argv[2]?.trim() || process.env.CRON_PATH?.trim() || "/internal/cron/escrow-refunds",
    apiOrigin,
  );
  if (url.protocol !== "https:" || url.origin !== apiOrigin) {
    throw new Error("API_PUBLIC_URL must be an exact HTTPS origin");
  }
  endpoint = url;
} catch (error) {
  console.error(
    `[refund-cron] invalid API_PUBLIC_URL: ${error instanceof Error ? error.message : "invalid URL"}`,
  );
  process.exit(1);
}

try {
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${cronSecret}` },
    signal: AbortSignal.timeout(55_000),
  });
  const body = await response.text();
  if (!response.ok) {
    console.error(`[refund-cron] API returned HTTP ${response.status}`);
    process.exit(1);
  }
  console.log(`[refund-cron] completed: ${body.slice(0, 2_000)}`);
} catch (error) {
  console.error(
    `[refund-cron] request failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exit(1);
}
