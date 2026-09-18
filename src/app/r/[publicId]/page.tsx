import { AutoRefresh } from "@/components/auto-refresh";
import { money, PublicPaymentShell } from "@/components/public-payment-shell";
import { loadPublic, shortDate } from "@/lib/public-api";

type Stage = "sending" | "on_the_way" | "done" | "held" | "returned" | "failed";

type PublicReceipt = {
  publicId: string;
  amount: number;
  landedAmount: number;
  token: string;
  from: string;
  to: string;
  createdAt: string;
  stage: Stage;
  heldFor?: "order" | "cooling_off" | "sign_up";
  check: {
    status: "verified" | "not_verified" | "not_yet" | "unavailable";
    txHash?: string;
    explorerUrl?: string;
    checkedAt?: string;
  };
};

const STEPS: Array<{ stage: Stage; label: string }> = [
  { stage: "sending", label: "Sending" },
  { stage: "on_the_way", label: "On the way" },
  { stage: "done", label: "Done" },
];

const HELD_COPY: Record<NonNullable<PublicReceipt["heldFor"]>, (from: string, to: string) => string> = {
  order: (from, to) =>
    `The money has left ${from} and is set aside for ${to} until the order arrives. If it never does, it goes back.`,
  cooling_off: (from, to) =>
    `The money has left ${from}. It reaches ${to} in a few minutes, once a short safety window ends.`,
  sign_up: (from, to) =>
    `The money has left ${from} and is waiting for ${to} to collect it in Evabob.`,
};

function titleFor(r: PublicReceipt): string {
  switch (r.stage) {
    case "done":
      return r.check.status === "not_verified" ? "This payment could not be confirmed" : "Paid";
    case "held":
      return `Set aside for ${r.to}`;
    case "returned":
      return `Returned to ${r.from}`;
    case "failed":
      return "This payment did not go through";
    case "on_the_way":
      return "On the way";
    default:
      return "Sending";
  }
}

export default async function ReceiptPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;
  let receipt: PublicReceipt | null = null;
  let unavailable = false;
  try {
    receipt = await loadPublic<PublicReceipt>(`receipts/${encodeURIComponent(publicId)}`);
  } catch {
    unavailable = true;
  }

  if (!receipt) {
    return (
      <PublicPaymentShell
        eyebrow="Payment"
        title={unavailable ? "We cannot check this payment right now" : "This link is not valid"}
      >
        <p className="text-center text-[13px] leading-5 text-[#64727e]">
          {unavailable
            ? "Try again in a moment."
            : "Ask the person who paid to share the link from their Evabob app again."}
        </p>
      </PublicPaymentShell>
    );
  }

  const moving = receipt.stage === "sending" || receipt.stage === "on_the_way";
  const stepIndex = STEPS.findIndex((s) => s.stage === receipt.stage);
  const verified = receipt.stage === "done" && receipt.check.status === "verified";

  return (
    <PublicPaymentShell
      eyebrow={verified ? "Paid ✓" : "Payment"}
      amount={money(receipt.amount, receipt.token)}
      title={titleFor(receipt)}
    >
      {moving ? <AutoRefresh seconds={8} /> : null}
      <div className="space-y-4 text-[13px] leading-5">
        {stepIndex >= 0 ? (
          <ol className="flex items-center gap-2" aria-label="Where this payment is">
            {STEPS.map((step, i) => (
              <li key={step.stage} className="flex flex-1 flex-col items-center gap-1">
                <span
                  className={`h-1.5 w-full rounded-full ${
                    i <= stepIndex ? "bg-[#00b5ff]" : "bg-[#e5f0f5]"
                  }`}
                />
                <span className={i <= stepIndex ? "text-[#0b1620]" : "text-[#7d8b95]"}>
                  {step.label}
                </span>
              </li>
            ))}
          </ol>
        ) : null}

        <Row label="From" value={receipt.from} />
        <Row label="To" value={receipt.to} />
        <Row label={receipt.stage === "done" ? "They received" : "They receive"} value={money(receipt.landedAmount, receipt.token)} />
        <Row label="When" value={shortDate(receipt.createdAt)} />

        {receipt.stage === "held" ? (
          <p className="border-t border-[#e5f0f5] pt-4 text-[12px] text-[#64727e]">
            {HELD_COPY[receipt.heldFor ?? "sign_up"](receipt.from, receipt.to)}
          </p>
        ) : null}

        {receipt.stage === "done" ? <Check check={receipt.check} /> : null}
      </div>
    </PublicPaymentShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-4">
      <span className="min-w-0 flex-1 text-[#64727e]">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

function Check({ check }: { check: PublicReceipt["check"] }) {
  const hash = check.txHash ? `${check.txHash.slice(0, 10)}…${check.txHash.slice(-6)}` : null;
  return (
    <div className="border-t border-[#e5f0f5] pt-4 text-[12px] leading-5">
      {check.status === "verified" ? (
        <p className="text-[#0b7a3b]">
          ✓ Checked on the Arc network just now: this exact amount reached the recipient.
        </p>
      ) : check.status === "not_verified" ? (
        <p className="text-[#b42318]">
          The Arc network does not show this payment as described. Do not hand anything over
          until you see the money yourself.
        </p>
      ) : (
        <p className="text-[#64727e]">Recorded as paid by Evabob.</p>
      )}
      {check.explorerUrl ? (
        <p className="mt-2 text-[#64727e]">
          Don&apos;t take our word for it —{" "}
          <a className="text-[#007fb3] underline" href={check.explorerUrl} target="_blank" rel="noreferrer">
            check it yourself on Arcscan
          </a>
          {hash ? <span className="block font-mono text-[11px] text-[#7d8b95]">{hash}</span> : null}
        </p>
      ) : null}
    </div>
  );
}
