import { money, PublicPaymentShell } from "@/components/public-payment-shell";
import { loadPublic } from "@/lib/public-api";

type SellerRecord = {
  delivered: number;
  notDelivered: number;
  refundedAfterReview: number;
  inProgress: number;
};

type PublicHoldLink = {
  id: string;
  title: string;
  description: string;
  amount: number;
  token: string;
  deliveryDays: number;
  active: boolean;
  seller: { name: string; handle: string; memberSince: string };
  record: SellerRecord;
  deepLink: string;
};

function sinceLabel(iso: string): string {
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(new Date(iso));
}

export default async function HoldLinkPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let link: PublicHoldLink | null = null;
  let unavailable = false;
  try {
    link = await loadPublic<PublicHoldLink>(`hold-links/${encodeURIComponent(id)}`);
  } catch {
    unavailable = true;
  }

  if (!link) {
    return (
      <PublicPaymentShell
        eyebrow="Pay safely"
        title={unavailable ? "We cannot open this link right now" : "This link is not valid"}
      >
        <p className="text-center text-[13px] leading-5 text-[#64727e]">
          {unavailable ? "Try again in a moment. Nothing has been paid." : "Ask the seller for a new link."}
        </p>
      </PublicPaymentShell>
    );
  }

  const firstName = link.seller.name.split(" ")[0] || link.seller.handle;
  const r = link.record;
  const finished = r.delivered + r.notDelivered + r.refundedAfterReview;

  return (
    <PublicPaymentShell
      eyebrow="Pay safely"
      amount={money(link.amount, link.token)}
      title={link.title}
      primaryHref={link.deepLink}
      primaryLabel={link.active ? "Open Evabob to pay" : "No longer for sale"}
      disabled={!link.active}
    >
      <div className="space-y-4 text-[13px] leading-5">
        {link.description ? <p className="text-[#0b1620]">{link.description}</p> : null}

        <p className="rounded-xl bg-[#f2faff] p-3 text-[#0b1620]">
          Your money is set aside for {firstName} until your order arrives.
        </p>

        <ol className="space-y-2 text-[12px] text-[#64727e]">
          <li>1. You pay. {firstName} can see it is there but cannot spend it yet.</li>
          <li>2. {firstName} sends your order within {link.deliveryDays} days and marks it delivered.</li>
          <li>
            3. You have 7 days to say it arrived, or tell us if something is wrong. If you say
            nothing, {firstName} is paid.
          </li>
          <li>4. If it is never marked delivered in time, your money comes back to you.</li>
        </ol>

        <div className="border-t border-[#e5f0f5] pt-4">
          <div className="flex gap-4">
            <span className="min-w-0 flex-1 text-[#64727e]">Seller</span>
            <span className="text-right">
              {link.seller.name} <span className="text-[#64727e]">{link.seller.handle}</span>
            </span>
          </div>
          <div className="mt-2 flex gap-4">
            <span className="min-w-0 flex-1 text-[#64727e]">On Evabob since</span>
            <span>{sinceLabel(link.seller.memberSince)}</span>
          </div>
          <div className="mt-2 flex gap-4">
            <span className="min-w-0 flex-1 text-[#64727e]">Track record</span>
            <span className="text-right">
              {finished === 0
                ? "No finished orders yet"
                : `${r.delivered} delivered · ${r.notDelivered} not delivered · ${r.refundedAfterReview} refunded after review`}
            </span>
          </div>
        </div>
      </div>
    </PublicPaymentShell>
  );
}
