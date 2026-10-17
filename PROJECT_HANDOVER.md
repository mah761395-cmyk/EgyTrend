# EgyTrend — تسليم تقني للـ `upgrade`

> **الحالة:** تطوير محلي فقط. لا يوجد deploy أو push أو merge أو اتصال بقاعدة Production أو تنفيذ migration أو إرسال بريد/دفع حقيقي أو إنشاء اشتراك مدفوع.
>
> **التاريخ:** 17 أكتوبر 2026 — Africa/Cairo  
> **الفرع النشط:** `upgrade`  
> **baseline المحفوظ:** tag `v6.0-before-upgrade` → `9844603778657535eb9ede1ad3f1540e894afaec`

## آخر commits على `upgrade`

| Commit | المحتوى |
|---|---|
| `eeafdca` | طبقة سوق مصدرية: cache/fallback/history OHLC، charts محلية، شفافية المصدر/التأخر، cards وصفية بدل توصيات. |
| `1c9e680` | أساس VIP مركزي: `hasVip()`، جدول entitlement، صفحة اشتراكي، سجل دفع وتجديد آمن. |
| `bc2d639` | إغلاق مصادر RSS غير المرخّصة للعرض التجاري fail-closed. |
| `cc559bd` | محفظة VIP محفوظة على الخادم مع أسعار source-bound فقط. |
| `8b6850e` | تنبيهات سعر/نسبة يومية محفوظة على الخادم، runner محمي، وإعداد بريد صاحب الحساب فقط. |
| `f215a90` | تسعير باقات server-evaluated: عروض مجدولة/مستهدفة، old price/شارة/عداد، payment snapshot وhistory/revert. |
| `cfb0e09` | حاسبات المستثمر VIP: runtime/math محميان، 8 pure calculators، حفظ/سجل/PDF authorization، quote/FX source-bound وpreview مجاني صادق. |
| `ecf3169` | تسليم تقني للحاسبات وmigration/verification handover. |
| `b69af34` | preflight آمن للـnon-payment، gating أدق لـTwelve/EGX، وتوثيق blockers الحقيقيين بلا deploy أو secrets. |

## ما تم تنفيذه

### 1) بيانات السوق والرسوم

- لا توجد أسعار بديلة أو ثابتة عند غياب مزود مرخّص؛ الواجهة تعرض **غير متاح حاليًا** بدل رقم مختلق.
- كل quote/history يحمل المصدر ووقت المصدر وحالة التأخر حيث تتوفر.
- OHLC اليومية ترفض candle من دون وقت vendor؛ لا تستخدم وقت الخادم كأنه وقت السوق.
- Lightweight Charts محلية مع notice/attribution في `artifacts/egytrend/THIRD_PARTY_NOTICES.md`.
- الشارت والحجم والفترات الأساسية متاحة حسب المصدر؛ MA/RSI محمية على السيرفر بـ VIP.
- بطاقات المتابعة وAI المحلي صياغتهما وصفية ومقيدة بالبيانات، بلا توصية شراء/بيع أو أهداف/عوائد متوقعة.

### 1.1) جاهزية مصدر البيانات والنشر بدون مدفوعات (`b69af34`)

- مرجع الحالة التشغيلية والخطوات الخارجية الآمنة موجود في `LIVE_READINESS.md`؛ هو يميز بوضوح بين **code-ready** و**live-configured**.
- `corepack pnpm run preflight:live` و`preflight:live:full` يفحصان presence/configuration فقط، ولا يطبَعان DB URL أو API key أو passwords أو contract reference، ولا ينفذان network call أو migration.
- Twelve Data لا يُستدعى إلا مع key + external-display acknowledgement + مرجع عقد غير سري + delay صريح + symbol map مؤكدة. إن كان delay صفرًا، يلزم acknowledgement منفصل للـreal-time.
- أي `egx:*` أو `stock:egx:*` محجوب برمجيًا حتى `TWELVE_DATA_EGX_DISPLAY_LICENSED=true` ومرجع EGX مستقل؛ وجود XCAI في catalog ليس entitlement للـquote أو redistribution.
- retry logs ورسائل provider-health لا تمرر raw upstream error، حتى لا يخرج URL قد يحتوي query API key.
- لم تُضف cron settings إلى `vercel.json` ولم يحدث Vercel link/deploy أو DB connection/migration؛ لا تغيّر هذه الوثائق المشروع الخارجي القائم.

