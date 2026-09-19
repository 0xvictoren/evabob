import { NextResponse, type NextRequest } from "next/server";

/**
 * One paywall link for people and software alike.
 *
 * A person's browser asks for HTML and gets the page (app/x/[id]). Software
 * — an x402 client paying, or anything that does not ask for HTML — is sent
 * to the paywall itself on the API, which answers 402 with the terms, then
 * serves what was paid for.
 */
export function proxy(request: NextRequest) {
  const accept = request.headers.get("accept") ?? "";
  const paying = request.headers.has("payment-signature");
  if (!paying && accept.includes("text/html")) return NextResponse.next();

  const api = (
    process.env.EVABOB_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    "http://127.0.0.1:8787"
  ).replace(/\/$/, "");
  const target = new URL(`${api}${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.rewrite(target);
}

export const config = {
  matcher: "/x/:path*",
};
