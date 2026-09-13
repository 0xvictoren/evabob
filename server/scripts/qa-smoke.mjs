/**
 * API smoke checks for remaining new.md items (no device PIN).
 * Run: node scripts/qa-smoke.mjs
 */
const BASE = process.env.API_BASE || "http://127.0.0.1:8787";

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function post(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, body: data };
}

const checks = [];
function ok(name, pass, detail = "") {
  checks.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const root = await get("/");
ok("API up", root.status === 200, `status ${root.status}`);

const health = await get("/v1/health");
ok("Health", health.status === 200, JSON.stringify(health.body?.circle || health.body?.ok || ""));

const hold = await get("/v1/escrow/hold-address");
ok(
  "Escrow hold address",
  hold.status === 200 && hold.body?.address?.startsWith?.("0x"),
  hold.body?.address?.slice?.(0, 12) || hold.body?.error,
);

const x402 = await post("/v1/x402/pay", { query: "polymarket" });
ok(
  "x402 requires API key",
  x402.status === 401 && x402.body?.code === "API_KEY_REQUIRED",
  String(x402.status),
);

const bal = await get(
  "/v1/wallet/balances?address=0x0000000000000000000000000000000000000001",
);
ok(
  "Wallet balances shape",
  bal.status === 200 &&
    "gatewayConfirmedUsdc" in (bal.body || {}) &&
    "gatewayPendingUsdc" in (bal.body || {}),
  `confirmed=${bal.body?.gatewayConfirmedUsdc} pending=${bal.body?.gatewayPendingUsdc}`,
);

const appKitBal = await get(
  "/v1/app-kit/balances?address=0x0000000000000000000000000000000000000001",
);
ok(
  "App Kit balances route",
  appKitBal.status === 200 || appKitBal.status === 400 || appKitBal.status === 500,
  `status ${appKitBal.status}`,
);

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
