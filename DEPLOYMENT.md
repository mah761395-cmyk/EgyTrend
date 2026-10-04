# 🚀 دليل نشر EgyTrend — VPS + دومين + HTTPS (خطوة بخطوة)

> ## ⚡ أسرع طريقة؟ Vercel + Neon (مجانًا، بدون سيرفر)
> لو تبغى موقعك على النت في أسرع وقت وبدون أي سيرفر أو دومين: اتبع الدليل المبسّط
> **[دليل-النشر-على-الإنترنت.md](./دليل-النشر-على-الإنترنت.md)** — Vercel يستضيف الموقع
> وNeon يستضيف قاعدة البيانات، وكلاهما بخطة مجانية، والتحديث بعدها = `git push` فقط.
> دليل الـ VPS في الأسفل يظل خيارًا متقدمًا (تحكم كامل + دومين خاص).

دليل إنتاجي كامل لنشر المنصة على سيرفر VPS (أوبونتو 22.04/24.04) مع دومين وشهادة HTTPS مجانية من Let's Encrypt.

> **المعمارية:** `nginx` يخدم ملفات الواجهة المبنية (ملفات ثابتة) ويحوّل `/api/*` إلى خادم الـ API (منفذ 8080 داخلي). قاعدة بيانات PostgreSQL تعمل محليًا على السيرفر ولا تُفتح للخارج إطلاقًا.

---

## 0) المتطلبات

| المتطلب | التفاصيل |
|---|---|
| VPS | أوبونتو 22.04 أو أحدث، 2GB RAM على الأقل (4GB أفضل)، من مزود مثل DigitalOcean / Hetzner / Contabo |
| دومين | مشتري من أي مسجّل (Namecheap / GoDaddy / Cloudflare) |
| الكود | رفع مجلد `EgyTrend` بالكامل إلى السيرفر (git أو scp — بدون `node_modules` ولا `.env`) |
| Node.js | نسخة 20 أو أحدث |
| pnpm | مدير الحزم المستخدم في المشروع (`npm i -g pnpm@9`) |

---

## 1) تجهيز السيرفر (مرة واحدة)

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs postgresql postgresql-contrib nginx git
sudo npm i -g pnpm@9

# مستخدم نظام للتطبيق (بدون صلاحيات root)
sudo adduser --disabled-password --gecos "" egytrend
```

---

## 2) قاعدة بيانات PostgreSQL

```bash
sudo -u postgres psql <<'SQL'
CREATE USER egytrend WITH PASSWORD 'ضع_كلمة_مرور_قوية_عشوائية';
CREATE DATABASE egytrend OWNER egytrend;
SQL
```

- القاعدة تسمع على `localhost` فقط افتراضيًا — **لا تفتح المنفذ 5432 في جدار الحماية أبدًا**.
- سلسلة الاتصال ستكون: `postgres://egytrend:كلمة_المرور@localhost:5432/egytrend`
- أنشئ جدولات المشروع من مجلد الكود:

```bash
cd /home/egytrend/app/lib/db
pnpm install
pnpm run push    # drizzle-kit push — ينشئ كل الجداول
```

> **استعادة نسخة احتياطية من جهازك المحلي (اختياري):** انقل ملف `backups/egytrend-YYYYMMDD.sql.gz` للسيرفر ثم `gunzip` ونفّذه بـ `psql` — ملفات النسخ مكتوبة كـ SQL صريح قابل للتنفيذ المباشر (تم التحقق من استعادتها فعليًا).

---

## 3) الأسرار الإنتاجية (أهم خطوة أمنية)

أنشئ ملف البيئة في مجلد خادم الـ API **خارج Git تمامًا**:

```bash
nano /home/egytrend/app/artifacts/api-server/.env
```

```ini
# ── إلزامية ─────────────────────────────────────────────
PORT=8080
NODE_ENV=production
DATABASE_URL=postgres://egytrend:كلمة_المرور@localhost:5432/egytrend
# سر الجلسات — ولّده مرة واحدة بـ: openssl rand -hex 48
SESSION_SECRET=ضع_هنا_64_حرف_عشوائي
# كلمة مرور لوحة المدير — جديدة وعشوائية، ليست نفسها المحلية
ADMIN_PASSWORD=ضع_كلمة_مرور_مدير_قوية
ADMIN_TOKEN=ضع_توكن_مدير_عشوائيا_اختياري

# ── اختيارية (خدمات بيانات/AI) ────────────────────────────
ANTHROPIC_API_KEY=            # يفعّل Claude في محلل AI بدل المحرك المحلي
FINNHUB_API_KEY=
ALPHA_VANTAGE_API_KEY=
LOG_LEVEL=info

# ── البريد الإلكتروني (لتفعيل استعادة كلمة المرور) ────────
SMTP_HOST=smtp.gmail.com      # أو مزود آخر (Brevo/Mailgun/...)
SMTP_PORT=587
SMTP_SECURE=false             # true فقط لو المنفذ 465
SMTP_USER=your@gmail.com
SMTP_PASS=كلمة_تطبيقات_16_حرف    # Gmail: App Password وليست كلمة المرور العادية
SMTP_FROM="EgyTrend <no-reply@yourdomain.com>"
APP_BASE_URL=https://yourdomain.com   # يُبنى منه رابط الاستعادة في رسالة البريد
```

