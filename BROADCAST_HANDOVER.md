# رسائل المدير العامة (Broadcast) — تسليم محلي

> **الحالة:** تنفيذ محلي فقط على فرع `upgrade`. لا توجد migration منفّذة، أو deploy، أو اتصال بقاعدة مشتركة/Production، أو إرسال بريد جماعي.
>
> **Migration المطلوبة لاحقًا:** `lib/db/migrations/0008_admin_broadcasts.up.sql` فقط بعد backup حقيقي ومراجعة ونافذة معتمدة. rollback `0008_admin_broadcasts.down.sql` غير مدمر: يؤرشف الجداول الجديدة ويحافظ على أدلة consent.

## ما أُضيف

### التخزين الآمن

- `broadcast_messages`: عنوان، AST غني آمن، النوع، الجمهور، الأولوية، حالة التحرير، بداية/نهاية instant، CTA، صورة اختيارية، وسجل creator/updater/archive.
- `broadcast_media`: PNG/JPEG/WebP فقط، Data URL محدود إلى 180KB، MIME + magic bytes + dimensions/pixel limit؛ لا SVG ولا `data:` حر.
- `broadcast_message_user_states`: unique `(message_id, user_id)`؛ هو مصدر حقيقة الظهور/الإغلاق/CTA للمستخدم المسجل.
- `broadcast_test_deliveries`: سجل تجربة مدير خاصة فقط؛ لا يمثل delivery للمستخدمين ولا بريدًا.
- حقول `app_users` الإضافية: `marketing_email_opt_in`، ووقت opt-in ووقت opt-out. البريد المسجل للاستعادة لا يعني موافقة تسويقية.

لا يوجد حذف مدمر للرسائل؛ الأرشفة تغيّر الحالة فقط.

### المحتوى والروابط والمتغيرات

- إدخال النص يدعم subset صغير فقط: `**العريض**`، القوائم `- بند` و`1. بند`، وروابط `[النص](https://...)` أو مسار داخلي يبدأ بـ`/`.
- لا يُخزن HTML خام؛ كل title/text يُنظف، والـAST يعاد allowlist-sanitize عند إخراج public كحماية إضافية ضد سجل legacy/يدوي غير موثوق.
- CTA تسمح فقط بمسار داخلي أو `https`; credentials و`javascript:` وprotocol-relative ممنوعة.
- CTA كوبون مرفوضة fail-closed لأن payment request لا يطبق coupon redemption فعليًا بعد.
- `{{name}}` من الحساب الموجود على الخادم؛ `{{price}}`/`{{old_price}}`/`{{discount_percent}}` من `getEffectivePrice()` و`subscription_plans` فقط عند اختيار `variablePlanKey` صالح. عند غياب مصدر صالح تظهر `غير متاح حاليًا`، ويعيد payload `variableSource`.

### الاستهداف والجدولة

الجمهور: `all`, `guests`, `free`, `vip`, `expiring`, `new_users`.

- VIP/Free/expiring تستخدم entitlement الخادمي `getVipEntitlement()`، لا JWT plan أو localStorage.
- expiring = entitlement نشط و0–7 أيام تقويمية حتى الانتهاء في `Africa/Cairo`.
- new_users = عمر الحساب ≤ 7×24 ساعة.
- أوقات `datetime-local` الإدارية تُفسر كـ Cairo على الخادم؛ ISO offset/UTC مدعوم أيضًا.
- الحالات المعروضة مشتقة في كل قراءة: `draft`, `scheduled`, `active`, `ended`, `paused`, `archived`.
- الاختيار public: أعلى `priority` ثم الأحدث `created_at`.

### API

Public (خفيف، `Cache-Control` قصير 30 ثانية و`Vary: Cookie, Authorization`):

