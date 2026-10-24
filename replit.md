# EgyTrend — دليل المطوّر

منصة أخبار مالية عربية متكاملة (موبايل + ديسكتوب) مع أسواق حية، AI محلل استثماري، نظام VIP، ولوحة أدمن.

---

## البنية العامة

```
artifacts/
  egytrend/         ← الواجهة الأمامية (index.html واحد)
  api-server/       ← الـ API (Express 5 + TypeScript)
    src/routes/     ← المسارات
    data/           ← ملفات JSON للمصادر والمقالات
```

---

## الملفات المهمة

| الملف | وظيفته |
|---|---|
| `artifacts/egytrend/index.html` | كل الواجهة — صفحات، تصميم، JavaScript |
| `artifacts/api-server/src/routes/news.ts` | جلب وتحليل RSS من 26 مصدر |
| `artifacts/api-server/src/routes/markets.ts` | بيانات الأسواق (Finnhub + Alpha Vantage + CoinGecko) |
| `artifacts/api-server/src/routes/ai.ts` | بروكسي Claude AI (Anthropic) |
| `artifacts/api-server/src/routes/admin.ts` | لوحة الأدمن — المصادر، المقالات، المستخدمين |
| `artifacts/api-server/data/sources.json` | قائمة مصادر الأخبار (26 مصدر) |
| `artifacts/api-server/src/lib/dataStore.ts` | حفظ البيانات في JSON (مصادر + مقالات) |

---

## 🚀 النشر

1. اضغط زر **Publish** في أعلى الصفحة
2. Replit يبني المشروع تلقائياً وينشره
3. الموقع يكون متاح على: `https://egytrend.replit.app` (أو اسم مشابه)
4. **لتحديث النسخة المنشورة بعد أي تعديل** → اضغط Publish مرة ثانية

---

## 🛠️ التطوير

### تعديل الواجهة
- افتح `artifacts/egytrend/index.html`
- التغييرات تظهر فوراً في المعاينة (Vite hot reload)
- **CSS الديسكتوب** في نهاية الملف عند `@media (min-width: 1024px)`
- **SOURCES array** (~سطر 837) — قائمة المصادر المعروضة للمستخدم

### تعديل الـ API / السيرفر
- عدّل الملف المناسب في `artifacts/api-server/src/routes/`
- **مهم:** بعد أي تعديل في السيرفر اضغط **Restart** على workflow الـ API
- السيرفر يُبنى تلقائياً عند الـ restart

### إضافة مصدر أخبار جديد
1. أضف كائن JSON في `artifacts/api-server/data/sources.json`
2. أضف نفس المصدر في `SOURCES` array بـ `index.html` (~سطر 837)
3. أعد تشغيل الـ API

### إضافة مقال من الأدمن
- ادخل من الموبايل → أدخل كلمة السر → لوحة الأدمن → "إدارة الأخبار"
- أو `POST /api/admin/articles` بجلسة إدارة مسجّلة (كوكي `et_admin`). الأدوات غير المتصفحية يمكنها إرسال JWT الموظف في هيدر `x-admin-token`.

---

## 🔑 كلمات السر والأسرار

| الإعداد | القيمة |
|---|---|
| كلمة سر الأدمن | تُضبط في `ADMIN_PASSWORD` (كاتب قوي وعشوائي — لا توجد قيمة افتراضية في الكود) أو حساب موظف في قاعدة البيانات |
| `FINNHUB_API_KEY` | مفتاح بيانات الأسواق الحية |
| `ALPHA_VANTAGE_API_KEY` | مفتاح أسعار العملات (25 طلب/يوم — cached 6 ساعات) |
| `SESSION_SECRET` | مفتاح تشفير توكن الأدمن |

لتغيير أي سر: **Tools → Secrets** في Replit

---

## 🔒 نظام VIP

- **المستخدم العادي** (`U.plan="free"`) → يقرأ الأخبار فقط
- **VIP** (`U.plan="vip"`) → AI محلل + كل الميزات
- **الأدمن** (`U.plan="admin"`) → كل شيء + لوحة التحكم
- الاشتراك يُفعَّل يدوياً من الأدمن بعد تأكيد الدفع

---

## 📰 مصادر الأخبار (26 مصدر)

**عربي مصري:** اليوم السابع، مصراوي، أموال الغد، الوطن، الشروق، أخبار مصر، المال، الدستور

**عربي خليجي/عالمي:** العربية، الجزيرة، BBC عربي، العين، سكاي نيوز عربية، مباشر، أرقام، الاقتصادية، بلومبرج الشرق، CNN عربي

**إنجليزي عالمي:** Reuters، CNBC، Yahoo Finance، MarketWatch، Investing.com، Financial Times

**كريبتو:** CoinDesk، CoinTelegraph

---

## 📊 مصادر بيانات الأسواق

| القسم | المصدر |
|---|---|
| EGX30 | TradingEconomics (scraping) |
| الفوركس (USD/EUR/GBP/SAR ← EGP) | Alpha Vantage (cached 6hr) |
| المؤشرات العالمية | Google Finance (scraping) |
| الذهب، الفضة، النفط | Finnhub ETF proxies (GLD/SLV/BNO) |
| البيتكوين وباقي الكريبتو | Finnhub + CoinGecko fallback |
| التقويم الاقتصادي | ForexFactory (cached 30min) |

---

## Stack التقني

- **Frontend:** Vanilla HTML/CSS/JS — RTL — خط Cairo — موبايل أول
- **Backend:** Express 5 + TypeScript — esbuild bundler
- **AI:** Anthropic Claude (via Replit AI Integrations proxy) — بدون API key في الكود
- **بيانات مستمرة:** JSON files (dataStore.ts) — localStorage للمستخدمين
- **Monorepo:** pnpm workspaces

---

## أوامر مفيدة

```bash
# تحقق من الأخطاء
pnpm run typecheck

# بناء كامل
pnpm run build

# تشغيل السيرفر يدوياً (للاختبار)
pnpm --filter @workspace/api-server run dev
```
