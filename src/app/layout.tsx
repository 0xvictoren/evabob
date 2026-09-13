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
  description: "Send money to anyone — phone, email, or handle.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={numans.variable}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
