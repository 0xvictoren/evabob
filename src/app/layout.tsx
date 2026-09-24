import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const numans = localFont({
  src: "../fonts/Numans-Regular.ttf",
  variable: "--font-numans",
  display: "swap",
  weight: "400",
  style: "normal",
});

export const metadata: Metadata = {
  title: "Evabob",
  description: "Send money to anyone by @handle or email.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // Browser extensions (Grammarly, wallet and launcher extensions) add
    // attributes to <html> and <body> before React loads. This ignores only
    // those two elements' own attributes, not anything inside them.
    <html lang="en" className={numans.variable} suppressHydrationWarning>
      <body className="font-sans antialiased" suppressHydrationWarning>{children}</body>
    </html>
  );
}
