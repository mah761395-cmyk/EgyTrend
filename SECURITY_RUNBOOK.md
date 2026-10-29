# SECURITY_RUNBOOK — تدوير الاعتمادات بعد إصابة اللابتوب (2026-10)

**السياق:** لابتوب التشغيل كان مصاب ~48 ساعة بـPowerShell loader بقدرة RCE. المستودع **عام**.
**القاعدة:** أي اعتماد كان موجودًا على الجهاز **يُعتبر مكشوفًا** حتى يُثبت العكس. غياب دليل السرقة ≠ عدم حدوثها.
**الترتيب العام لكل اعتماد:** `تدوير عند المزود ← تحديث Vercel (إن وُجد) ← Redeploy بعد موافقة ← اختبار الخدمة ← إبطال القديم بعد التأكد`.

> **لا يوجد في هذا الملف أي قيمة سرية.** فقط أسماء المتغيرات والمسارات.

---

## 0) الترتيب الفوري (قبل أي حاجة تانية — من جهاز/موبايل نظيف)

| أولوية | الإجراء | ليه أول؟ |
|---|---|---|
| 1 | **قطع كل سيشنز GitHub + Vercel + الإيميل** | جلسات المتصفح/الموبايل على الجهاز المصاب = باب مفتوح فورًا |
| 2 | **تغيير `ADMIN_PASSWORD`** (لوحة الأدمن) | الباب الأغلى: يدير المستخدمين والمدفوعات |
| 3 | **تدوير باسورد قاعدة Neon** | كل بيانات المستخدمين/المدفوعات/الجلسات |
| 4 | حذف كل GitHub PATs + SSH keys غير المعروفة | Git credential manager على ويندوز كان بيخزن توكن الـpush |
| 5 | تغيير باسورد الإيميل + app passwords (SMTP) | الاستعادة والتنبيهات + كل الأكواد التانية |
| 6 | باسورد حساب التاجر في محفظة الدفع + أي API عندهم | الأموال مباشرة |
| 7 | **عزل اللابتوب عن الإنترنت** (أوفلاين) لحد إعادة التثبيت | منع أي سحب متبقٍ أو أوامر جديدة |

---

## 1) جرد الاعتمادات: مكانها / التاريخ / مكان التدوير / Vercel

### 1.1 `ADMIN_PASSWORD` — كلمة مرور الأدمن
- **أين:** Vercel env (Production + Preview) + `.env` المحلي على اللابتوب.
- **في Git history؟** لا (فحص كامل لكل الـcommits).
- **التدوير:** Vercel → المشروع → Settings → Environment Variables → Production & Preview → غيّر قيمة `ADMIN_PASSWORD` (ولّدها جديدة: `openssl rand -base64 32`). لا يوجد "مزود" خارجي — هي قيمة داخلية.
- **التحقق:** ادخل `/admin` بالقيمة الجديدة (يجب قبولها)، وجرّب القديمة (يجب رفضها 401).
- **ملاحظة:** المقارنة في الكود timing-safe ✅ — لا حاجة لتغيير كود.

### 1.2 `SESSION_SECRET` — توقيع JWT والـpepper
- **أين:** Vercel env + `.env` محلي.
- **في Git history؟** لا.
- **التدوير (ترتيب دقيق — مهم):**
  1. Vercel: أضف `SESSION_SECRET_PREVIOUS` = القيمة القديمة.
  2. Vercel: غيّر `SESSION_SECRET` لقيمة جديدة (`openssl rand -base64 48`).
  3. Redeploy بعد موافقة.
  4. كل الموظفين/المستخدمين يعيدون الدخول (الجلسات القديمة تتبطل — هذا مقصود).
     - الموظفين اللي hash باسوردهم قديم (sha256+pepper) هيدخلوا بالـPREVIOUS مرة واحدة والكود يترقية hashهم لـscrypt تلقائيًا.
  5. بعد ~أسبوعين والتأكد إن كل موظف دُور: احذف `SESSION_SECRET_PREVIOUS`.
- **التحقق:** الموقع يخدم، التسجيل والدخول شغالين، الأدمن شغال، الجلسات القديمة مش شغالة.

