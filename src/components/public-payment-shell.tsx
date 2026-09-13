import Image from "next/image";
import Link from "next/link";

import logo from "../../mobile/assets/logo.png";

export function money(amount: number, token: string): string {
  const symbol = token.toUpperCase() === "EURC" ? "€" : "$";
  return `${symbol}${new Intl.NumberFormat("en", {
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount)}`;
}

export function PublicPaymentShell({
  eyebrow,
  title,
  amount,
  children,
  primaryHref,
  primaryLabel,
  disabled = false,
}: {
  eyebrow: string;
  title: string;
  amount?: string;
  children: React.ReactNode;
  primaryHref?: string;
  primaryLabel?: string;
  disabled?: boolean;
}) {
  const androidUrl = process.env.NEXT_PUBLIC_ANDROID_APP_URL;
  const iosUrl = process.env.NEXT_PUBLIC_IOS_APP_URL;

  return (
    <main className="min-h-dvh bg-[#f2faff] px-5 py-8 text-[#0b1620]">
      <div className="mx-auto flex min-h-[calc(100dvh-4rem)] max-w-[390px] flex-col">
        <header className="flex items-center gap-3">
          <Image
            src={logo}
            alt="Evabob"
            width={42}
            height={42}
            className="rounded-full border border-[#dcebf3] bg-white p-1"
            priority
          />
          <div>
            <p className="text-[15px] leading-5">evabob</p>
            <p className="text-[11px] leading-4 text-[#64727e]">Arc testnet</p>
          </div>
        </header>

        <section className="my-auto py-12">
          <p className="mb-3 text-center text-[11px] uppercase tracking-[0.16em] text-[#64727e]">
            {eyebrow}
          </p>
          {amount ? (
            <p className="mb-3 text-center text-[56px] leading-none tracking-[-0.05em]">
              {amount}
            </p>
          ) : null}
          <h1 className="text-center text-[22px] leading-7">{title}</h1>

          <div className="mt-8 rounded-2xl border border-[#dcebf3] bg-white p-5 shadow-[0_8px_24px_rgba(0,181,255,0.08)]">
            {children}
          </div>

          {primaryHref && primaryLabel ? (
            <a
              href={disabled ? undefined : primaryHref}
              aria-disabled={disabled}
              className={`mt-6 flex h-14 w-full items-center justify-center rounded-xl text-[15px] text-white shadow-[0_10px_24px_rgba(0,181,255,0.24)] ${
                disabled ? "cursor-not-allowed bg-[#a8bdc8]" : "bg-[#00b5ff] active:scale-[0.98]"
              }`}
            >
              {primaryLabel}
            </a>
          ) : null}

          {(androidUrl || iosUrl) && (
            <div className="mt-5 flex justify-center gap-5 text-[12px] text-[#007fb3]">
              {androidUrl ? <Link href={androidUrl}>Get Android app</Link> : null}
              {iosUrl ? <Link href={iosUrl}>Get iPhone app</Link> : null}
            </div>
          )}
        </section>

        <footer className="text-center text-[10px] leading-4 text-[#7d8b95]">
          Payment status is checked by Evabob before it is shown as paid.
        </footer>
      </div>
    </main>
  );
}
