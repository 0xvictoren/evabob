/**
 * Claim / receive emails via Mailtrap (or any SMTP).
 * Requires SMTP_HOST, SMTP_USER, SMTP_PASS in server/.env
 */

import nodemailer from "nodemailer";
import { config } from "../config.js";
import { logPseudonym, safeError } from "../utils/safe-log.js";

export type NotifySendInput = {
  toEmail?: string;
  toHandle: string;
  fromName: string;
  amountUsdc: number;
  memo?: string;
  mode: "instant" | "escrow" | "pending";
  /** Opaque claim token for escrow (optional) */
  claimToken?: string;
};

export function smtpConfigured(): boolean {
  return Boolean(config.smtp.host && config.smtp.user && config.smtp.pass);
}

function claimUrl(input: NotifySendInput): string {
  const base = config.appPublicUrl.replace(/\/$/, "");
  const email = encodeURIComponent(input.toEmail || input.toHandle);
  if (input.claimToken) {
    return `${base}/claim?token=${encodeURIComponent(input.claimToken)}&email=${email}`;
  }
  return `${base}/claim?email=${email}`;
}

/**
 * A note typed by the sender, as it may appear in an email to a stranger.
 * Links are removed: an Evabob email must never carry a link Evabob did not
 * write, or a tiny payment becomes a way to send phishing from Evabob.
 */
export function emailSafeNote(note: string | undefined): string | undefined {
  const cleaned = (note ?? "")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link removed]")
    .trim();
  return cleaned || undefined;
}

/** Tiny amounts in full, so a 0.000001 payment never reads as "0.00". */
function emailAmount(amount: number): string {
  return amount >= 0.01 ? amount.toFixed(2) : String(Number(amount.toFixed(6)));
}

function buildMessage(input: NotifySendInput): { subject: string; text: string; html: string } {
  const amt = emailAmount(input.amountUsdc);
  input = { ...input, memo: emailSafeNote(input.memo) };
  const memo = input.memo ? `\nNote: “${input.memo}”` : "";
  const link = claimUrl(input);

  if (input.mode === "instant") {
    const subject = `You received ${amt} USDC on Evabob`;
    const text = `${input.fromName} sent you ${amt} USDC.${memo}

It's already in your Evabob balance. Open the app to check activity.

— ${config.appName}`;
    const html = `<p><strong>${escapeHtml(input.fromName)}</strong> sent you <strong>${amt} USDC</strong>.</p>
${input.memo ? `<p>Note: ${escapeHtml(input.memo)}</p>` : ""}
<p>It's already in your Evabob balance.</p>
<p>— ${escapeHtml(config.appName)}</p>`;
    return { subject, text, html };
  }

  // escrow / pending — include claim link. A fixed subject: the sender's
  // own words never reach the subject line of an email from Evabob.
  const subject = `You have ${amt} USDC waiting on Evabob`;
  const text = `${input.fromName} sent you ${amt} USDC.${memo}

You don't have an Evabob wallet linked yet, so the funds are held safely until you claim them.

1. Install / open Evabob
2. Sign in with this email: ${input.toEmail || input.toHandle}
3. Set up your wallet, then open:
${link}

— ${config.appName}`;
  const html = `<p><strong>${escapeHtml(input.fromName)}</strong> sent you <strong>${amt} USDC</strong>.</p>
${input.memo ? `<p>Note: ${escapeHtml(input.memo)}</p>` : ""}
<p>Funds are held until you join Evabob with <strong>${escapeHtml(input.toEmail || input.toHandle)}</strong>.</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;background:#059669;color:#fff;border-radius:999px;text-decoration:none;font-weight:700">Claim on Evabob</a></p>
<p style="color:#666;font-size:12px">Or open: ${escapeHtml(link)}</p>
<p>— ${escapeHtml(config.appName)}</p>`;
  return { subject, text, html };
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let _transporter: nodemailer.Transporter | null = null;

function transporter() {
  if (!smtpConfigured()) return null;
  if (!_transporter) {
    // Mailtrap sandbox: sandbox.smtp.mailtrap.io, port 2525 (or 587)
    _transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port || 2525,
      secure: config.smtp.secure,
      auth: {
        user: config.smtp.user,
        pass: config.smtp.pass,
      },
    });
  }
  return _transporter;
}

