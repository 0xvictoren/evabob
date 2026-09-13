import { BottomNav } from "@/components/bottom-nav";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <main className="min-h-dvh">{children}</main>
      <BottomNav />
    </div>
  );
}
