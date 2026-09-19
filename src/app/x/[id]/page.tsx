import { money, PublicPaymentShell } from "@/components/public-payment-shell";
import { loadPublic } from "@/lib/public-api";

type PublicPaywall = {
  id: string;
  kind: "file" | "text" | "api" | "time";
  title: string;
  description: string;
  priceUsdc: number;
  active: boolean;
  seller: {
    name: string;
    handle: string;
    record: { delivered: number; notCharged: number; declined: number };
  };
  files: Array<{ name: string; bytes: number; mime: string }>;
  time: { minutes: number } | null;
  resourceUrl: string;
  network: string;
};

/** Sub-cent prices are normal here; show them rather than round to $0.01. */
function price(amount: number): string {
  return amount < 0.01 ? `$${amount.toFixed(3).replace(/0+$/, "")}` : money(amount, "USDC");
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const WHAT: Record<PublicPaywall["kind"], string> = {
  file: "Files",
  text: "Text",
  api: "An API, per call",
  time: "Time with a person",
};

/**
 * The page a person sees on a paywall link. Software asking for the same
 * link is sent to the paywall itself by src/proxy.ts and asked to pay.
 */
export default async function PaywallPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let paywall: PublicPaywall | null = null;
  let unavailable = false;
  try {
    paywall = await loadPublic<PublicPaywall>(`paywalls/${encodeURIComponent(id)}`);
  } catch {
    unavailable = true;
  }

  if (!paywall) {
    return (
      <PublicPaymentShell
        eyebrow="For software and AI agents"
        title={unavailable ? "We cannot open this right now" : "This link is not valid"}
      >
        <p className="text-center text-[13px] leading-5 text-[#64727e]">
          {unavailable ? "Try again in a moment." : "Ask the seller for a new link."}
        </p>
      </PublicPaymentShell>
    );
  }

  const r = paywall.seller.record;
  return (
    <PublicPaymentShell
      eyebrow="For software and AI agents"
      amount={price(paywall.priceUsdc)}
      title={paywall.active ? paywall.title : `${paywall.title} — no longer for sale`}
    >
      <div className="space-y-4 text-[13px] leading-5">
        {paywall.description ? <p>{paywall.description}</p> : null}

        <p className="rounded-xl bg-[#f2faff] p-3">
          {paywall.kind === "time"
            ? `Nothing is charged until ${paywall.seller.handle || paywall.seller.name} accepts the booking.`
            : "Paid after proof: software is charged only if what it gets back is usable."}
        </p>

        <div className="space-y-2 border-t border-[#e5f0f5] pt-4">
          <Row label="What" value={paywall.time ? `${WHAT.time} · ${paywall.time.minutes} min` : WHAT[paywall.kind]} />
          <Row label="Sold by" value={`${paywall.seller.name} ${paywall.seller.handle}`.trim()} />
          <Row
            label="Record"
            value={
              r.delivered + r.notCharged + r.declined === 0
                ? "No sales yet"
                : `${r.delivered} delivered · ${r.notCharged} not charged`
            }
          />
          {paywall.files.map((f) => (
            <Row key={f.name} label="File" value={`${f.name} · ${size(f.bytes)}`} />
          ))}
        </div>

        <div className="rounded-xl border border-[#e5f0f5] p-3 text-[12px] text-[#64727e]">
          <p className="mb-1 text-[#0b1620]">For whoever sets up the software</p>
          <p>
            Request this link with <span className="font-mono">GET</span>. It answers HTTP 402 with
            x402 payment terms (Circle Gateway, USDC on Arc testnet). Pay, then request again with a{" "}
            <span className="font-mono">Payment-Signature</span> header.
          </p>
          <p className="mt-2 break-all font-mono text-[11px]">{paywall.resourceUrl}</p>
        </div>
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