### 2) الأخبار وحقوق العرض

- أي RSS خارجي بلا `commercialRedisplay.status = approved` وبلا evidence موثق لا يُجلب ولا يُعرض.
- العرض مقتصر على العنوان، snippet قصير، المصدر والرابط الأصلي؛ لا fetch أو نشر لجسم المقال.
- المصدر المؤرشف/المعلّق ظاهر للإدارة للمراجعة، لكنه غير ظاهر للـ public feed.
- لا يوجد مزود أخبار خارجي approved حاليًا افتراضيًا؛ الـ empty state مقصود وصريح.

### 3) VIP والاشتراكات

- مصدر الصلاحية واحد: `artifacts/api-server/src/lib/userAuth.ts` → `hasVip(claims)`.
- كل gates الحالية (AI، details VIP، MA/RSI/history، opportunities) تستعمل `hasVip()` على السيرفر؛ JWT أو localStorage لا يمنحان صلاحية.
- جدول `user_subscriptions` يحتفظ بـ snapshot الباقة (الاسم/المدة/المزايا) وتاريخ البداية/الانتهاء وحالة entitlement. أضيف محليًا في `0007` لكل دورة `cycle_id` و`grace_ends_at`؛ الانتهاء UTC ومدة الشهر **30×24 ساعة** لا `setMonth()`.
- موافقة الدفع تكتب subscription + projection legacy داخل transaction، وتجديد قبل الانتهاء يضيف المدة من `expires_at` الحالي، وبعده يبدأ من لحظة الاعتماد. التجديد يبدّل cycle ويلغي delivery queued/pending للدورة السابقة دون محو history وصل للمستخدم.
- محرك lifecycle المحلي (`subscription-lifecycle.ts`) يحجز monthly 7/3/1/expiry/+3 winback وannual 30/14/7/1/expiry بصيغة Cairo DST-safe، مع in-app CTA إلى الباقة المختارة وemail outbox مستقل (3 محاولات للفشل الفعلي). ينتهي access عند instant الانتهاء من `hasVip()` حتى لو Cron تأخر، وتبقى البيانات محفوظة ومقفولة.
- `SUBSCRIPTION_LIFECYCLE_HANDOVER.md` هو مرجع cron/grace/admin/dry-run وقرار Vercel؛ لا يوجد Cron أو secret أو migration منفذ بعد.
- `app_users.plan/vip_expires_at` الآن compatibility bridge فقط؛ للـ legacy users ذوي expiry معروف يوجد backfill في migration. لا يُخترع expiry لمن ليس له تاريخ مسجل.
- الباقات العامة تقرأ السعر/المدة/المزايا من إعدادات السيرفر. تعديل باقة جديدة لا يغير snapshot مشترك حالي.
- حذف الباقة من لوحة الإدارة أصبح archive (`isActive=false`) وليس delete.
- صفحة **اشتراكي** تعرض الباقة، الانتهاء، الأيام المتبقية، التجديد وسجل الدفعات من `/api/payments/my`.
- واجهة الباقات فيها مقارنة free/VIP وFAQ وسياسة الإلغاء/الاسترداد المطابقة لـ`terms.html`.
- **تسعير الباقات (`f215a90`):** المصدر الوحيد هو `artifacts/api-server/src/lib/pricing.ts` → `getEffectivePrice(user, plan, now)`. صفحات الباقات/الدفع تقرأ السعر الحالي والقديم والخصم/الشارة والعداد من `/api/payments/config` المبني من هذه الدالة؛ إنشاء الدفع يعيد الحساب في الخادم ولا يقرأ مبلغاً من المتصفح.
- السعر الأساسي في `subscription_plans`، والعروض في `plan_price_offers`: جمهور `all` أو `new_users` أو `expired_subscribers`، موعد بداية/نهاية Africa/Cairo، old price أكبر من الحالي، وشارة تلقائية أو نصية. انتهاء الوقت يعيد السعر الأساسي من الخادم بلا scheduler. config public عليها `Cache-Control: no-store` ولا يوجد TTL process cache للأسعار، لذلك يظهر أي حفظ فورًا.
- كل طلب دفع جديد يحفظ `payment_requests.price` و`price_snapshot` و`price_locked_until` (24 ساعة افتراضيًا، 1–168 ساعة من لوحة الإدارة). token freshness يمنع modal قديم من إنشاء طلب بسعر اختلف بعد العرض؛ الطلب المعلّق يبقى على snapshot ولا يتغير بعد تعديل الباقة.
- سجل `plan_price_change_logs` يحتفظ before/after ومن غيّر/متى، و`POST /api/admin/plans/:id/pricing/revert` يعيد آخر تغيير غير متراجع بدون حذف offers. `effectivePriceTemplateVariables()`/`interpolatePriceTemplate()` تملآن `{{price}}` و`{{old_price}}` و`{{discount_percent}}` من نفس النتيجة لأي email/admin template مستقبلي. صلاحية السعر server-side: super_admin أو permission صريحة `pricing.manage` فقط؛ منحها محصور على super_admin.
- الـUI يوضح السعر الحالي بخط أكبر، السعر الأصلي muted مشطوب، aria-label مناسب، وتوجد معاينة موبايل/ديسكتوب قبل النشر. لا يوجد رقم اشتراك ثابت في الواجهة.

