import Image from "next/image";
import { headers } from "next/headers";

import { money } from "@/components/public-payment-shell";
import logo from "../../../mobile/assets/logo.png";

type PublicClaim = {
  transferId: string;
  status: "pending" | "claimed" | "refunded";
  amount: number;
  token: string;
  expired: boolean;
  expiresAt: string;
  createdAt?: string;
  deepLink: string;
  sender?: { name: string; handle: string | null } | null;
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

/** "Tuesday" within the week, otherwise "3 Oct". */
function until(iso: string): string {
  const at = new Date(iso);
  const days = (at.getTime() - Date.now()) / 86_400_000;
  return days < 6
    ? at.toLocaleDateString("en-GB", { weekday: "long" })
    : at.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const card = "rounded-xl bg-white shadow-[0_0_24px_-6px_rgba(11,22,32,0.06)]";
const primary =
  "flex h-14 w-full items-center justify-center rounded-xl bg-[#00b5ff] text-[14px] leading-[18px] tracking-[-0.1px] text-white shadow-[0_0_24px_-6px_rgba(0,181,255,0.28)] active:scale-[0.98]";
const secondary =
  "flex h-14 w-full items-center justify-center rounded-xl bg-[#f0faff] text-[14px] leading-[18px] tracking-[-0.1px] text-[#00b5ff] active:scale-[0.98]";

function Fact({ label, value, last = false }: { label: string; value: string; last?: boolean }) {
  return (
    <div
      className={`flex h-[52px] items-center justify-between gap-4 text-[14px] leading-[18px] tracking-[-0.1px] ${
        last ? "" : "border-b border-[#e6ebef]"
      }`}
    >
      <span className="text-[#0b1620]">{label}</span>
      <span className="text-right text-[#5a6b78]">{value}</span>
    </div>
  );
}

/** Figma "evabob.me link page" (52:2426): held money, and how to get it. */
export default async function ClaimPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; transferId?: string }>;
}) {
  const query = await searchParams;
  const host = (await headers()).get("host") || "evabob.me";
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

  const appUrl =
    process.env.NEXT_PUBLIC_ANDROID_APP_URL || process.env.NEXT_PUBLIC_IOS_APP_URL || null;
  const pending = !!claim && claim.status === "pending" && !claim.expired;
  const from = claim?.sender?.name?.trim() || "Someone";

  const sub = !claim
    ? unavailable
      ? "We cannot check this payment right now. Try again shortly; the money stays protected."
      : "This link is not valid. Use the complete link from your email, or ask the sender to resend it."
    : pending
      ? `${from} sent this to you`
      : claim.status === "claimed"
        ? "This money has already been claimed"
        : `Nobody claimed it in time, so it went back to ${from.split(/\s+/)[0]}`;

  return (
    <main className="min-h-dvh bg-white px-5 text-[#0b1620]">
      <div className="mx-auto flex max-w-[390px] flex-col pb-10 pt-12">
        <div className="flex h-9 items-center justify-center rounded-full bg-[#f0faff] text-[14px] leading-[18px] tracking-[-0.1px] text-[#5a6b78]">
          {host}/claim
        </div>

        <div className="mx-auto mt-9 flex size-[88px] items-center justify-center rounded-full bg-[#f0faff]">
          <Image src={logo} alt="Evabob" width={40} height={40} priority />
        </div>

        <p className="mt-8 text-center text-[48px] leading-[56px] tracking-[-1px] tabular-nums">
          {claim ? money(claim.amount, claim.token) : "Held payment"}
        </p>
        <p className="mt-2 text-center text-[14px] leading-[18px] tracking-[-0.1px] text-[#5a6b78]">
          {sub}
        </p>

        {pending && claim ? (
          <>
            <div className={`${card} mt-[30px] px-4 py-1`}>
              <Fact label="Held safely until" value={until(claim.expiresAt)} />
              <Fact label="Cost to receive" value="Nothing" />
              <Fact label="You will need" value="An email address" last />
            </div>

            <div className="mt-12 flex flex-col gap-4">
              <a href={appUrl ?? claim.deepLink} className={primary}>
                Get Evabob and claim it
              </a>
              <a href={claim.deepLink} className={secondary}>
                I already have Evabob
              </a>
            </div>

            <p className="mt-[38px] text-center text-[10px] leading-[14px] tracking-[0.8px] text-[#64727e]">
              THIS LINK ONLY WORKS ONCE
            </p>
          </>
        ) : (
          <div className="mt-12 flex flex-col gap-4">
            {appUrl ? (
              <a href={appUrl} className={secondary}>
                Get Evabob
              </a>
            ) : null}
          </div>
        )}
      </div>
    </main>
  );
}
