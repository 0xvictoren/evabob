import { notFound } from "next/navigation";

import { BottomNav } from "@/components/bottom-nav";

/**
 * The early design mock-up (mock data only, no API calls). A hosted site must
 * not show a made-up person's wallet and balances to real visitors, so it is
 * served only in development, or where EVABOB_SHOW_MOCKUP=true is set.
 */
const showMockup =
  process.env.NODE_ENV !== "production" || process.env.EVABOB_SHOW_MOCKUP === "true";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  if (!showMockup) notFound();
  return (
    <div className="app-shell">
      <main className="min-h-dvh">{children}</main>
      <BottomNav />
    </div>
  );
}