### 1.3 `DATABASE_URL` (Neon) — بيانات الإنتاج
- **أين:** Vercel env + `.env` محلي + متغيرات مهمة Task Scheduler على اللابتوب.
- **في Git history؟** لا (الوالية اللي في الـdocs كانت localhost/placeholder — اتستبدلت بـplaceholders في `security-rotation`).
- **التدوير في Neon** (console.neon.tech):
  1. ادخل المشروع → **Connection Details**.
  2. على الـrole المستخدم (غالبًا `neondb_owner`): **Reset Password** → قيمة جديدة قوية.
  3. اعمل **Pooling Details** — لو فيه connection poolers (pooled connections) فباسوردها نفس باسورد الـrole.
  4. **لو فيه `NEON_API_KEY`** (مفتاح إدارة المشروع — استخدمه اللي عمل المشروع/الـCLI):
     - Project Settings → **API Key** → **Rotate** — ده يدير كل حاجة: reset باسوردات، **export بيانات** (Data API)، إنشاء branches. لو كان على اللابتوب فمكشوف افتراضيًا.
  5. راجع **Connection History / Activity** آخر 7 أيام: أي IP غير متوقع (أنت + CI بس).
- **حدّث Vercel:** `DATABASE_URL` بالقيمة الجديدة (نفس الـhost، باسورد جديد).
- **Redeploy** بعد موافقة.
- **التحقق:** الصفحة الرئيسية + `/api/health` (لو متاح) + تسجيل دخول اختباري + إنشاء alert.
- **إبطال القديم:** Neoن بيبدّل الباسورد (القديم مش شغال بعد الـreset — مفيش "قديمة" متروكة).
- **اختياري مهم:** Neoن فيه **PII redaction** عند الـexports (Data API) — فعّله لو الترتيب يسمح.

### 1.4 باسوردات Postgres **المحلية** (اللابتوب)
- **في Git history؟** **نعم — مستودع عام** (سطران: `DEPLOYMENT.md` ودليل الاستعادة). اتستبدلت في الكود بـ`CHANGE_AFTER_REINSTALL` لكن **التاريخ العام ما يمسوش** → المعالجة = تغيير الباسورد نفسه.
- **الإجراء:** بعد إعادة التثبيت، أنشئ الـDB المحلي من جديد (أو `ALTER ROLE ... PASSWORD`) بنفس الباسوردات الجديدة، وحدّث أي سكربت لوكال.

### 1.5 `TWELVE_DATA_API_KEY`
- **أين:** Vercel env + `.env` محلي. في Git? لا (fixtures بس في tests).
- **التدوير:** app.twelvedata.com → **API Key** → revoke القديم + توليد جديد. راجع **Usage** الأخير على استهلاك غير متوقع.
- **Vercel:** حدّث `TWELVE_DATA_API_KEY`. Redeploy.
- **التحقق:** لوحة الأسعار للزائر (EGX30/USD/EGP/EUR-EGP) بتجيب أرقام جديدة — ده أسرع دليل.

### 1.6 `SMTP_USER` / `SMTP_PASS` (+ `SMTP_FROM`)
- **أين:** Vercel env + `.env` محلي.
- **التدوير:** عند مزوّد البريد (Gmail → App Password جديد؛ أو مزوّدك) → حدّث `SMTP_PASS` في Vercel. Redeploy.
- **التحقق:** من الأدمن: أرسل broadcast/تنبيه تجريبي لحسابك الشخصي (مش لعميل حقيقي) — رسالة واصلت = شغال.

### 1.7 `CRON_SECRET` + `MARKET_SNAPSHOT_CRON_SECRET`
- **أين:** Vercel env (+ محلي).
- **الخطورة:** متوسطة — endpoints الـcron ترجع 404 من غير السّر، وما فيش sensitive output.
- **التدوير:** `openssl rand -base64 32` لكل واحد، حدّث Vercel، **وحدّث headers بتاعة Vercel Cron** (لو بتستخدمها — راجع crons في `vercel.json` و Vercel → Settings → Cron Jobs إن كان فيه secrets مرتبطة). Redeploy.
- **التحقق:** شغّل cron يدويًا من Vercel (Cron Jobs → Run) واستنى اللوق: نجاح بدون 401.

