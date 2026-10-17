# دورة حياة الاشتراك والتنبيهات — تسليم تقني

> **الحالة:** الكود وmigration محليان فقط. لم يُنفذ `0007` على أي قاعدة مشتركة أو Production، ولم يُضف Cron إلى Vercel، ولم تُضبط secrets، ولم يُرسل بريد حقيقي أو يُحصّل دفع.
>
> **تاريخ مراجعة الوثائق:** 17 أكتوبر 2026 — Africa/Cairo.

## ما نُفذ محليًا

- الشهر = **30 × 24 ساعة بالضبط** من لحظة التفعيل UTC (`calculateApprovedSubscriptionEnd`). التجديد قبل الانتهاء يكدّس من `expires_at` الحالي؛ بعد انتهاء اللحظة الفعلية (حتى لو كان المستخدم داخل grace) يبدأ من لحظة اعتماد الطلب.
- كل term يحصل على `cycle_id` جديد. جدول `reminders_sent` generic (قابل للتوسيع للتجربة المجانية/الإحالات) وdedup فيه هو `(subscription_cycle_id, reminder_type)` وليس subscription row قابلًا للكتابة؛ التجديد يلغي queued/pending delivery للدورة السابقة داخل transaction ولا يمس history الذي وصل بالفعل.
- `getVipEntitlement()` هو مصدر الصلاحية: ينتهي VIP عند instant الانتهاء حتى لو تأخر Cron؛ يسمح فقط بفترة السماح المسجلة للدورة. Cron يحدّث compatibility projection إلى Free بلا حذف محفظة/قوائم/تنبيهات/سيناريوهات.
- reminders الشهرية: 7/3/1 يوم، يوم الانتهاء، و«وحشتنا» بعد 3 أيام إن كان marketing مفعّلًا. السنوية: 30/14/7/1 يوم ثم رسالة انتهاء. إذا فات scheduler threshold، يحجز أول تنبيه مستحق واحد ويضع thresholds الأقدم suppressed كي لا يغرق العضو.
- كل reservation ينشئ in-app server notification وCTA محليًا آمنًا `/vip?plan=<server-plan>&renew=1`؛ البريد outbox مستقل. SMTP لا يعطل expiry أو in-app، و`send_failed` يحاول ثلاث مرات (5 ثم 30 دقيقة، أو أول تشغيل لاحق)، وبعدها `failed`. غياب SMTP أو بريد المستخدم يسجل `unavailable` بصراحة.
- Cairo calendar logic في `subscription-time.ts` يستخدم ICU/IANA `Africa/Cairo`، لا offset ثابت. لا يغيّر DST `daysUntilExpiry`؛ وقت Cairo غير الموجود عند انتقال DST يطبّع للأمام لا لليوم السابق.
- صفحة العميل: CTA الإشعار وbanner آخر 3 أيام يفتحان modal الدفع مع الباقة المختارة؛ لا توجد صلاحية أو سعر من `localStorage`.
- لوحة الإدارة: قائمة تنتهي خلال 7 أيام، manual reminder واحد للدورة، Dry run بتاريخ Cairo/UTC بلا كتابة أو إرسال، إعداد grace/marketing، ملخص renewal/expiry/value estimate من مصدر الخادم وemail failure list.

## ملفات التنفيذ

| الغرض | المسار |
|---|---|
| UTC/Cairo + مدة 30 يوم | `artifacts/api-server/src/lib/subscription-time.ts` |
| reservation/outbox/expiry/admin metrics | `artifacts/api-server/src/lib/subscription-lifecycle.ts` |
| اعتماد الدفع وتجديد transaction | `artifacts/api-server/src/routes/admin.ts` |
| cron endpoint المحمي | `artifacts/api-server/src/routes/subscription-lifecycle.ts` |
| API banner/notifications/subscription state | `artifacts/api-server/src/routes/payments.ts`, `routes/user.ts` |
| UI banner/CTA/admin tab | `artifacts/egytrend/index.html` |
| schema | `lib/db/src/schema/subscription_lifecycle.ts` و`user_subscriptions.ts` و`user_notifications.ts` |
| migration pending | `lib/db/migrations/0007_subscription_lifecycle.{up,down}.sql` |
| pg-mem tests | `artifacts/api-server/src/routes/payment-lifecycle.e2e.test.ts` |

## الـ migration: شرط سلامة

`0007` pending وreversible non-destructively:

