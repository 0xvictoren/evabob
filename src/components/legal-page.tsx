import Link from "next/link";

export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-dvh bg-[#f7fafb] px-5 py-12 text-[#0b1620]">
      <article className="mx-auto max-w-3xl rounded-3xl border border-[#dce8ed] bg-white p-7 shadow-sm sm:p-12">
        <Link href="/" className="text-sm text-[#007fb3] underline">
          Evabob
        </Link>
        <h1 className="mt-6 text-4xl leading-tight">{title}</h1>
        <p className="mt-2 text-sm text-[#64727e]">Last updated: {updated}</p>
        <div className="mt-10 space-y-8 text-[15px] leading-7 text-[#263845]">
          {children}
        </div>
        <nav className="mt-12 flex gap-5 border-t border-[#dce8ed] pt-6 text-sm">
          <Link href="/privacy" className="text-[#007fb3] underline">Privacy notice</Link>
          <Link href="/terms" className="text-[#007fb3] underline">Terms</Link>
        </nav>
      </article>
    </main>
  );
}

export function LegalSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-2 text-xl text-[#0b1620]">{title}</h2>
      {children}
    </section>
  );
}
