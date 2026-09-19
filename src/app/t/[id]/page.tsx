import { AutoRefresh } from "@/components/auto-refresh";
import { money, PublicPaymentShell } from "@/components/public-payment-shell";
import { loadPublic, shortDate } from "@/lib/public-api";

type PublicTask = {
  id: string;
  title: string;
  description: string;
  amountUsdc: number;
  deliveryDays: number;
  open: boolean;
  takeable: boolean;
  status: string;
  statusText: string;
  openUntil: string | null;
  agent: {
    label: string;
    handle: string | null;
    owner: string | null;
    byline: string;
    record: { hiredAndPaid: number; hiredNotDelivered: number; hiredReviewed: number; hiring: number };
  };
  deepLink: string;
};

/**
 * A task an agent will pay a person for. The point of the page is the line
 * people do not get with bounties: the money is set aside before you start.
 */
export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let task: PublicTask | null = null;
  let unavailable = false;
  try {
    task = await loadPublic<PublicTask>(`tasks/${encodeURIComponent(id)}`);
  } catch {
    unavailable = true;
  }

  if (!task) {
    return (
      <PublicPaymentShell eyebrow="Paid task" title={unavailable ? "We cannot open this right now" : "This task does not exist"}>
        <p className="text-center text-[13px] leading-5 text-[#64727e]">
          {unavailable ? "Try again in a moment." : "Check the link."}
        </p>
      </PublicPaymentShell>
    );
  }

  const r = task.agent.record;
  const hired = r.hiredAndPaid + r.hiredNotDelivered + r.hiredReviewed;
  return (
    <PublicPaymentShell
      eyebrow="Paid task"
      amount={money(task.amountUsdc, "USDC")}
      title={task.title}
      primaryHref={task.takeable ? task.deepLink : undefined}
      primaryLabel={task.takeable ? "Open Evabob to take it" : undefined}
    >
      {task.status === "locking" ? <AutoRefresh seconds={15} /> : null}
      <div className="space-y-4 text-[13px] leading-5">
        {task.description ? <p>{task.description}</p> : null}
        <p className="rounded-xl bg-[#f2faff] p-3">
          The money is set aside before you start. Take it and {money(task.amountUsdc, "USDC")} is locked
          for you; deliver within {task.deliveryDays} days and it is yours. Nothing delivered, and it goes
          back to the agent.
        </p>
        <div className="space-y-2 border-t border-[#e5f0f5] pt-4">
          <Row label="Paid by" value={task.agent.byline} />
          <Row
            label="Its record"
            value={hired === 0 ? "Has not hired anyone yet" : `Paid ${r.hiredAndPaid} of ${hired} people it hired`}
          />
          <Row label="Now" value={task.statusText} />
          {task.openUntil ? <Row label="Open until" value={shortDate(task.openUntil)} /> : null}
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
