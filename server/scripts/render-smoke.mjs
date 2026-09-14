const apiOrigin = process.env.API_PUBLIC_URL?.trim().replace(/\/$/, "");
const appOrigin = process.env.APP_PUBLIC_URL?.trim().replace(/\/$/, "");

function exactHttpsOrigin(name, raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.origin !== raw) throw new Error();
    return url.origin;
  } catch {
    console.error(`[render-smoke] ${name} must be an exact HTTPS origin`);
    process.exit(1);
  }
}

const api = exactHttpsOrigin("API_PUBLIC_URL", apiOrigin);
const web = exactHttpsOrigin("APP_PUBLIC_URL", appOrigin);
const failures = [];

async function check(name, url, options, assertion) {
  try {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.text();
    const result = assertion(response, body);
    if (!result) failures.push(`${name}: HTTP ${response.status}`);
    console.log(`${result ? "PASS" : "FAIL"} ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : "request failed"}`);
    console.log(`FAIL ${name}`);
  }
}

await check("API liveness", `${api}/health/live`, {}, (response) => response.ok);
await check("API readiness", `${api}/health/ready`, {}, (response, body) => {
  if (!response.ok) return false;
  try {
    const parsed = JSON.parse(body);
    return parsed.status === "ready" && parsed.database === "connected" && parsed.persistence === "mongo";
  } catch {
    return false;
  }
});
await check("Public feature discovery", `${api}/v1/config/public`, {}, (response) => response.ok);
await check("Public web health", `${web}/api/health`, {}, (response) => response.ok);
await check(
  "Allowed CORS origin",
  `${api}/v1/config/public`,
  { headers: { origin: web } },
  (response) => response.headers.get("access-control-allow-origin") === web,
);
await check(
  "Rejected CORS origin",
  `${api}/v1/config/public`,
  { headers: { origin: "https://not-evabob.invalid" } },
  (response) => !response.headers.has("access-control-allow-origin"),
);

if (failures.length) {
  console.error("[render-smoke] failures:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("[render-smoke] hosted public checks passed");