### 1.8 أسرار التوقيع الداخلية: `REFERRAL_COOKIE_SECRET` / `REFERRAL_SIGNAL_SECRET` / `TRIAL_SIGNAL_SECRET`
- **أين:** Vercel env (+ محلي).
- **التدوير:** قيّم الأثر أولًا — دي بتوقّع إشارة referral/trial؛ تغييرها **يُبطل الإشارات الحالية** (مفيش بيانات مفقودة، بس أي referral قيد المراجعة هيبقى signalه موقّع بسر قديم). إن كانت مفعّلة فعلًا: غيّرها واطمّن؛ إن كانت فارغة/معطلة: تولّدها لما تفعّلها أول مرة.
- **التحقق:** مسار referral تجريبي من حسابك.

### 1.9 توكنات **Vercel** (deployment/access)
- **أين:** Vercel dashboard + محفظتها على الأجهزة (مش في الـrepo — متأكد).
- **الإجراء:** Vercel → Settings → **Access Tokens** → احذف الكل (اللي على اللابتوب مكشوف افتراضيًا) → أنشئ جديد بس بالصلاحية المطلوبة (Project only، مش Account) لحاجة محددة.
- **أيضًا:** Vercel → **Members** (مين جوه؟ — تأكد إنك إنت بس) و **Teams** إن وُجدت.
- **Sessions:** Vercel → Settings → **Sessions** (إن كانت ظاهرة للاحتيار) → sign out all.

### 1.10 GitHub (الحساب + المستودع)
- **الإجراء (Settings):**
  1. **Sessions** → Sign out all (هتقطع الدخول من كل الأجهزة — بما فيها المصابة).
  2. **Password** → تغيير + 2FA بـTOTP (مش SMS).
  3. **SSH and GPG keys** → احذف أي مفتاح مش معروف (الـloader كان يقدر ياخد `~/.ssh`).
  4. **Personal access tokens / Fine-grained PATs** → احذف الكل.
  5. **Applications** (OAuth granted) → أوقف غير المعروف.
  6. **Developer settings → GitHub Apps** → راجع الـinstalled apps — **التوكن اللي بيشتغل به أداة الـagent (Arena) له صلاحية push على المستودع** — تأكد إنه هو الوحيد المتبقي، وراجع آخر نشاطه.
  7. المستودع: Settings → **Webhooks** (أوقف/امسح غير المعروف — لو فيه webhook بتاع deploy أو bot)، **Deploy keys** (احذف الكل ما لم تكن متأكد من استخدام كل واحد)، **Secrets and variables** (Actions) → احذف أي secret متروكة، **Collaborators/Teams** (أنت بس ✅ تم التحقق).
  8. **الفروع:** عن 12+ فرع `arena/*` قديم + `feat/*` + `stable/*` عام — التاريخ كله اتفحص (مفيش أسرار) لكن **امسح الفروع المدموجة** للتقليل من سطح المسح مستقبلاً (من UI أو `git push origin --delete <branch>` بعد دمجها).
- **ملاحظة:** المستودع عام — لو كان فيه أي حاجة حساسة في الـdocs (أرقام تواصل، خطط العمل) فهي ظاهرة للعامة. الباسوردات اللي كانت في الـdocs اتستبدلت لكن تاريخها باقٍ (عشان كده البند 1.4).

