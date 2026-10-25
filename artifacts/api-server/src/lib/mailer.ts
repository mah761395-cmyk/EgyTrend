/* EgyTrend mailer — password-reset (and future) emails.
 * SMTP is optional. If it is not configured, sendMail() performs no delivery
 * and writes no recipient, subject, HTML, or reset token to logs. This keeps
 * local development and shared previews from becoming an accidental mailbox
 * or credential sink.
 *
 * When SMTP is configured, the supplied account email is the only recipient;
 * there is no admin-copy or catch-all fallback. */
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { logger } from "./logger";

export type MailResult = { delivered: boolean; error?: "smtp_not_configured" | "nodemailer_missing" | "send_failed" };

type Mailer = {
  createTransport: (opts: unknown) => { sendMail: (msg: unknown) => Promise<unknown> };
};

function projectRoot(): string {
  let dir = __dirname; // dist/lib when built, src/lib when run directly
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "scripts", "backup-db.mjs"))) return dir;
    dir = path.resolve(dir, "..");
  }
  return process.cwd();
}

function smtpConfigured(): boolean {
  return Boolean(process.env["SMTP_HOST"] && process.env["SMTP_USER"] && process.env["SMTP_PASS"]);
}

export function isSmtpConfigured(): boolean {
  return smtpConfigured();
}

let cached: Mailer | null = null;
let loadAttempted = false;

async function loadNodemailer(): Promise<Mailer | null> {
  if (loadAttempted) return cached;
  loadAttempted = true;
  const root = projectRoot();
  for (const base of [
    path.join(root, "tools", "mailer", "node_modules"),
    path.join(root, "node_modules"),
    path.join(root, "artifacts", "api-server", "node_modules"),
  ]) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(base, "nodemailer", "package.json"), "utf8"));
      const entry = path.join(base, "nodemailer", meta.main || "index.js");
      const mod = (await import(pathToFileURL(entry).href)) as unknown as { default?: Mailer } & Mailer;
      cached = (mod.default || mod) as Mailer;
      return cached;
    } catch {
      /* try next location */
    }
  }
  logger.warn("nodemailer not installed — email delivery disabled");
  return null;
}

export async function sendMail(to: string, subject: string, html: string): Promise<MailResult> {
  if (!smtpConfigured()) {
    logger.warn({ reason: "smtp_not_configured" }, "email delivery skipped");
    return { delivered: false, error: "smtp_not_configured" };
  }
  const nodemailer = await loadNodemailer();
  if (!nodemailer) return { delivered: false, error: "nodemailer_missing" };
  try {
    const transporter = nodemailer.createTransport({
      host: process.env["SMTP_HOST"],
      port: Number(process.env["SMTP_PORT"] || 587),
      secure: String(process.env["SMTP_SECURE"] || "") === "true" || Number(process.env["SMTP_PORT"] || 587) === 465,
      auth: { user: process.env["SMTP_USER"], pass: process.env["SMTP_PASS"] },
    });
    await transporter.sendMail({
      from: process.env["SMTP_FROM"] || "EgyTrend <no-reply@egytrend.com>",
      to,
      subject,
      html,
    });
    logger.info({ delivery: "smtp" }, "email sent");
    return { delivered: true };
  } catch (e) {
    logger.error({ err: e }, "email send failed");
    return { delivered: false, error: "send_failed" };
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export function resetEmailHtml(name: string, link: string): string {
  return `<!doctype html><html dir="rtl" lang="ar"><body style="margin:0;background:#f4f6f5;font-family:Tahoma,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:28px 18px;">
    <div style="background:linear-gradient(135deg,#041a0c,#07220f);border-radius:18px;padding:22px;text-align:center;">
      <div style="font-size:26px;font-weight:900;color:#10b981;">📈 EgyTrend</div>
      <div style="color:#9ca3af;font-size:11px;letter-spacing:2px;margin-top:2px;">نبض الأسواق المصرية</div>
    </div>
    <div style="background:#ffffff;border-radius:16px;padding:26px 22px;margin-top:14px;border:1px solid #e5e7eb;">
      <div style="font-size:18px;font-weight:800;color:#111827;">مرحبًا ${escapeHtml(name)} 👋</div>
      <p style="font-size:14px;color:#374151;line-height:1.9;">وصلنا طلب لإعادة تعيين كلمة المرور الخاصة بحسابك. اضغط الزر أدناه لإنشاء كلمة مرور جديدة — الرابط صالح لمدة <b>30 دقيقة</b> ويمكن استخدامه مرة واحدة فقط.</p>
      <div style="text-align:center;margin:22px 0;">
        <a href="${link}" style="background:linear-gradient(90deg,#10b981,#34d399);color:#04150b;font-weight:800;font-size:15px;padding:13px 34px;border-radius:12px;text-decoration:none;display:inline-block;">إعادة تعيين كلمة المرور</a>
      </div>
      <p style="font-size:12px;color:#6b7280;line-height:1.8;">لو لم تطلب ذلك تجاهل هذه الرسالة — حسابك آمن ولن يتغير أي شيء.<br/>لو الزر لا يعمل انسخ الرابط التالي والصقه في المتصفح:<br/><span style="direction:ltr;unicode-bidi:embed;word-break:break-all;color:#10b981;">${link}</span></p>
    </div>
    <div style="text-align:center;color:#9ca3af;font-size:11px;margin-top:14px;">EgyTrend — منصة الأخبار الاقتصادية والأسواق المالية</div>
  </div></body></html>`;
}