export async function notifySend(input: NotifySendInput): Promise<{
  emailSent: boolean;
  detail: string;
  claimUrl?: string;
}> {
  if (!input.toEmail || !input.toEmail.includes("@")) {
    return { emailSent: false, detail: "no recipient email" };
  }

  const msg = buildMessage(input);
  const link = claimUrl(input);

  if (!smtpConfigured()) {
    console.log("[notify:email] SMTP not configured — would send", {
      recipient: logPseudonym(input.toEmail),
      mode: input.mode,
    });
    return { emailSent: false, detail: "smtp not configured", claimUrl: link };
  }

  try {
    const t = transporter()!;
    const info = await t.sendMail({
      from: config.smtp.from,
      to: input.toEmail,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    const sandbox = /mailtrap/i.test(config.smtp.host || "");
    console.log("[notify:email] sent", {
      recipient: logPseudonym(input.toEmail),
      mode: input.mode,
      message: logPseudonym(info.messageId),
      host: config.smtp.host,
      sandbox,
    });
    return {
      emailSent: true,
      detail: sandbox
        ? "sent (Mailtrap sandbox — open Mailtrap Email Testing inbox, not Gmail)"
        : "sent",
      claimUrl: link,
    };
  } catch (e) {
    const detail = safeError(e);
    console.warn("[notify:email] failed", detail);
    return { emailSent: false, detail, claimUrl: link };
  }
}

/** Send a verification code to the user's email (phone link flow). */
export async function sendVerificationEmail(input: {
  toEmail: string;
  code: string;
  purpose?: string;
}): Promise<{ emailSent: boolean; detail: string }> {
  const purpose = input.purpose || "Verify your phone number";
  const subject = `${config.appName} verification code: ${input.code}`;
  const text = `${purpose}

Your verification code is: ${input.code}

This code expires in 15 minutes. If you did not request this, ignore this email.

— ${config.appName}`;
  const html = `<p>${escapeHtml(purpose)}</p>
<p style="font-size:28px;font-weight:800;letter-spacing:4px">${escapeHtml(input.code)}</p>
<p style="color:#666;font-size:13px">Expires in 15 minutes.</p>
<p>— ${escapeHtml(config.appName)}</p>`;

  if (!input.toEmail.includes("@")) {
    return { emailSent: false, detail: "no recipient email" };
  }
  if (!smtpConfigured()) {
    console.log("[notify:verify] SMTP not configured");
    return { emailSent: false, detail: "smtp not configured" };
  }
  try {
    await transporter()!.sendMail({
      from: config.smtp.from,
      to: input.toEmail,
      subject,
      text,
      html,
    });
    return { emailSent: true, detail: "sent" };
  } catch (e) {
    const detail = safeError(e);
    console.warn("[notify:verify] failed", detail);
    return { emailSent: false, detail };
  }
}

/** Quick connectivity check (used by /v1/health optional). */
export async function smtpHealth(): Promise<{ ok: boolean; detail: string }> {
  if (!smtpConfigured()) {
    return { ok: false, detail: "SMTP_* not set" };
  }
  try {
    await transporter()!.verify();
    return { ok: true, detail: `SMTP ready (${config.smtp.host})` };
  } catch (e) {
    return {
      ok: false,
      detail: e instanceof Error ? e.message : "smtp verify failed",
    };
  }
}

/**
 * WhatsApp invite for unregistered phone recipients.
 * Uses Meta Cloud API when WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID are set.
 */
export async function notifyWhatsApp(input: {
  toPhone: string;
  fromName: string;
  amountUsdc: number;
  memo?: string;
}): Promise<{ sent: boolean; detail: string }> {
  const amt = input.amountUsdc.toFixed(2);
  const text = `${input.fromName} sent you ${amt} USDC on Evabob. Create an account with this phone number to claim within 3 days. ${config.appPublicUrl}`;
  const to = input.toPhone.replace(/\D/g, "");

  if (!config.whatsapp.token || !config.whatsapp.phoneNumberId) {
    console.log("[notify:whatsapp:stub]", { recipient: logPseudonym(to) });
    return {
      sent: false,
      detail: "whatsapp stub — set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID",
    };
  }

  try {
    const url = `${config.whatsapp.apiBase}/${config.whatsapp.phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.whatsapp.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn("[notify:whatsapp] failed", res.status, safeError(JSON.stringify(data)));
      return {
        sent: false,
        detail: `whatsapp api ${res.status}`,
      };
    }
    console.log("[notify:whatsapp] sent", { recipient: logPseudonym(to) });
    return { sent: true, detail: "sent" };
  } catch (e) {
    const detail = safeError(e);
    console.warn("[notify:whatsapp] error", detail);
    return { sent: false, detail };
  }
}
