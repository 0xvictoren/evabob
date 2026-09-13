import { request } from "node:https";
import { lookup } from "node:dns";
import { isIP } from "node:net";

export function isPublicIpv4(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2))
    || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
}

export function validateAgentUrl(raw: string, allowedOrigins: string[]): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash
    || (url.port && url.port !== "443") || !allowedOrigins.includes(url.origin)) {
    throw new Error("Resource must use an approved HTTPS origin");
  }
  // Only DNS hosts are accepted; the connection below pins a validated public
  // IPv4 result. IPv6 is deliberately unsupported until equivalent filtering.
  if (isIP(url.hostname) || url.hostname.startsWith("[")) throw new Error("IP-literal URLs are not allowed");
  return url;
}

export function safeAgentGet(
  raw: string,
  allowedOrigins: string[],
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string; headers: Record<string, string> }> {
  const url = validateAgentUrl(raw, allowedOrigins);
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "GET", headers: { Accept: "application/json", ...headers },
      // Validation is performed by the actual socket lookup, not a separate
      // preflight lookup vulnerable to DNS rebinding.
      lookup(host, _options, callback) {
        lookup(host, { family: 4, all: true }, (error, addresses) => {
          if (error || !addresses.length || addresses.some(a => !isPublicIpv4(a.address))) {
            callback(error || new Error("Non-public destination rejected"), []);
            return;
          }
          // Node's custom lookup callback accepts either a single address or
          // the array form only when the caller requested `all`; handle both
          // shapes so this remains safe across Node versions.
          if ((_options as { all?: boolean }).all) callback(null, addresses);
          else callback(null, addresses[0].address, 4);
        });
      },
    }, res => {
      // No redirects: an approved origin cannot bounce into an internal host.
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
        res.destroy(); reject(new Error("Redirects are not allowed")); return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1_048_576) { req.destroy(new Error("Response too large")); return; }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        const responseHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (typeof value === "string") responseHeaders[name.toLowerCase()] = value;
          else if (Array.isArray(value)) responseHeaders[name.toLowerCase()] = value.join(", ");
        }
        resolve({
          status: res.statusCode || 502,
          text: Buffer.concat(chunks).toString("utf8"),
          headers: responseHeaders,
        });
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error("Request timed out")), 15_000);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", reject);
    req.end();
  });
}