قواعد صارمة:
- لا تضع أي سر في أي ملف داخل مستودع Git.
- `SESSION_SECRET` قوي وعشوائي — تغييره يُبطل كل الجلسات القائمة (مقبول عند أول نشر).
- احتفظ بنسخة من الأسرار في مدير كلمات مرور.

---

## 4) بناء المشروع على السيرفر

```bash
cd /home/egytrend/app
pnpm install

# اعتماد إرسال البريد (nodemailer يعمل من tools/mailer)
cd tools/mailer && pnpm install && cd ../..

# خادم الـ API (يُبنى إلى dist/index.mjs)
cd artifacts/api-server && pnpm run build

# واجهة الويب (تُبنى إلى artifacts/egytrend/dist)
cd ../egytrend
PORT=3000 pnpm run build   # القيمة نفسها غير مهمة للبناء — المهم تجاوز PORT=0
```

> **تنبيه:** إن ظهر خطأ `PORT=0` أثناء البناء فهذا لأن بيئة سطح المكتب تسرّب المتغير — على السيرفر النظيف لن يحدث؛ وإن حدث فمرّر `PORT=3000` صراحة كما أعلاه.

---

## 5) تشغيل الخدمات كخدمات نظام (systemd)

### خدمة الـ API

```bash
sudo nano /etc/systemd/system/egytrend-api.service
```

```ini
[Unit]
Description=EgyTrend API server
After=network.target postgresql.service

[Service]
User=egytrend
WorkingDirectory=/home/egytrend/app/artifacts/api-server
ExecStart=/usr/bin/node --enable-source-maps ./dist/index.mjs
Restart=always
RestartSec=5
Environment=NODE_ENV=production
# ملف .env يُقرأ تلقائيًا من مجلد الخدمة (dotenv/config في كود الإقلاع)

[Install]
WantedBy=multi-user.target
```

### تفعيل الخدمتين

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now egytrend-api
systemctl status egytrend-api --no-pager
curl -s http://localhost:8080/api/health   # يجب أن يعيد {"status":"ok",...}
```

### تفعيل استعادة كلمة المرور بالبريد (اختياري لكن موصى به)

النظام يعمل بدون بريد (المستخدم يُحوَّل للدعم)، وعند إضافة متغيرات `SMTP_*` أعلاه تُصبح الرسائل حقيقية تلقائيًا بلا أي تعديل كود:

1. أنشئ بريدًا للموقع (مثلًا Gmail عادي أو بريد الدومين من مزود الاستضافة).
2. **Gmail:** فعّل التحقق الثنائي ثم أنشئ «كلمة تطبيقات» (App Password) من myaccount.google.com/apppasswords — 16 حرفًا — وضعها في `SMTP_PASS`.
3. أو استخدم مزود إرسال مخصص (Brevo مجاني حتى 300 رسالة/يوم) — أكثر ملاءمة للإنتاج.
4. أعد تشغيل الخدمة: `sudo systemctl restart egytrend-api` ثم جرّب «نسيت كلمة المرور» من الواجهة.

> بدون SMTP لا يُرسل شيء ولا تظهر أي بيانات حساسة في الواجهة — الاستجابة عامة دائمًا (لا تُفشي وجود حساب أو لا وجوده).

> **النسخ الاحتياطي اليومي:** خادم الـ API يشغّل مؤقّتًا داخليًا يفحص كل 30 دقيقة إن كان ملف `backups/egytrend-YYYYMMDD.sql.gz` لليوم موجودًا؛ إن لم يكن يُشغّل `scripts/backup-db.mjs` (سياسة 7 أيام مدمجة). على السيرفر يعمل تلقائيًا بلا أي إعداد إضافي. لو فضّلت cron الكلاسيكي أضف سطرًا ينتج **نفس اسم الملف** وسيبقى المؤقّت الخامل: `0 3 * * * cd /home/egytrend/app && node scripts/backup-db.mjs`

---

## 6) nginx — يخدم الواجهة ويحوّل الـ API

```bash
sudo nano /etc/nginx/sites-available/egytrend
```

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    # الواجهة المبنية — ملفات ثابتة
    root /home/egytrend/app/artifacts/egytrend/dist;
    index index.html;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    # الـ API يُحوَّل لخادم داخلي على 8080
    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;   # بعض نداءات الأخبار الباردة تستغرق حتى ~10 ثوانٍ
    }

    # SPA: أي مسار غير موجود يرجع index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # كاش طويل لأصول البناء ذات الأسماء المُبصمة
    location /assets/ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/egytrend /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## 7) الدومين (DNS)

في لوحة مسجّل الدومين أضف سجل A واحدًا (ويندوز معياري):

| النوع | الاسم | القيمة | TTL |
|---|---|---|---|
| A | @ | عنوان-IP-السيرفر | 3600 |
| A | www | عنوان-IP-السيرفر | 3600 |

انتظر الانتشار (غالبًا دقائق حتى ساعة) ثم تحقق: `ping yourdomain.com` يجب أن يعيد IP السيرفر.

---

## 8) HTTPS مجاني (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

- اختر **Redirect** عند السؤال (إجبار HTTP → HTTPS).
- التجديد تلقائي عبر مؤقّت certbot المدمج — تحقق بـ:
```bash
sudo certbot renew --dry-run
```

---

## 9) جدار الحماية

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'    # 80 + 443 فقط
sudo ufw enable
sudo ufw status
```

