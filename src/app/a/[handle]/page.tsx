import { PublicPaymentShell } from "@/components/public-payment-shell";
import { loadPublic } from "@/lib/public-api";

type PublicAgent = {
  handle: string;
  label: string;
  byline: string;
  owner: { handle: string | null; name: string | null };
  address: string | null;
  onChain: boolean;
  since: string;
  active: boolean;
  record: {
    hiredAndPaid: number;
    hiredNotDelivered: number;
    hiredReviewed: number;
    hiring: number;
    callsDelivered: number;
    callsNotCharged: number;
    callsPaidNotDelivered: number;
  };
};

function sinceLabel(iso: string): string {
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(new Date(iso));
}

/** A named agent: who owns it, and how it has treated people and sellers. */
export default async function AgentPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  let agent: PublicAgent | null = null;
  let unavailable = false;
  try {
    agent = await loadPublic<PublicAgent>(`agents/${encodeURIComponent(decodeURIComponent(handle).replace(/^@/, ""))}`);
  } catch {
    unavailable = true;
  }

  if (!agent) {
    return (
      <PublicPaymentShell eyebrow="Agent" title={unavailable ? "We cannot open this right now" : "No agent by that name"}>
        <p className="text-center text-[13px] leading-5 text-[#64727e]">
          {unavailable ? "Try again in a moment." : "Check the name and try again."}
        </p>
      </PublicPaymentShell>
    );
  }

  const r = agent.record;
  const hired = r.hiredAndPaid + r.hiredNotDelivered + r.hiredReviewed;
  return (
    <PublicPaymentShell eyebrow="Agent" title={agent.handle}>
      <div className="space-y-4 text-[13px] leading-5">
        <p className="text-center text-[15px]">{agent.byline}</p>
        {!agent.active ? (
          <p className="rounded-xl bg-[#fff4f2] p-3 text-center">Its owner has switched it off.</p>
        ) : null}
        <div className="space-y-2 border-t border-[#e5f0f5] pt-4">
          <Row label="Owned by" value={agent.owner.handle ?? agent.owner.name ?? "—"} />
          <Row label="On Evabob since" value={sinceLabel(agent.since)} />
          <Row
            label="People it hired"
            value={
              hired === 0
                ? "None yet"
                : `Paid ${r.hiredAndPaid} of ${hired}${r.hiring ? ` · ${r.hiring} in progress` : ""}`
            }
          />
          <Row
            label="Paid calls"
            value={
              r.callsDelivered + r.callsNotCharged + r.callsPaidNotDelivered === 0
                ? "None yet"
                : `${r.callsDelivered} delivered · ${r.callsNotCharged} not charged`
            }
          />
          <Row label="Registered on chain" value={agent.onChain ? "Yes, as an agent identity" : "Pending"} />
        </div>
        <p className="rounded-xl bg-[#f2faff] p-3 text-[12px]">
          Pay it by name in Evabob: money goes to the agent&apos;s own wallet, never its owner&apos;s, and
          when it hires someone the money is set aside before they start.
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
