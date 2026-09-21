import { spawnSync } from "node:child_process";

const exceptionExpires = new Date("2026-12-31T23:59:59Z");
const acceptedCircleTree = new Set([
  "@circle-fin/adapter-circle-wallets",
  "@circle-fin/adapter-solana-kit",
  "@circle-fin/adapter-viem-v2",
  "@circle-fin/app-kit",
  "@circle-fin/bridge-kit",
  "@circle-fin/developer-controlled-wallets",
  "@circle-fin/earn-kit",
  "@circle-fin/provider-cctp-v2",
  "@circle-fin/provider-earn-service",
  "@circle-fin/provider-gateway-v1",
  "@circle-fin/provider-stablecoin-service-swap",
  "@circle-fin/swap-kit",
  "@circle-fin/unified-balance-kit",
  "@coral-xyz/anchor",
  "@coral-xyz/borsh",
  "@ethersproject/abi",
  "@ethersproject/abstract-provider",
  "@ethersproject/abstract-signer",
  "@ethersproject/hash",
  "@ethersproject/signing-key",
  "@ethersproject/transactions",
  "@solana/web3.js",
  "elliptic",
  "jayson",
  "stream-json",
  "toml",
  "uuid",
]);

const result = process.platform === "win32"
  ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm audit --omit=dev --json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
    })
  : spawnSync("npm", ["audit", "--omit=dev", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
let report;
try {
  report = JSON.parse(result.stdout || "{}");
} catch {
  process.stderr.write(result.stderr || "npm audit did not return JSON\n");
  process.exit(1);
}
if (result.error || report.error || !report.metadata?.vulnerabilities) {
  process.stderr.write(
    result.error?.message ||
      report.error?.summary ||
      report.error?.detail ||
      result.stderr ||
      "npm audit could not verify the dependency tree.\n",
  );
  process.exit(1);
}
const vulnerabilities = report.vulnerabilities ?? {};
const unknown = Object.entries(vulnerabilities).filter(
  ([name, finding]) =>
    !acceptedCircleTree.has(name) || finding.severity === "critical",
);
if (Date.now() > exceptionExpires.getTime() && Object.keys(vulnerabilities).length > 0) {
  process.stderr.write("The temporary Circle dependency exception has expired.\n");
  process.exit(1);
}
if (unknown.length > 0) {
  process.stderr.write(
    `Unapproved production advisories: ${unknown.map(([name]) => name).join(", ")}\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `Production audit gate passed with ${Object.keys(vulnerabilities).length} documented Circle-tree exception(s).\n`,
);