### 4) حاسبات المستثمر VIP (`/calculators`)

- مسار `/calculators` في الـSPA يعرض للمستخدم المجاني **preview صادقًا** بأسماء الأدوات ولقطة موسومة «مثال توضيحي» وزر الاشتراك فقط؛ لا توجد معادلات أو نتائج مالية حقيقية في الـ public shell.
- أدوات VIP الكاملة لا تُربط في الصفحة العامة: `/api/calculators/bootstrap` ثم `/runtime.js` و`/math.js` كلها خلف `requireVipUser` و`Cache-Control: no-store`. حتى نسخ رابط JavaScript مباشر يُرفض للمجاني (`403`) ولغير المسجل (`401`).
- `artifacts/api-server/src/lib/calculators/math.ts` يحتوي pure functions مختبرة لـ P/L، position risk، compound، average، dividends، CAGR، inflation، وcurrency conversion. الخادم يرسل **نفس أجسام الدوال** كـES module محمي للمتصفح، لذلك لا توجد نسخة واجهة منفصلة يمكن أن تنحرف عن الاختبارات.
- الواجهة RTL/mobile-first: sidebar يتحول إلى dropdown، تحديث فوري، Reset/Copy، نتائج كبيرة وتفاصيل ومعادلة، لون ربح/خسارة، جدول/رسم compound، صفوف متوسط شراء ديناميكية، وتحذير ثابت «النتائج تقديرية ولا تمثل نصيحة استثمارية».
- زر «استخدم السعر الحالي» يمر عبر `/api/calculators/quote` فقط؛ يتطلب مصدرًا مرخّصًا و`asOf` وfreshness صالحين. real-time الأقدم من 5 دقائق أو EOD/unknown يُرفض، والـdelayed يظهر بعلامة **متأخر**؛ لا fallback وهمي.
- محول العملات يقرأ `/api/calculators/fx` من طبقة market-data server-side فقط (EGP/USD/EUR/GBP/SAR حسب المتاح)، ويعرض source/as-of لكل عملة مستخدمة. عند غياب المصدر أو stale snapshot يرد `غير متاح حاليًا` بلا سعر ثابت بديل.
- حفظ السيناريوهات وسجل النسخ/الحفظ/التصدير server-backed في `user_calculator_scenarios` و`user_calculator_activity`، وكل الحذف archive. تصدير PDF هو نافذة طباعة المتصفح بعد `POST /api/calculators/export` المحمي؛ يختار المستخدم «حفظ كـ PDF» للحفاظ على العربية دون خدمة خارجية.
- نتائج المعادلات التفصيلية المتوقع/الفعلي في `CALCULATOR_TEST_RESULTS.md`.