1. على **Preview/Test DB منفصلة فقط**: نفذ backup حقيقي قابل للاستعادة وراجعه.
2. راجع `0007_subscription_lifecycle.up.sql` و`down.sql` ثم نفذ عبر migration runner المعتمد.
3. شغّل API tests وPreview smoke: expiry، CTA، renewal قبل/بعد expiry، admin dry-run.
4. لا تُشغّل Production أو Cron أو SMTP قبل approval منفصل وbackup window.

الـ down لا يحذف reminder/lifecycle evidence؛ يعيد تسميتها archive ويحتفظ بأعمدة cycle/UTC/CTA لتفادي إعادة تفسير تواريخ مدفوعة.

## Cron / Vercel: نتيجة المراجعة الرسمية

لم يمكن معرفة خطة المشروع الفعلية محليًا: لا يوجد `.vercel` link أو session/auth أو project metadata، لذلك لا يمكن تقرير أن الحساب الحالي Hobby أو Pro بلا اختراع معلومة.

المراجعة الرسمية الحالية تقول:

- Cron متاح في كل الخطط؛ Hobby يسمح **مرة يوميًا فقط** ودقة التنفيذ داخل الساعة (±59 دقيقة)، بينما Pro/Enterprise يصلان إلى دقيقة. لذلك daily lifecycle مناسب تقنيًا لـHobby من ناحية cadence فقط.
  المصدر: <https://vercel.com/docs/cron-jobs/usage-and-pricing>
- Cron expression في Vercel دائمًا UTC. الكود نفسه يحسب Cairo/DST، لذا جدول ثابت مثل `5 2 * * *` UTC يظل صباحًا محليًا في كلتا حالتي DST؛ لا يعتمد على offset ثابت.
  المصدر: <https://vercel.com/docs/cron-jobs>
- Vercel يرسل `Authorization: Bearer $CRON_SECRET` إذا ضبط المالك `CRON_SECRET`. endpoint الجديد يقبل GET native ذلك header (ويقبل `x-cron-secret` فقط لتوافق scheduler موثوق خارجي). Vercel لا يعيد تشغيل invocation الفاشل تلقائيًا؛ idempotency/outbox يعالجان التشغيل المكرر/التالي، لكن يجب مراجعة dashboard/logs.
  المصدر: <https://vercel.com/docs/cron-jobs/manage-cron-jobs>
- Hobby مخصص للاستخدام الشخصي غير التجاري وفق وثائق Vercel. إن كان المشروع استخدامًا تجاريًا فعليًا، فـPro مطلوب بسبب شرط الاستخدام، لا بسبب daily cadence وحدها.
  المصدر: <https://vercel.com/docs/plans/hobby>
- حد Function في Hobby 300 ثانية؛ worker يعالج outbox في batches من 100، لكن يجب قياس Preview قبل تفعيله على قاعدة كبيرة.
  المصدر: <https://vercel.com/docs/functions/limitations>

### قرار المالك المطلوب لاحقًا — لم يُنفذ

بعد موافقة صريحة فقط:

1. تأكيد plan والاستخدام التجاري في Vercel dashboard (upgrade إلى Pro إن لزم).
2. إضافة `CRON_SECRET` عشوائي و`APP_BASE_URL` الصحيح داخل Vercel، من dashboard لا عبر chat/Git.
3. بعد نجاح Preview migration: إضافة **فقط حينها** هذا cron إلى `vercel.json` ثم deploy approved:

```json
{
  "crons": [
    { "path": "/api/internal/subscriptions/run", "schedule": "5 2 * * *" }
  ]
}
```

4. اختبر endpoint من Cron dashboard وراقب `emailFailed` / `emailUnavailable`; لا يوجد claim أن البريد أو Cron يعمل قبل ذلك.

## كوبون winback

يوجد coupon catalog/validation لكن لا يوجد redemption داخل payment request الحالي؛ لذلك winback لا يذكر كوبونًا الآن كي لا يقدّم عرضًا غير قابل للتنفيذ. عند إضافة redemption server-side وaudit للسعر، يمكن تمديد content builder فقط بعد اختبار أن الكود يُطبّق فعلًا على طلب الدفع.

## التحقق المحلي

- `corepack pnpm run typecheck:libs`
- `corepack pnpm --filter @workspace/api-server typecheck`
- `corepack pnpm --filter @workspace/api-server test`
- `node --check` للـinline frontend script

اختبارات fake clock تغطي thresholds day 23/27/29/30/33، duplicate run، renewal day 25 إلى day 60 وإلغاء pending، Free مع بقاء data، وDST Cairo. كلها تستخدم `pg-mem` synthetic فقط.
