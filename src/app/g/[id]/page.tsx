import { AutoRefresh } from "@/components/auto-refresh";
import { money, PublicPaymentShell } from "@/components/public-payment-shell";
import { loadPublic, shortDate } from "@/lib/public-api";

type PublicPot = {
  id: string;
  title: string;
  description: string;
  state: "open" | "released" | "refunding" | "draft";
  organizer: string;
  beneficiary: string;
  targetUsdc: number;
  raisedUsdc: number;
  deadline: string;
  contributors: number;
  releasedAt: string | null;
  deepLink: string;
};

function daysLeft(deadline: string): string {
  const ms = Date.parse(deadline) - Date.now();
  if (ms <= 0) return "Deadline passed";
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  return days > 0 ? `${days} day${days === 1 ? "" : "s"} left` : `${hours} hour${hours === 1 ? "" : "s"} left`;
}

export default async function PotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let pot: PublicPot | null = null;
  let unavailable = false;
  if (id.startsWith("p_")) {
    try {
      pot = await loadPublic<PublicPot>(`groups/${encodeURIComponent(id)}`);
    } catch {
      unavailable = true;
    }
  }

  if (!pot) {
    return (
      <PublicPaymentShell
        eyebrow="Group collection"
        title={
          unavailable
            ? "We cannot open this collection right now"
            : id.startsWith("c_")
              ? "Money circles are private to their members"
              : "This link is not valid"
        }
      >
        <p className="text-center text-[13px] leading-5 text-[#64727e]">
          {unavailable
            ? "Try again in a moment."
            : id.startsWith("c_")
              ? "Open Evabob to see your circle."
              : "Ask the organizer for a new link."}
        </p>
      </PublicPaymentShell>
    );
  }

  const pct = Math.min(100, Math.round((pot.raisedUsdc / pot.targetUsdc) * 100));
  const open = pot.state === "open" && Date.parse(pot.deadline) > Date.now();
  const title =
    pot.state === "released"
      ? `Reached — paid to ${pot.beneficiary}`
      : pot.state === "refunding" || (!open && pot.state === "open")
        ? "Did not reach its target — everyone is refunded"
        : pot.title;

  return (
    <PublicPaymentShell
      eyebrow={pot.state === "released" ? pot.title : "Group collection"}
      amount={money(pot.raisedUsdc, "USDC")}
      title={title}
      primaryHref={open ? pot.deepLink : undefined}
      primaryLabel={open ? "Open Evabob to chip in" : undefined}
    >
      {open ? <AutoRefresh seconds={20} /> : null}
      <div className="space-y-4 text-[13px] leading-5">
        <div>
          <div className="h-3 w-full overflow-hidden rounded-full bg-[#e5f0f5]" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-[#00b5ff]" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-2 flex text-[12px] text-[#64727e]">
            <span className="flex-1">
              {pct}% of {money(pot.targetUsdc, "USDC")}
            </span>
            <span>{pot.state === "open" ? daysLeft(pot.deadline) : shortDate(pot.releasedAt ?? pot.deadline)}</span>
          </div>
        </div>

        {pot.description ? <p>{pot.description}</p> : null}

        <div className="space-y-2 border-t border-[#e5f0f5] pt-4">
          <Row label="For" value={pot.beneficiary} />
          <Row label="Organised by" value={pot.organizer} />
          <Row label="People who chipped in" value={String(pot.contributors)} />
          <Row label="Deadline" value={shortDate(pot.deadline)} />
        </div>

        <p className="rounded-xl bg-[#f2faff] p-3 text-[12px] text-[#0b1620]">
          Nobody holds this money. It goes to {pot.beneficiary} the moment the target is reached. If the
          deadline passes first, everyone gets back exactly what they put in, automatically.
        </p>
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