### 5) المحفظة الحقيقية

- جدول `portfolio_positions` وخدمات `/api/portfolio` و`/api/portfolio/positions` محمية بـ VIP server-side.
- position هو إدخال صريح من المستخدم (الرمز/الكمية/متوسط التكلفة)، وليس quote سوق.
- السعر المعروض يقرأ وقت الطلب فقط من market service المرخّص؛ إذا لا يوجد مصدر يرد `market: null` ولا يتم حساب قيمة وهمية.
- حذف مركز يحوله إلى `archived`؛ إعادة إضافة الرمز تستعيد نفس record بدل delete.
- الواجهة توقفت عن استخدام `localStorage` كمصدر للمحفظة. بيانات `pt` القديمة لا تُرفع تلقائيًا حتى لا تتحول بيانات متصفح غير موثوقة إلى سجل حساب.

### 6) تنبيهات السعر/النسبة والبريد

- جدول `user_price_alerts` وواجهات `/api/price-alerts` محمية بـ VIP server-side.
- الأنواع المدعومة: `price_above`، `price_below`، `change_percent_above`، `change_percent_below`.
- النسبة هي **نسبة التغير اليومية القادمة من المصدر** وليست ربح المستخدم الشخصي.
- runner محمي فقط عبر `POST /api/internal/price-alerts/run` مع `CRON_SECRET`. لا يمكن للمتصفح تشغيله.
- runner يتجاهل quote مجهول أو end-of-day أو متأخر عن نافذة الصلاحية، ويحتفظ بالـ source/as-of عند trigger.
- الانتقال إلى `triggered` conditional/idempotent حتى لا يكرر email/notification مع concurrent scheduler runs.
- البريد يذهب فقط إلى email مالك التنبيه المسجل في `app_users`؛ لا admin copy أو catch-all. لا يرسل شيء إذا SMTP أو email غير متوفرين.
- **لم يُضف scheduler/deployment أو CRON_SECRET**؛ لذلك لا توجد دعوى أن التنبيهات ترسل فعليًا الآن. هذا intentionally blocked إلى أن يوافق المالك على بيئة Preview وسcheduler.

## migrations pending فقط — لم تُنفذ

| Migration | الجدول/الغرض |
|---|---|
| `0001_market_daily_ohlc` | تاريخ OHLC يومي لمزود سوق مرخّص. |
| `0002_user_subscriptions` | entitlement VIP وbackfill آمن للـ legacy ذي expiry الموثق. |
| `0003_portfolio_positions` | المراكز الشخصية المحفوظة. |
| `0004_user_price_alerts` | قواعد تنبيهات السعر/النسبة وprovenance trigger. |
| `0005_subscription_plan_pricing` | عروض أسعار server-side/targeting/history وsnapshot طلب الدفع/مدة تثبيت السعر. |
| `0006_user_calculator_scenarios` | سيناريوهات حاسبات VIP وسجل save/copy/PDF export؛ archive-only rollback. |
| `0007_subscription_lifecycle` | cycle/grace UTC، reminders outbox/CTA، lifecycle events؛ rollback archive-only. |

كل ملف `down.sql` غير مدمر: يحتفظ بـrollback archive أو يعلّم السجلات archived بدل الحذف. تفاصيل التسلسل في `lib/db/migrations/README.md`.

### شرط التنفيذ لاحقًا

لا تنفذ أي migration على DB مشتركة/Production. التسلسل الضروري:

1. اختر **Preview/Test DB منفصلة** فقط.
2. أنشئ backup حقيقي يمكن استعادته، ثم راجعه.
3. راجع up/down SQL ونفذ عبر migration runner معتمد.
4. نفذ suite وPreview smoke test.
5. بعد reconciliation للـ legacy VIP، خذ موافقة صريحة جديدة قبل Production.

## التحقق المنفذ محليًا

نفذ آخرًا بنجاح:

