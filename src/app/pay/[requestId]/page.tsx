import { money, PublicPaymentShell } from "@/components/public-payment-shell";

type PublicInvoice = {
  id: string;
  status: "open" | "paid" | "partial" | "escrow" | "released" | "refunded" | "cancelled" | "expired";
  amount: number;
  total: number;
  token: string;
  description: string;
  note?: string;
  issuer: string;
  expiresAt?: string | null;
  deepLink: string;
  items: Array<{ description: string; amount: number }>;
};

async function loadInvoice(id: string): Promise<PublicInvoice | null> {
  const base = (
    process.env.EVABOB_API_BASE_URL ||
    process.env.NEXT_PUBLIC_API_BASE_URL ||
    "http://127.0.0.1:8787"
  ).replace(/\/$/, "");
  const response = await fetch(
    `${base}/v1/public/payment-requests/${encodeURIComponent(id)}`,
    { cache: "no-store" },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Payment request is temporarily unavailable");
  return response.json();
}

const terminalCopy: Record<string, string> = {
  paid: "This request has already been paid.",
  escrow: "This payment is being held until the work is released.",
  released: "This held payment has been released.",
  refunded: "This payment was refunded.",
  cancelled: "This request was cancelled.",
  expired: "This request has expired.",
  partial: "This request has been partly paid.",
};

export default async function PayPage({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const { requestId } = await params;
  let invoice: PublicInvoice | null = null;
  let unavailable = false;
  try {
    invoice = await loadInvoice(requestId);
  } catch {
    unavailable = true;
  }

  if (!invoice) {
    return (
      <PublicPaymentShell
        eyebrow="Payment request"
        title={unavailable ? "We cannot check this request right now" : "This payment link is not valid"}
      >
        <p className="text-center text-[13px] leading-5 text-[#64727e]">
          {unavailable
            ? "Try again in a moment. No payment has been taken."
            : "Ask the sender for a new Evabob link."}
        </p>
      </PublicPaymentShell>
    );
  }

  const open = invoice.status === "open";
  return (
    <PublicPaymentShell
      eyebrow="Payment request"
      amount={money(invoice.total, invoice.token)}
      title={open ? `${invoice.issuer} requested money` : terminalCopy[invoice.status] || "Request updated"}
      primaryHref={invoice.deepLink}
      primaryLabel={open ? "Open Evabob to pay" : "Open in Evabob"}
      disabled={!open && invoice.status !== "partial" && invoice.status !== "escrow"}
    >
      <div className="space-y-4">
        {invoice.items.map((item, index) => (
          <div key={`${item.description}-${index}`} className="flex gap-4 text-[13px] leading-5">
            <span className="min-w-0 flex-1 text-[#64727e]">{item.description}</span>
            <span>{money(item.amount, invoice.token)}</span>
          </div>
        ))}
        {invoice.note ? (
          <div className="border-t border-[#e5f0f5] pt-4 text-[12px] leading-5 text-[#64727e]">
            {invoice.note}
          </div>
        ) : null}
      </div>
    </PublicPaymentShell>
  );
}
