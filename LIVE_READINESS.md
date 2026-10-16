# جاهزية التشغيل الحقيقي — بدون مدفوعات

> هذه الوثيقة تسجل الحالة الفعلية وآخر فحص في **17 أكتوبر 2026**. لا تحتوي على أسرار، ولا تعني أن أي مصدر أو قاعدة بيانات أو مشروع Vercel تم تفعيله.

## القرار التشغيلي الحالي

المنصة **لا تعرض سعراً أو FX مختلقاً** عندما لا يكون مصدر مرخّص ومُهيأ متاحاً. يبقى الرد/الواجهة في حالة `غير متاح حالياً` مع سبب صريح؛ لا يوجد fallback ثابت أو timestamp مصنوع.

تمت إضافة حاجز إضافي إلى موصل Twelve Data: لا يستطيع إجراء أي طلب خارجي إلا عند وجود كل ما يلي في بيئة **backend**:

1. `TWELVE_DATA_API_KEY`؛
2. `TWELVE_DATA_EXTERNAL_DISPLAY_LICENSED=true`، بعد حق عرض خارجي/إعادة توزيع مكتوب؛
3. `TWELVE_DATA_LICENSE_REFERENCE`، مرجع غير سري للعقد أو أمر الشراء أو موافقة الدعم؛
4. `TWELVE_DATA_DELAY_MINUTES` بالقيمة الفعلية المتفق عليها؛
5. `TWELVE_DATA_REALTIME_DISPLAY_LICENSED=true` أيضاً إن كانت القيمة `0` (عرض لحظي)؛
6. `TWELVE_DATA_SYMBOLS_JSON` برموز vendor أكدها المزود، وليس بتخمينات؛
7. لأي `egx:*` أو `stock:egx:*` في map: `TWELVE_DATA_EGX_DISPLAY_LICENSED=true` و`TWELVE_DATA_EGX_LICENSE_REFERENCE` أيضاً.

بالتالي، لا تكفي API key أو boolean وحدهما لتشغيل عرض أسعار للعملاء، ولا يكفي عقد عام لتشغيل EGX. المفتاح ومراجع العقد لا يخرجان إلى المتصفح أو responses أو logs. كما أن retry logs ورسائل health البريدية تستخدم تصنيف خطأ ثابتاً بدلاً من raw upstream error الذي قد يحمل URL به API key.

## نتيجة الفحص في هذا المستودع

| المجال                | الحالة الآن                                      | ما يمنع التشغيل الحقيقي                                                                              |
| --------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| الحاسبات المحمية      | جاهزة من ناحية الكود والاختبارات                 | تحتاج قاعدة بيانات موجودة وتشغيل migration الموثق بعد backup فقط لكي يعمل الحفظ الدائم               |
| Twelve Data adapter   | موجود، server-side وfail-closed                  | لا توجد key أو موافقة عرض أو مرجع عقد أو symbol map في البيئة المفحوصة                               |
| FX / الأسواق العالمية | يمكن ربطها فقط بالرموز والحقوق التي يؤكدها العقد | لا توجد حالياً حقوق/إعدادات مثبتة في المستودع؛ لذلك لا يظهر سعر بديل وهمي                            |
| EGX                   | **غير مفعّل عمداً**                              | لا يوجد دليل موثق على entitlement للـquote/EOD أو redisplay من Twelve للحساب المقصود                 |
| قاعدة البيانات        | schema/migrations محفوظة في Git                  | لا يوجد `DATABASE_URL` متصل أو backup صالح؛ لم تُنفّذ migration                                      |
| البريد والتنبيهات     | code paths موجودة                                | لا توجد SMTP أو cron secrets/إعداد job في البيئة المفحوصة                                            |
| Vercel                | `vercel.json` وbuild موجودان                     | لا يوجد local Vercel link/auth/project metadata في workspace؛ لم يُنشر شيء ولم تتغير إعدادات المشروع |
| المدفوعات             | خارج هذا النطاق                                  | لا provider أو collection أو charge تم تفعيله                                                        |

الفحص كان presence-only: لا يطبع قيم environment ولا يحاول الاتصال بقاعدة البيانات أو Twelve Data أو Vercel.

## وضع EGX وTwelve Data بدقة