### 1.11 النسخ الاحتياطية (backups)
- **الحالة:** كانت **plain gzip** + صلاحيات Unix معطّلة على ويندوز → على جهاز مصاب = **اعتبرها مقروءة**.
- **المعالجة (ما اتعمل في `security-rotation`):**
  - تشفير اختياري للنسخ AES-256-GCM (`EGYTREND_BACKUP_KEY`/`KEYFILE`) + كشف أي تلاعب (GCM tag) + `--verify`.
  - `icacls` في `backup-task.cmd` يقفل مجلد `backups\` على المستخدم الحالي (NTFS فعلية).
  - `restore-db.mjs`: استعادة موثقة، تستدعي target بكتابة مزدوجة، **ترفض قاعدة الإنتاج** إلا بـ`--confirm-prod` صريح.
- **الخطوات اليدوية (بعد إعادة التثبيت):**
  1. ولّد مفتاح: `openssl rand -hex 32` → احفظه في مدير كلمات المرور (أو ملف في مسار محمي).
  2. في Task Scheduler: مهمة `EgyTrend DB Backup` → Settings/Environment → أضف `EGYTREND_BACKUP_KEY` (أو حط ملف المفتاح وضبط `EGYTREND_BACKUP_KEYFILE`) — **فحص المهمة:** Action (مسار `backup-task.cmd`)، Trigger (يومي؟)، "Run with highest privileges" (لا إن مش ضروري)، ومنشن آخر تشغيل ناجح.
  3. شغّل المهمة يدويًا مرة → تأكد إن الملف الجديد `.sql.gz.enc` وإن `--verify` ناجح.
  4. **امسح النسخ القديمة plain** من `backups\` بعد أول نسخة مشفرة ناجحة.
  5. **اختبار استعادة حقيقي (غير مدمر):** أنشئ DB اختباري في Neoن (branch مؤقت أو database جديد على مشروع منفصل) → `node scripts/restore-db.mjs --target "postgresql://…(الاختباري)…" --confirm <اسم> backups\egytrend-*.sql.gz.enc` → راجع الـtables → احذف الاختباري.

### 1.12 حسابات خارج الـrepo (مصفوفة)
- **إيميل الحساب (GitHub/Vercel/Neoن مشهورة عليها):** تغيير + 2FA + Sessions.
- **حساب التاجر (محفظة الدفع):** باسورد + API (إن وُجد) + مراجعة آخر عمليات (أي withdrawal/استرداد غريب آخر 7 أيام؟).
- **Neoن (المشروع):** كمان تأكد من **Project Settings → Access/Owners** مين جوه.

---

## 2) Redeploy + اختبار ما بعده

**متى:** بعد ما تتدوّر (1.1 + 1.2 + 1.3 بالترتيب — `ADMIN_PASSWORD`، `SESSION_SECRET` (بالـPREVIOUS)، `DATABASE_URL`).

1. merge `security-rotation` → `main` (يلازم Vercel production deploy تلقائي) أو deploy الفرع مباشرة حسب إعدادك.
2. **دخول الأدمن** بالقيمة الجديدة.
3. **لوحة الزائر:** أسعار + إحصائيات (EGX30/USD/EGP/EUR-EGP) — تأكيد إن `DATABASE_URL` و `TWELVE_DATA_API_KEY` شغالين.
4. **حساب تجريبي:** سجل/ادخل + أنشئ alert — تأكيد إن الـsessions الجديدة بتتوقع.
5. **الدفع:** طلب تجريبي (بلا مدفوع) — `POST /payments` بـproof + approval من الأدمن.
6. **Cron:** شغّل الـcron يدويًا من Vercel.
7. **مراقبة أول 24 ساعة:** Vercel → Logs — أي 5xx/401 غير معتاد.

---

## 3) قائمة مراقبة 7 أيام (سجلات متاحة)

| السجل | مكانه | إيه اللي بتدور عليه |
|---|---|---|
| Login failures | Vercel Logs (بحث `login` / `401` / `invalid`) | محاولات مكثفة من IP واحد، أوقات غير معتادة (تاني الليل) |
| نشاط الأدمن | Vercel Logs (`/api/admin` + audit log في الـDB: جدول الـaudit) | أي action من session مش معروفة/أوقات غريبة |
| المدفوعات | لوحة الأدمن → payment requests | طلبات بتوافقها لم يرفعها مستخدم معروف، أو approvals مش أنت عملتها |
| مستخدمين جدد | الـDB (users آخر 7 أيام) | نمط تسجيلات غريب (أرقام متسلسلة) |
| Deployments | Vercel → Deployments + GitHub commits | أي deploy مش أنت عملته |
| Neoن | Connection History + Query/Compute logs | IP جديد، branches جديد، exports (Data API) |
| GitHub | Settings → Security log (لو Pro) + commit activity | push من توكن/جهاز مش متوقع |

---

## 4) اللابتوب: ما يتسجلش في أي commit — يُنفذ على الجهاز

### 4.1 قرار: **إعادة تثبيت كاملة** (مش تنظيف)
- USBD من ISO رسمي + Secure Boot مفعّل + UEFI fresh.
- قبل التثبيت: اعمل فهرس/أرشيف بأمرك للملفات المهمة (كود المشروع عنده نسخة في Git ✅) — **متعملش restore للنسخ old backups**.

### 4.2 أوامر تشخيص (قبل التثبيت، لو حبيت تحفظ أدلة — كلها للقراءة فقط)
```powershell
# PowerShell loader footprint (الـ48 ساعة)
Get-WinEvent -LogName "Microsoft-Windows-PowerShell/Operational" -MaxEvents 20000 |
  Where-Object { $_.Id -in 400,403,410,800 } |
  Select TimeCreated,Id,Message | Out-File "$env:USERPROFILE\ps-audit.csv"