- `GET /api/broadcasts/active?seen=<guest ids>`: مرشح واحد مناسب؛ `seen` للضيف مجرد suppression hint، وليس صلاحية.
- `POST /api/broadcasts/active/:id/claim`: للمسجل فقط، `ON CONFLICT DO NOTHING` يمنع الظهور المتكرر وrace tabs.
- `POST /api/broadcasts/:id/events`: close / do_not_show_again / cta_click للمسجل الذي claim الرسالة.
- `GET /api/broadcasts/media/:id`: لا يعرض إلا media مرتبطة برسالة نشطة وجمهور مناسب للمشاهد الحالي.

Admin (يتطلب employee active بدور `super_admin` أو `admin` من DB الحالية، وليس legacy static token):

- `GET /api/admin/broadcasts`, `GET /api/admin/broadcasts/templates`
- `POST /api/admin/broadcasts`, `PUT /api/admin/broadcasts/:id`
- `POST /api/admin/broadcasts/:id/pause|archive|duplicate|test`
- `POST /api/admin/broadcasts/preview` (server-truth فقط، بلا حفظ/claim/delivery)
- `POST /api/admin/broadcasts/media`, `GET /api/admin/broadcasts/media/:id`

كل mutation يسجل audit target غير حساس؛ لا يسجل نص رسالة أو بريد أو صورة Data URL في audit.

### الواجهة

- modal RTL/mobile-first تظهر بعد اكتمال boot، بحد أقصى واحدة لكل browser session (`sessionStorage`)؛ الضيف يحفظ IDs التي رآها محليًا فقط، والمستخدم المسجل claim في DB قبل العرض.
- modal لديها `role=dialog`, `aria-modal`, عنوان، focus trap، وEsc؛ rich text يبنى من DOM text nodes ولا يدخل `innerHTML`.
- لوحة الإدارة: قوالب عيد الفطر/الأضحى/رمضان/رأس السنة/خصم/ميزة/صيانة بلا تواريخ مفروضة، composer، رفع، معاينة desktop/mobile من endpoint خادمي، سجل stats، تعديل/إيقاف/أرشفة/تكرار وتجربة خاصة.
- صفحة الحساب تحتوي consent تسويقي صريح منفصل. لا توجد حملة مفعلة؛ endpoint unsubscribe HMAC موجود للسياق المستقبلي فقط.

## البريد التسويقي

لا يوجد bulk-mail worker ولا endpoint يؤكد الإرسال. `marketingEmailRequested: true` مرفوض على الخادم، وواجهة الإدارة تقول صراحة إنه مغلق. لا يُربط sender مستقبلًا قبل:

1. consent صالح + recipient email صالح،
2. رابط unsubscribe صادر من `createMarketingUnsubscribeUrl()` (المبني على token HMAC) ومضمن في كل رسالة،
3. موافقة تشغيل صريحة منفصلة،
4. rate/batch/audit/delivery policy واختباراتها.

## التحقق المحلي المنفذ

- `corepack pnpm run typecheck:libs`
- `corepack pnpm --dir artifacts/api-server run typecheck`
- `corepack pnpm --dir artifacts/api-server exec tsx --test src/routes/broadcasts.e2e.test.ts`
- Vite production build للواجهة.

تغطي اختبارات broadcast: Cairo start/end boundaries، رفض create من غير admin، XSS/unsafe link، guests/free/VIP/expiring/new users، claim/no-repeat DB، consent الصريح بلا campaign، ورفض CTA كوبون/طلب بريد جماعي.

## قبل التطبيق لاحقًا

1. اختبر `0008` على Preview DB منفصلة فقط بعد `node scripts/backup-db.mjs` وverify للـbackup.
2. طبق migration عبر runner معتمد، ثم شغّل API suite وmanual smoke: admin login، upload real PNG/JPG/WebP، Cairo schedule، guest، free/VIP/expiring، modal keyboard، CTA داخلي/https، archive.
3. لا تنشر أو تطبق Production migration أو تضبط Vercel/SMTP/secrets من دون موافقة صريحة جديدة وbackup.