**مغلق للخارج دائمًا:** 5432 (PostgreSQL)، 8080 (الـ API — يُدخل منه عبر nginx فقط).

---

## 10) تحقق نهائي بعد النشر

```bash
# من السيرفر
curl -s https://yourdomain.com/api/health
curl -s "https://yourdomain.com/api/markets/stocks" | head -c 300

# من متصفحك
https://yourdomain.com            # الصفحة الرئيسية ببيانات حية
https://yourdomain.com/vip        # بوابة VIP
```

سجّل دخول المدير بكلمة المرور الإنتاجية الجديدة، وجرّب رحلة مستخدم كاملة (تسجيل → VIP → محفظة).

---

## 11) التحديثات المستقبلية (نشر نسخة جديدة)

```bash
cd /home/egytrend/app
# 1) اجلب الكود الجديد (git pull أو رفع يدوي)
# 2) انسخ .env فقط إن كان غير موجود (لا تستبدله أبدًا!)
# 3) أعد البناء:
pnpm install && (cd artifacts/api-server && pnpm run build) && (cd artifacts/egytrend && PORT=3000 pnpm run build)
# 4) أعد تشغيل الخدمة:
sudo systemctl restart egytrend-api
# nginx لا يحتاج إعادة تشغيل (الملفات الثابتة تُقرأ من القرص)
```

---

## 12) النسخ الاحتياطي والاستعادة على السيرفر

- المجلد: `/home/egytrend/app/backups/` — نسخة يومية مضغوطة، احتفاظ 7 أيام.
- **انسخ النسخ خارج السيرفر أسبوعيًا** (قاعدة 3-2-1): `scp egytrend@server:/home/egytrend/app/backups/egytrend-*.sql.gz ./` من جهازك.
- الاستعادة (تم اختبارها فعليًا): `gunzip -c egytrend-20260925.sql.gz | sudo -u postgres psql egytrend`

---

## 13) استكشاف الأخطاء

| العرض | الفحص |
|---|---|
| الموقع لا يفتح | `sudo systemctl status nginx` · `sudo nginx -t` |
| `/api/health` لا يجيب | `systemctl status egytrend-api` · `journalctl -u egytrend-api -n 50` |
| أخطاء قاعدة بيانات | `sudo -u postgres psql egytrend -c '\dt'` · تحقق من `DATABASE_URL` |
| شهادة منتهية | `sudo certbot renew` · `sudo systemctl reload nginx` |
| الأخبار بطيئة أول نداء | طبيعي (جلب 29 مصدرًا) — بعدها كاش ~دقيقتين، والمصادر الفاشلة كاش سلبي |

---

## 14) قائمة تحقق قبل الإطلاق

- [ ] `SESSION_SECRET` إنتاجي عشوائي جديد
- [ ] `ADMIN_PASSWORD` جديد قوي (غير المحلي)
- [ ] HTTPS يعمل + إجبار Redirect
- [ ] `ufw` مفعّل: 22/80/443 فقط
- [ ] 5432 و8080 غير مكشوفين للخارج
- [ ] `/api/health` يجيب عبر الدومين
- [ ] نسخة احتياطية ظهرت في `backups/` بعد أول يوم تشغيل
- [ ] نسخ النسخ الاحتياطية تُنقل خارج السيرفر أسبوعيًا
- [ ] `NODE_ENV=production`
- [ ] تم تجربة تسجيل مستخدم حقيقي + رحلة VIP كاملة عبر الدومين
