# EgyTrend — ملاحظات المطوّر

> ⚠️ **مرجع تقني مختصر، وليس دليل إطلاق أو نشر معتمد.** لا تنسخ منه أسرارًا أو أوامر قاعدة بيانات أو إعدادات تحصيل. استخدم `.env.example` و`lib/db/migrations/README.md` و`DEPLOYMENT.md` (للسياق التاريخي فقط) وبوابات الإصدار الحالية.

## خريطة المستودع

```text
artifacts/
  egytrend/
    index.html       # واجهة المستخدم العامة
    admin.html       # واجهة الإدارة المنفصلة
    public/          # الصفحات العامة الثابتة
  api-server/
    src/routes/      # Express API routes
    src/lib/         # authorization / data policy / services
    data/            # inventory التحرير والمصادر المضمّن في الحزمة
lib/db/
  src/schema/        # نماذج Drizzle
  migrations/        # migrations مزدوجة up/down
scripts/
  run-db-migration.mjs # Preview/Test-only، ويتطلب backup متحققًا
```

## نقاط التشغيل الآمنة

- صلاحية المستخدم وVIP والإدارة **خادمية**؛ JWT/cookie مجرد مؤشر هوية يعاد التحقق منه من قاعدة البيانات عند كل مسار حساس.
- جلسات المتصفح `HttpOnly` و`SameSite=Lax`. لا يوجد `x-admin-token` أو `ADMIN_TOKEN` أو صلاحية من `localStorage`.
- حسابات الموظفين المعطّلة/المؤرشفة تفقد الصلاحيات فورًا. مسار `break_glass` استردادي قصير فقط ويتوقف عند وجود `super_admin` فعّال في الموظفين.
- عمليات الحذف ذات الأثر التشغيلي هي archive/disable حيث يلزم حفظ السجل (موظف، كوبون، خطة، محتوى).
- التحصيل معطّل افتراضيًا: وسيلة الدفع لا تظهر أو تقبل طلبًا إلا بإعداد DB صريح وصالح ومفعّل. لا تضف رقم محفظة أو سعرًا ثابتًا في HTML.
- لا تضع مفاتيح AI/market/e-mail أو كلمات مرور في المتصفح أو السجلات أو commits. نداءات المزودين تتم من backend فقط.

## الأخبار والأسواق

- `src/routes/news.ts` يجلب RSS للمصادر ذات **الموافقة التجارية المكتوبة فقط**. كل URL وDNS وredirect يمر بحماية SSRF، ولا تُنسخ أجسام المقالات.
- لا تُعد تفعيل مصدر أرشيفي أو ممنوع (ومن ذلك Investing.com) لمجرد أن endpoint متاح تقنيًا.
- قائمة المصادر موجودة في `artifacts/api-server/data/sources.json`. الإضافة لا تجعل المصدر حيًا: يلزم توثيق حق redisplay التجاري ثم مراجعة مخصصة.
- Twelve Data هو نقطة البداية التقنية للأسواق، لكنه لا يصبح مصدر عرض/إعادة توزيع عام إلا مع إثبات نطاق التغطية والترخيص. عند غياب مصدر مرخّص، تعرض الواجهة `غير متاح حاليًا` أو بيانات موصوفة بأنها متأخرة بدل قيم مصطنعة.

## التطوير والاختبار

- عدّل `index.html` أو `admin.html` بحسب الواجهة المقصودة، مع الحفاظ على RTL وmobile وaccessibility وdesign tokens.
- بعد تعديل API شغّل على الأقل:

```bash
corepack pnpm --filter @workspace/api-server run typecheck
corepack pnpm --filter @workspace/api-server run test
```

- بناء workspace والتحقق من Vercel يتمان من الجذر عند اكتمال التغيير. لا يُعد نجاح build بديلًا عن مراجعة Preview.
- اختبارات pg-mem هي معزولة ولا تتصل بـ Neon أو أي قاعدة إنتاج. لا تشغّل migrations أو scripts legacy على قاعدة مشتركة.

## قاعدة البيانات والإصدار

- استخدم فقط migration paired (up/down) مع backup حقيقي قابل للتحقق وخطة رجوع. `scripts/run-db-migration.mjs` يرفض production عمدًا.
- لا يتم نشر أو migration أو تفعيل دفع أو اتصال Gemini/Neon فعلي من هذه الوثيقة. يلزم صلاحية الحساب، إعدادات حقيقية، backup معتمد، ونجاح release preflight.
- `attached_assets/` إرثي ومعزول صراحةً عبر `.vercelignore`، ولا يُستورد من Vite ولا يدخل output Vercel المقصود. لا تنقل منه واجهة أو إعداد دفع إلى artifact حديث دون مراجعة مستقلة.