- صفحة [XCAI في Twelve Data](https://twelvedata.com/exchanges/XCAI) تعرض البورصة ضمن الكتالوج ومستويات خطة، لكن قائمة endpoints المتاحة الظاهرة هناك لا تثبت حق quote/time-series أو إعادة عرض سعر EGX.
- توضح [سياسة الاستخدام التجاري والشخصي لـTwelve Data](https://support.twelvedata.com/en/articles/5332349-commercial-and-personal-usage) أن العرض التجاري يخضع لتراخيص البورصات، وأن non-US/redistribution قد يحتاجان موافقات أو اتفاقات منفصلة.
- تسجل [سياسة EOD لـTwelve Data](https://support.twelvedata.com/en/articles/12682324-end-of-day-eod-pricing-market-data) مصر ضمن الأسواق التي تتطلب رخصة أو قد لا تكون مدعومة لأسعار EOD؛ لذلك لا يجوز الاستنتاج من وجود `XCAI` أن سعر EGX متاح للنشر.
- [EGID](https://www.egidegypt.com/) تصف نفسها كموزع رسمي لبيانات EGX. وهي بديل تجاري محتمل للـEGX فقط بعد عقد يحدد protocol والرموز وحقوق عرض المشتركين؛ الموصل الحالي لا يدّعي وجود تكامل معها.

النتيجة: Twelve Data هو **المصدر المبدئي في الكود**، لا مصدر EGX حي مُعتمد. لا تُضاف رموز `egx:*` إلى map ولا يضبط acknowledgement إلى `true` حتى تصل الموافقة المكتوبة وتأكيد الرموز/التأخير. إن لم يغطي العقد EGX، يظل EGX `غير متاح حالياً` بدلاً من استخدام scraping أو data غير مرخصة.

## preflight آمن قبل أي Preview أو Production

```bash
# المتطلبات الأساسية للحاسبات + مصدر بيانات حي مرخّص
corepack pnpm run preflight:live

# يضيف فحص البريد وcron secrets، من دون المدفوعات
corepack pnpm run preflight:live:full
```

السكربت:

- يقرأ `.env` محلياً إن وجد بدون تنفيذه، وتغلب عليه قيم CI/Vercel؛
- **لا يطبع** URL أو password أو API key أو contract reference؛
- **لا يعمل** network request أو DB query أو migration؛
- يفشل بخروج `1` ويذكر اسم الشرط فقط إذا كان غير مكتمل؛
- يتحقق أن map غير فارغ ومفاتيحه موجودة في catalog المحلي، لكنه لا يدّعي صحة رموز vendor؛ تلك تؤكدها الجهة الموردة فقط.

`TWELVE_DATA_DELAY_MINUTES=0` لا يمر إلا مع acknowledgement منفصل للعرض اللحظي. أي تأخير موجب يعرض البيانات كـ`متأخر` بدلاً من `لحظي`.

## ما يحتاجه مالك المشروع خارج المستودع

هذه ليست خطوات تم تنفيذها آلياً هنا؛ هي قائمة ترتيب آمنة عندما يقرر المالك التحرك:

1. الحصول على تأكيد مكتوب من Twelve Data (أو EGID للـEGX) يحدد الأسواق والـendpoints ونوع التأخير وحق external display/redistribution، ثم الاحتفاظ بمرجع غير سري له.
2. في **Vercel project الموجود**، وضع القيم الحقيقية في Environment Variables للبيئة المقصودة فقط. لا تُرسل هذه القيم في chat أو commit، ولا تستخدم mapping متخيل.
3. قبل أي migration إنتاجية: إنشاء backup حقيقي قابل للتحقق، مراجعة `0006_user_calculator_scenarios.up.sql` و`.down.sql`، ثم تشغيل migration في نافذة تغيير مع خطة rollback. لا تُشغّل migration من هذا preflight.
4. تشغيل `corepack pnpm run preflight:live` في بيئة فيها القيم بالفعل، ثم Preview محدود؛ بعده تحقق يدوي من ظهور **اسم المصدر ووقت المصدر وحالة التأخير** لكل quote، ومن أن quote غير المرخص يبقى غير متاح.
5. لا يُفعّل mail أو cron إلا بعد اختبار recipient يخص المالك وإعداد Vercel Cron/job فعلي محمي بالسر المناسب. لم يُضف هذا التغيير cron deployment config لأنه قد يغير سلوك المشروع القائم.

## ما تم التحقق منه محلياً

- preflight على البيئة الحالية: يفشل بشكل متوقع على الشروط المفقودة، بدون كشف أي قيمة؛
- preflight على environment اصطناعية كاملة: ينجح في core و`--full-nonpayment`، بدون إجراء اتصال خارجي؛
- Twelve adapter: اختبارات تغطي منع الطلب عند غياب مرجع الترخيص ومنع label `real-time` عند delay صفر دون acknowledgement منفصل، ومنع EGX حتى approval/reference خاصين به؛
- error-safety test: URL أو API key داخل upstream error لا يخرجان في retry log أو health-email summary؛
- لم يتم إنشاء حساب أو اشتراك أو تكلفة أو secret أو Vercel deployment أو DB migration خلال هذا العمل.

## نطاق لم يتغير

- المدفوعات مؤجلة بالكامل.
- صلاحية VIP/admin تبقى server-side؛ لا تعتمد على `localStorage`.
- الحاسبات الثمانية تبقى خلف `requireVipUser` مع free preview صادق فقط.
- لا scraping لمصادر مالية، ولا سعر ثابت/وهمي، ولا تغيير domain أو provider account أو إعداد حساس تلقائياً.
