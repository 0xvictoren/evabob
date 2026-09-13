import { money, PublicPaymentShell } from "@/components/public-payment-shell";

type PublicClaim = {
  transferId: string;
  status: "pending" | "claimed" | "refunded";
  amount: number;
  token: string;
  expired: boolean;
  expiresAt: string;
  deepLink: string;
};

async function loadClaim(id: string): Promise<PublicClaim | null> {
  const base = (
    process.env.EVABOB_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    "http://127.0.0.1:8787"
  ).replace(/\/$/, "");
  const response = await fetch(`${base}/v1/public/claims/${encodeURIComponent(id)}`, {
    cache: "no-store",
  });
  if (response.status === 400 || response.status === 404) return null;
  if (!response.ok) throw new Error("Claim is temporarily unavailable");
  return response.json();
}

export default async function ClaimPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; transferId?: string }>;
}) {
  const query = await searchParams;
  const id = (query.transferId || query.token || "").trim();
  let claim: PublicClaim | null = null;
  let unavailable = false;
  if (id) {
    try {
      claim = await loadClaim(id);
    } catch {
      unavailable = true;
    }
  }

  if (!claim) {
    return (
      <PublicPaymentShell
        eyebrow="Held payment"
        title={unavailable ? "We cannot check this payment right now" : "This claim link is not valid"}
      >
        <p className="text-center text-[13px] leading-5 text-[#64727e]">
          {unavailable
            ? "Try again shortly. The held money remains protected."
            : "Use the complete link from your Evabob email, or ask the sender to resend it."}
        </p>
      </PublicPaymentShell>
    );
  }

  const pending = claim.status === "pending" && !claim.expired;
  const title = pending
    ? "Money is waiting for you"
    : claim.status === "claimed"
      ? "This money has already been claimed"
      : "This held payment was refunded";

  return (
    <PublicPaymentShell
      eyebrow="Held payment"
      amount={money(claim.amount, claim.token)}
      title={title}
      primaryHref={claim.deepLink}
      primaryLabel="Open Evabob to claim"
      disabled={!pending}
    >
      <p className="text-[13px] leading-5 text-[#64727e]">
        {pending
          ? "Install or open Evabob, sign in with the email that received this link, and finish wallet setup. Evabob releases only to that verified account."
          : claim.status === "claimed"
            ? "The network already records this payment as claimed."
            : "The claim window ended, so the network returned the money to its sender."}
      </p>
    </PublicPaymentShell>
  );
}
