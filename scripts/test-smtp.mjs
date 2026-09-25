// EgyTrend — SMTP verification in one command:
//   bun scripts/test-smtp.mjs you@example.com
// Reads SMTP_* from repo .env / environment, sends a branded test email,
// and prints a precise diagnosis (config missing / auth failed / success).
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

const ROOT = path.resolve(import.meta.dir, "..");

// Minimal .env loader (does not override real env vars)
for (const f of [path.join(ROOT, ".env"), path.join(ROOT, "artifacts", "api-server", ".env")]) {
  try {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch {}
}

const to = process.argv[2] || "";
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
  console.log("استخدام: bun scripts/test-smtp.mjs بريدك@example.com");
  process.exit(1);
}

const cfg = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || "") === "true" || Number(process.env.SMTP_PORT || 587) === 465,
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env["SMTP_FROM"] || "EgyTrend <no-reply@egytrend.com>",
};

if (!cfg.host || !cfg.user || !cfg.pass) {
  console.log("❌ إعدادات SMTP غير مكتملة في .env — فك التعليق واملأ: SMTP_HOST / SMTP_USER / SMTP_PASS");
  process.exit(1);
}

console.log(`الخادم: ${cfg.host}:${cfg.port} (${cfg.secure ? "SSL" : "STARTTLS"}) · الحساب: ${cfg.user}`);

// nodemailer is resolved from tools/mailer (or workspace) node_modules
let nodemailer = null;
for (const base of [path.join(ROOT, "tools", "mailer", "node_modules"), path.join(ROOT, "node_modules")]) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(base, "nodemailer", "package.json"), "utf8"));
    const mod = await import(pathToFileURL(path.join(base, "nodemailer", meta.main || "index.js")).href);
    nodemailer = mod.default || mod;
    break;
  } catch {}
}
if (!nodemailer) {
  console.log("❌ nodemailer غير مثبت — شغّل: cd tools/mailer && bun add nodemailer");
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  host: cfg.host, port: cfg.port, secure: cfg.secure,
  auth: { user: cfg.user, pass: cfg.pass },
  connectionTimeout: 15000,
});

console.log("جارٍ الإرسال...");
try {
  const info = await transporter.sendMail({
    from: cfg.from,
    to,
    subject: "EgyTrend — رسالة تجريبية (SMTP يعمل ✓)",
    html: `<!doctype html><html dir="rtl" lang="ar"><body style="font-family:Tahoma,sans-serif;background:#f4f6f5;margin:0;padding:28px;">
      <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;">
        <div style="background:linear-gradient(135deg,#041a0c,#07220f);padding:22px;text-align:center;">
          <div style="font-size:26px;font-weight:900;color:#10b981;">📈 EgyTrend</div>
        </div>
        <div style="padding:26px;text-align:center;">
          <div style="font-size:17px;font-weight:800;color:#111827;">إعدادات البريد تعمل بنجاح 🎉</div>
          <p style="color:#374151;font-size:14px;line-height:1.9;">من الآن ستصل رسائل استعادة كلمة المرور عبر هذا الحساب.</p>
        </div>
      </div></body></html>`,
  });
  console.log(`✅ تم الإرسال بنجاح — افحص بريدك (${to}) · ${info.messageId || ""}`);
  console.log("✅ استعادة كلمة المرور عبر البريد مفعّلة الآن بالكامل.");
} catch (e) {
  console.log("❌ فشل الإرسال — التشخيص:");
  const msg = e && e.message ? e.message : String(e);
  if (/auth|username|password|535|534/i.test(msg)) console.log("   → بيانات الدخول مرفوضة: راجع SMTP_USER/SMTP_PASS (Gmail يريد App Password وليس كلمة المرور العادية)");
  else if (/timeout|ETIMEDOUT|ENOTFOUND|ECONNREFUSED/i.test(msg)) console.log("   → لا وصول للخادم: راجع SMTP_HOST/المنفذ، أو الجدار الناري يحجب 587/465");
  else if (/550|542|spam/i.test(msg)) console.log("   → المزود رفض الرسالة: جرّب Brevo بدل Gmail، أو فعّل حساب الإرسال");
  else console.log("   → " + msg);
  process.exit(1);
}
