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

## ما تم تنفيذه

### 1) بيانات السوق والرسوم

- لا توجد أسعار بديلة أو ثابتة عند غياب مزود مرخّص؛ الواجهة تعرض **غير متاح حاليًا** بدل رقم مختلق.
- كل quote/history يحمل المصدر ووقت المصدر وحالة التأخر حيث تتوفر.
- OHLC اليومية ترفض candle من دون وقت vendor؛ لا تستخدم وقت الخادم كأنه وقت السوق.
- Lightweight Charts محلية مع notice/attribution في `artifacts/egytrend/THIRD_PARTY_NOTICES.md`.
- الشارت والحجم والفترات الأساسية متاحة حسب المصدر؛ MA/RSI محمية على السيرفر بـ VIP.
- بطاقات المتابعة وAI المحلي صياغتهما وصفية ومقيدة بالبيانات، بلا توصية شراء/بيع أو أهداف/عوائد متوقعة.

### 2) الأخبار وحقوق العرض

- أي RSS خارجي بلا `commercialRedisplay.status = approved` وبلا evidence موثق لا يُجلب ولا يُعرض.
- العرض مقتصر على العنوان، snippet قصير، المصدر والرابط الأصلي؛ لا fetch أو نشر لجسم المقال.
- المصدر المؤرشف/المعلّق ظاهر للإدارة للمراجعة، لكنه غير ظاهر للـ public feed.
- لا يوجد مزود أخبار خارجي approved حاليًا افتراضيًا؛ الـ empty state مقصود وصريح.

### 3) VIP والاشتراكات

- مصدر الصلاحية واحد: `artifacts/api-server/src/lib/userAuth.ts` → `hasVip(claims)`.
- كل gates الحالية (AI، details VIP، MA/RSI/history، opportunities) تستعمل `hasVip()` على السيرفر؛ JWT أو localStorage لا يمنحان صلاحية.
- جدول `user_subscriptions` يحتفظ بـ snapshot الباقة (الاسم/المدة/المزايا) وتاريخ البداية/الانتهاء وحالة entitlement.
- موافقة الدفع تكتب subscription + projection legacy داخل transaction، وتجديد دفع لاحق يضيف المدة بدل إعادة البداية.
- `app_users.plan/vip_expires_at` الآن compatibility bridge فقط؛ للـ legacy users ذوي expiry معروف يوجد backfill في migration. لا يُخترع expiry لمن ليس له تاريخ مسجل.
- الباقات العامة تقرأ السعر/المدة/المزايا من إعدادات السيرفر. تعديل باقة جديدة لا يغير snapshot مشترك حالي.
- حذف الباقة من لوحة الإدارة أصبح archive (`isActive=false`) وليس delete.
- صفحة **اشتراكي** تعرض الباقة، الانتهاء، الأيام المتبقية، التجديد وسجل الدفعات من `/api/payments/my`.
- واجهة الباقات فيها مقارنة free/VIP وFAQ وسياسة الإلغاء/الاسترداد المطابقة لـ`terms.html`.

### 4) المحفظة الحقيقية

- جدول `portfolio_positions` وخدمات `/api/portfolio` و`/api/portfolio/positions` محمية بـ VIP server-side.
- position هو إدخال صريح من المستخدم (الرمز/الكمية/متوسط التكلفة)، وليس quote سوق.
- السعر المعروض يقرأ وقت الطلب فقط من market service المرخّص؛ إذا لا يوجد مصدر يرد `market: null` ولا يتم حساب قيمة وهمية.
- حذف مركز يحوله إلى `archived`؛ إعادة إضافة الرمز تستعيد نفس record بدل delete.
- الواجهة توقفت عن استخدام `localStorage` كمصدر للمحفظة. بيانات `pt` القديمة لا تُرفع تلقائيًا حتى لا تتحول بيانات متصفح غير موثوقة إلى سجل حساب.

### 5) تنبيهات السعر/النسبة والبريد

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

كل ملف `down.sql` غير مدمر: يعيد تسمية table إلى rollback archive بدل الحذف. تفاصيل التسلسل في `lib/db/migrations/README.md`.

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
corepack pnpm --filter @workspace/egytrend typecheck
corepack pnpm --filter @workspace/egytrend build
node --check /tmp/egytrend-inline.js
```

- API: **21/21 tests passed** باستخدام `pg-mem` synthetic فقط، بلا `DATABASE_URL` حقيقية.
- suite تغطي: lifecycle دفع/entitlement/renewal، rejection of stale VIP JWT، server portfolio CRUD/archive، alerts CRUD/archive، وسلامة evaluator أمام quote stale/EOD.
- تحذيران `dataStore watch ENOENT` أثناء tests بسبب مسارات JSON غير موجودة داخل test harness؛ ليسا فشلًا ولا كتابة على DB.

## مصادر ومزودون: الحالة القانونية

بحث read-only فقط؛ لا حسابات/keys/subscriptions/costs أنشئت.

- EGID/EGX، ICE، LSEG، Twelve Data، EODHD: coverage أو enterprise options موجودة، لكن عرض EGX للمشتركين يتطلب عقد/redisplay rights صريح.
- CoinGecko/GoldAPI/metals-api/news providers: لا تعتمد أي pricing page أو API availability كإذن redisplay؛ يلزم scope مكتوب.
- لا scraping لـ Investing.com أو أي مصدر يمنع ذلك.

## ما زال Blocked عمدًا

- لا provider مدفوع/credentials أو market license معتمدة.
- لا Preview DB حقيقية، backup، migration أو deploy.
- لا scheduler للـ price alerts ولا SMTP test delivery.
- لا payment integration حقيقية أو external payment call.
- لا email morning digest؛ يجب ربطه بمصدر أخبار/سوق approved وسcheduler معتمد أولًا.
- watchlists/alerts/browser preference القديمة الأخرى ما زالت UI preferences محلية وليست source مالية موثوقة؛ لا تستخدمها للخادم كصلاحية أو رصيد.

## الخطوة المنطقية التالية

بعد موافقة منفصلة على **Preview DB + backup workflow فقط**: طبّق migrations في Preview، نفذ E2E smoke يدوي، ثم نضيف scheduler Preview محدود لتنبيهات الأسعار والموجز الصباحي. لا تنتقل إلى Production أو تضف provider مدفوع دون موافقة صريحة جديدة.
