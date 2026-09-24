import Image from "next/image";
import Link from "next/link";

import logo from "../../mobile/assets/logo.png";

/**
 * The public front door. It used to redirect to the design mock-up, which
 * showed a made-up person's wallet and balances to anyone who opened the
 * domain — confusing for real visitors and a ready-made phishing template.
 */
export default function RootPage() {
  const androidUrl = process.env.NEXT_PUBLIC_ANDROID_APP_URL || null;
  const iosUrl = process.env.NEXT_PUBLIC_IOS_APP_URL || null;

  return (
    <main className="min-h-dvh bg-white px-5 text-[#0b1620]">
      <div className="mx-auto flex max-w-[390px] flex-col items-center pb-10 pt-16 text-center">
        <div className="flex size-[88px] items-center justify-center rounded-full bg-[#f0faff]">
          <Image src={logo} alt="Evabob" width={40} height={40} priority />
        </div>
        <h1 className="mt-8 text-[40px] leading-[48px] tracking-[-1px]">Evabob</h1>
        <p className="mt-3 text-[16px] leading-[22px] text-[#5a6b78]">
          Send money like a message. Pay anyone by their @handle or email, and
          hold money safely until the work arrives.
        </p>

        <div className="mt-8 w-full rounded-xl bg-[#fff7ec] px-4 py-3 text-[14px] leading-[18px] text-[#8a4b00]">
          Evabob is running on a test network. Test money has no value.
        </div>

        <div className="mt-8 flex w-full flex-col gap-4">
          {androidUrl ? (
            <a
              href={androidUrl}
              className="flex h-14 w-full items-center justify-center rounded-xl bg-[#00b5ff] text-[14px] text-white"
            >
              Get Evabob for Android
            </a>
          ) : null}
          {iosUrl ? (
            <a
              href={iosUrl}
              className="flex h-14 w-full items-center justify-center rounded-xl bg-[#f0faff] text-[14px] text-[#00b5ff]"
            >
              Get Evabob for iPhone
            </a>
          ) : null}
        </div>

        <p className="mt-10 text-[13px] leading-[18px] text-[#64727e]">
          Evabob never asks for your PIN, recovery phrase or private key.
        </p>
        <nav className="mt-6 flex gap-5 text-sm">
          <Link href="/privacy" className="text-[#007fb3] underline">
            Privacy notice
          </Link>
          <Link href="/terms" className="text-[#007fb3] underline">
            Terms
          </Link>
        </nav>
      </div>
    </main>
  );
}