```bash
corepack pnpm exec tsc -b lib/db
corepack pnpm --filter @workspace/api-server typecheck
corepack pnpm --filter @workspace/api-server test
corepack pnpm --filter @workspace/api-server build
corepack pnpm run verify:vercel
corepack pnpm --filter @workspace/egytrend typecheck
corepack pnpm --filter @workspace/egytrend build
node --check /tmp/egytrend-inline.js
node --check /tmp/egytrend-calculator-math.mjs
node --check /tmp/egytrend-calculator-runtime.mjs
```

- API: **41/41 tests passed** باستخدام `pg-mem` synthetic فقط، بلا `DATABASE_URL` حقيقية.
- suite تغطي: lifecycle دفع/entitlement/renewal، rejection of stale VIP JWT، server portfolio CRUD/archive، alerts CRUD/archive، وسلامة evaluator أمام quote stale/EOD، وتسعير الباقات (بداية/نهاية العرض، targeting، رفض old price غير صالح، snapshot، تجاهل مبلغ المتصفح، ورفض موظف بلا permission)، ومعادلات الحاسبات وحماية free/VIP المباشرة للـruntime/math/save/history/PDF export. أضيفت fake-clock coverage لدورة الاشتراك: day 23/27/29/30/33، cron مكرر بلا duplicate، 30 يوم UTC، renewal day 25 → day 60 وإلغاء pending، بقاء البيانات مع Free، DST Cairo، 3 محاولات البريد وdry-run غير المعدّل.
- تضاف تغطية Twelve الحالية: منع الطلب عند غياب contract reference، منع `real-time` عند delay صفر دون acknowledgement، حجب EGX حتى approval/reference مستقلين، ومنع تلخيص errors من تسريب API key أو request URL.
- تحذيران `dataStore watch ENOENT` أثناء tests بسبب مسارات JSON غير موجودة داخل test harness؛ ليسا فشلًا ولا كتابة على DB.
- `preflight:live:full` نجح على environment اصطناعية كاملة فقط، ورفض map EGX بلا acknowledgement/reference خاصين به كما هو مقصود؛ لم تُستخدم أي credentials حقيقية. تفاصيل النتيجة والشروط في `LIVE_READINESS.md`.

## مصادر ومزودون: الحالة القانونية

بحث read-only فقط؛ لا حسابات/keys/subscriptions/costs أنشئت.

- EGID/EGX، ICE، LSEG، Twelve Data، EODHD: coverage أو enterprise options موجودة، لكن عرض EGX للمشتركين يتطلب عقد/redisplay rights صريح.
- CoinGecko/GoldAPI/metals-api/news providers: لا تعتمد أي pricing page أو API availability كإذن redisplay؛ يلزم scope مكتوب.
- لا scraping لـ Investing.com أو أي مصدر يمنع ذلك.

## ما زال Blocked عمدًا

- لا provider مدفوع/credentials أو market license معتمدة.
- لا Preview DB حقيقية، backup، migration أو deploy.
- لا scheduler للـ price alerts أو lifecycle ولا SMTP test delivery؛ code/outbox موجود محليًا فقط.
- لا payment integration حقيقية أو external payment call.
- لا email morning digest؛ يجب ربطه بمصدر أخبار/سوق approved وسcheduler معتمد أولًا.
- watchlists/alerts/browser preference القديمة الأخرى ما زالت UI preferences محلية وليست source مالية موثوقة؛ لا تستخدمها للخادم كصلاحية أو رصيد.

## الخطوة المنطقية التالية

ابدأ بترتيب المالك الخارجي الموثق في `LIVE_READINESS.md`: تأكيد حقوق العرض/التأخير والرموز من provider، ثم وضع القيم في Vercel بدون مشاركتها في chat أو Git. بعد موافقة منفصلة على **Preview DB + backup workflow فقط**: طبّق migrations في Preview (ومنها `0006`)، نفذ E2E/visual smoke يدوي للحاسبات والحفظ/PDF، ثم أضف scheduler Preview محدود لتنبيهات الأسعار والموجز الصباحي. لا تنتقل إلى Production أو تضف provider مدفوع دون موافقة صريحة جديدة.
