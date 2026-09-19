/**
 * The work that runs on a schedule, in one place, so the local once-a-minute
 * timer and the hosted /internal/cron/tick run exactly the same steps.
 *
 * Each step is independent and idempotent: one failing does not stop the
 * rest, and running twice or late only repeats or delays work.
 */

type StepResult<T> = T | { error: string };

async function step<T>(run: () => Promise<T> | T): Promise<StepResult<T>> {
  try {
    return await run();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function runTickWork() {
  const [{ runDueHeldPaymentWork }, { completeAbandonedBridges }, { runGatewayTracker }, { sendInvoiceReminders }, { runGroupMoneyWork }] =
    await Promise.all([
      import("./heldPayments.js"),
      import("./appKitMoney.js"),
      import("./gatewayTracker.js"),
      import("./invoiceReminders.js"),
      import("./groupMoney.js"),
    ]);
  const { runInboundSweep } = await import("./inboundChains.js");
  return {
    held: await step(() => runDueHeldPaymentWork()),
    bridges: await step(() => completeAbandonedBridges()),
    gateway: await step(() => runGatewayTracker()),
    invoices: await step(() => sendInvoiceReminders()),
    groups: await step(() => runGroupMoneyWork()),
    // Money arriving while the app is closed: recorded and announced anyway.
    inbound: await step(() => runInboundSweep()),
  };
}

/** True when a tick did something worth a log line. */
export function tickWasBusy(r: Awaited<ReturnType<typeof runTickWork>>): boolean {
  const busy = (v: unknown, keys: string[]) =>
    Boolean(v && typeof v === "object" && ("error" in v || keys.some((k) => {
      const x = (v as Record<string, unknown>)[k];
      return Array.isArray(x) ? x.length > 0 : Boolean(x);
    })));
  return (
    busy(r.held, ["released", "errors"]) ||
    busy(r.bridges, ["completed", "errors"]) ||
    busy(r.gateway, ["paymentsFinished", "topUpsArrived", "errors"]) ||
    busy(r.invoices, ["reminded"]) ||
    busy(r.groups, ["collected", "paidOut", "refunded", "errors"]) ||
    busy(r.inbound, ["recorded"])
  );
}