# عمليات start (مراقبة أي start غريب / service)
Get-WinEvent -LogName Security -MaxEvents 50000 |
  Where-Object { $_.Id -in 4688 } | Out-File "$env:USERPROFILE\proc-audit.csv"

# Task Scheduler: المهمة + آخر تشغيلها + صلاحياتها
Get-ScheduledTask -TaskName "*EgyTrend*" | Format-List *
Get-ScheduledTaskInfo -TaskName "*EgyTrend*"

# Startup items
Get-CimInstance Win32_StartupCommand | Select Name,Command,Location
Get-ItemProperty "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run",
                 "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"

# أي service جديدة/مش معروفة
Get-Service | Where-Object {$_.Status -ne 'Running' -or $_.StartType -eq 'Automatic'} |
  Select Name,Status,StartType,DisplayName | Out-File "$env:USERPROFILE\services.csv"
```
(انسخ الملفات لمؤسسة USB **نظيفة** قبل التثبيت — الملفات دي فيها أدلة.)

### 4.3 بعد التثبيت
- حدّث ويندوز + أي برامج.
- أعد تثبيت Node/pnpm/pg_dump، و`git config --global --list` — تأكد إن مفيش credential helper بقايا: `git config --global --unset credential.helper` (أو اتركه على manager الجديد).
- ادخل GitHub من جديد (سيتكون token جديد نظيف).
- شغّل المهمة المجدولة مرة يدوية + النسخة المشفرة (بند 1.11).

---

## 5) ما لم يمكن التحقق منه (صراحة)

- **هل الـloader شغّل/سحب فعلاً؟** لا يوجد سجل من الجهاز في هذه البيئة — التعامل يكون أسوأ حالة.
- **Vercel dashboard / GitHub user-level** من هذه البيئة (403/محجوب) — البنود 1.9/1.10 تتنفذ من متصفح جهاز نظيف.
- **سجلات Neoن** — تتأكد من الـconsole بيدك.
- **محتوى النسخ القديمة على اللابتوب** — لم تُفحص (الجهاز غير متاح)؛ اعتبارها مقروءة هو القرار المتحفظ.

---

## 6) حالة الفرع `security-rotation` (ما اتغير في الكود)

| الملف | التغيير |
|---|---|
| `scripts/backup-db.mjs` | تشفير AES-256-GCM اختياري + round-trip verify + retention شاملة `.enc` + تحذير loud للنسخ plain |
| `scripts/restore-db.mjs` | **جديد** — verify + استعادة مصادَق عليها (target مكرر + رفض الإنتاج) |
| `scripts/backup-task.cmd` | `icacls` لقفل `backups\` على المستخدم (NTFS) |
| `DEPLOYMENT.md`، `دليل-الاستعادة-والرفع.md` | استبدال باسوردات DB المحلية بـplaceholders (التاريخ العام يتعالج بتغيير الباسورد نفسه) |
| `.env.example` | اكتمال قائمة المتغيرات (25 ناقص بينها `SESSION_SECRET_PREVIOUS` و أسرار الـbackup) |

**ما اتغير (متعمد):** لا تغيير في auth/sessions/payments — الكود الحالي متين (scrypt، rate limiting، httpOnly cookies، origin guard، cron authorization) والتوثيق في `docs/auth-security.md`. لا Redeploy اتنفذ. لا بيانات إنتاج اتعرضت/اتعدلت.
