import { Router } from "express";
import { db } from "@workspace/db";
import { opportunities } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { logger } from "../lib/logger";

const router = Router();

const JWT_SECRET = process.env["SESSION_SECRET"] || "egytrend-secret-2026";
const ADMIN_PASSWORD = process.env["ADMIN_PASSWORD"] || "egytrend2026";
const LEGACY_TOKEN = process.env["ADMIN_TOKEN"] || process.env["SESSION_SECRET"] || "";

const ANTHROPIC_BASE = process.env["AI_INTEGRATIONS_ANTHROPIC_BASE_URL"];
const ANTHROPIC_KEY  = process.env["AI_INTEGRATIONS_ANTHROPIC_API_KEY"];
const AI_MODEL       = "claude-sonnet-4-6";

function isAdmin(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const token = req.headers["x-admin-token"] as string | undefined;
  if (!token) return false;
  if (LEGACY_TOKEN && token === LEGACY_TOKEN) return true;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { role?: string };
    return payload.role === "admin";
  } catch {
    return false;
  }
}

function requireAuth(req: any, res: any, next: any) {
  if (!isAdmin(req)) return res.status(401).json({ status: "error", message: "unauthorized" });
  next();
}

/* ─── GET /api/opportunities ─────────────────────────────────── */
router.get("/opportunities", async (req, res) => {
  try {
    const admin = isAdmin(req);
    const all = await db.select().from(opportunities).orderBy(desc(opportunities.createdAt));
    const visible = admin ? all : all.filter(o => o.status !== "deleted" && o.status !== "closed");
    res.json({ status: "ok", opportunities: visible });
  } catch (e) {
    res.status(500).json({ status: "error", message: "Failed to fetch opportunities" });
  }
});

/* ─── POST /api/opportunities ────────────────────────────────── */
router.post("/opportunities", requireAuth, async (req, res) => {
  try {
    const { title, summary, details, type, market, expectedReturn, riskLevel, sector, duration, deadline, status, featured, vipOnly } = req.body;
    if (!title || !summary || !type || !market) {
      return res.status(400).json({ status: "error", message: "title, summary, type, market required" });
    }
    const id = crypto.randomUUID().slice(0, 12);
    await db.insert(opportunities).values({
      id,
      title,
      summary,
      details: details || null,
      type,
      market,
      expectedReturn: expectedReturn || null,
      riskLevel: riskLevel ?? 3,
      sector: sector || null,
      duration: duration || null,
      deadline: deadline || null,
      status: status || "active",
      featured: featured ?? false,
      vipOnly: vipOnly ?? false,
    });
    res.json({ status: "ok", id });
  } catch (e) {
    res.status(500).json({ status: "error", message: "Failed to create opportunity" });
  }
});

/* ─── PUT /api/opportunities/:id ─────────────────────────────── */
router.put("/opportunities/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, summary, details, type, market, expectedReturn, riskLevel, sector, duration, deadline, status, featured, vipOnly } = req.body;
    await db.update(opportunities)
      .set({
        ...(title !== undefined && { title }),
        ...(summary !== undefined && { summary }),
        ...(details !== undefined && { details }),
        ...(type !== undefined && { type }),
        ...(market !== undefined && { market }),
        ...(expectedReturn !== undefined && { expectedReturn }),
        ...(riskLevel !== undefined && { riskLevel }),
        ...(sector !== undefined && { sector }),
        ...(duration !== undefined && { duration }),
        ...(deadline !== undefined && { deadline }),
        ...(status !== undefined && { status }),
        ...(featured !== undefined && { featured }),
        ...(vipOnly !== undefined && { vipOnly }),
        updatedAt: new Date(),
      })
      .where(eq(opportunities.id, id));
    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ status: "error", message: "Failed to update opportunity" });
  }
});

/* ─── DELETE /api/opportunities/:id ─────────────────────────── */
router.delete("/opportunities/:id", requireAuth, async (req, res) => {
  try {
    await db.delete(opportunities).where(eq(opportunities.id, req.params.id));
    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ status: "error", message: "Failed to delete opportunity" });
  }
});

/* ─── POST /api/opportunities/generate ───────────────────────
   AI-powered: reads real market data → asks Claude → inserts fresh opportunities.
   Admin-only. Replaces AI-generated ones so they stay current.
   ─────────────────────────────────────────────────────────── */
router.post("/opportunities/generate", requireAuth, async (req, res) => {
  if (!ANTHROPIC_BASE || !ANTHROPIC_KEY) {
    return res.status(503).json({ status: "error", message: "AI not provisioned" });
  }
  try {
    // Fetch live market data to feed into AI
    const [mkRes, newsRes] = await Promise.allSettled([
      fetch("http://localhost:8080/api/markets"),
      fetch("http://localhost:8080/api/news?limit=20"),
    ]);
    const mkData  = mkRes.status  === "fulfilled" && mkRes.value.ok  ? await mkRes.value.json()  : {};
    const newsData = newsRes.status === "fulfilled" && newsRes.value.ok ? await newsRes.value.json() : {};

    const mkSummary = JSON.stringify(mkData).slice(0, 3000);
    const newsSummary = ((newsData.articles || []) as any[])
      .slice(0, 15)
      .map((a: any) => `• ${a.title}`)
      .join("\n");

    const today = new Date().toLocaleDateString("ar-EG", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

    const prompt = `أنت محلل مالي متخصص بالأسواق المصرية والعالمية. اليوم ${today}.

بيانات السوق الحالية (JSON):
${mkSummary}

أبرز الأخبار المالية اليوم:
${newsSummary || "لا توجد أخبار"}

مطلوب: ولّد 8 فرص استثمارية حقيقية ومتنوعة مناسبة للمستثمر المصري الآن.
التنوع المطلوب: أسهم مصرية (2)، كريبتو (1)، ذهب أو سلع (1)، أذون خزانة أو سندات (1)، عقارات (1)، ETF أو صناديق (1)، سوق خليجي أو أمريكي (1).

أعد JSON فقط بدون أي نص إضافي — array من 8 objects، كل object يحتوي:
{
  "title": "عنوان قصير وجذاب بالعربي",
  "summary": "جملتان تشرحان الفرصة والسبب وراءها بناءً على السوق الحالي (بالعربي)",
  "details": "فقرة تفصيلية: نقاط القوة، المخاطر، وكيف يستفيد المستثمر (بالعربي، 3-4 جمل)",
  "type": "stock|ipo|realestate|fund|etf|bond|crypto|commodity",
  "market": "egypt|us|gulf|crypto|global",
  "expectedReturn": "مثال: 18-25% سنوياً",
  "riskLevel": 1-5,
  "sector": "اسم القطاع",
  "duration": "مثال: 3-6 أشهر",
  "featured": true|false,
  "vipOnly": true|false
}

قواعد:
- اجعل العوائد واقعية بناءً على البيانات المتاحة، لا مبالغة
- 2 فرص على الأقل vipOnly: true (التفاصيل الحصرية)
- 1-2 فرص featured: true (الأبرز اليوم)
- استند إلى الأرقام الحقيقية من بيانات السوق
- أسهم EGX: اذكر رمز السهم في العنوان`;

    const aiRes = await fetch(`${ANTHROPIC_BASE}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(45_000),
    });

    if (!aiRes.ok) {
      const err = await aiRes.text();
      logger.warn({ err }, "AI generation failed");
      return res.status(502).json({ status: "error", message: "AI request failed" });
    }

    const aiData: any = await aiRes.json();
    const rawText: string = aiData?.content?.[0]?.text || "[]";

    // Extract JSON array from response
    const match = rawText.match(/\[[\s\S]*\]/);
    if (!match) return res.status(502).json({ status: "error", message: "AI returned invalid JSON" });

    const oppList: any[] = JSON.parse(match[0]);
    if (!Array.isArray(oppList) || oppList.length === 0) {
      return res.status(502).json({ status: "error", message: "AI returned empty list" });
    }

    // Delete previous AI-generated opportunities (those with source="ai")
    // We tag them via sector prefixed "AI:" — instead just insert new, mark old closed
    // Strategy: insert all new ones; close old AI-generated ones (sector starts with "[AI]")
    const existingAll = await db.select().from(opportunities);
    const aiGenIds = existingAll
      .filter(o => o.sector?.startsWith("[AI]"))
      .map(o => o.id);

    for (const id of aiGenIds) {
      await db.update(opportunities)
        .set({ status: "closed", updatedAt: new Date() })
        .where(eq(opportunities.id, id));
    }

    // Insert new ones
    let inserted = 0;
    for (const opp of oppList) {
      if (!opp.title || !opp.summary || !opp.type || !opp.market) continue;
      const id = crypto.randomUUID().slice(0, 12);
      await db.insert(opportunities).values({
        id,
        title: opp.title,
        summary: opp.summary,
        details: opp.details || null,
        type: opp.type,
        market: opp.market,
        expectedReturn: opp.expectedReturn || null,
        riskLevel: Math.min(5, Math.max(1, Number(opp.riskLevel) || 3)),
        sector: `[AI] ${opp.sector || ""}`,
        duration: opp.duration || null,
        deadline: null,
        status: "active",
        featured: opp.featured ?? false,
        vipOnly: true, // All opportunities are VIP-only
      });
      inserted++;
    }

    logger.info({ inserted }, "AI opportunities generated");
    res.json({ status: "ok", inserted, closedOld: aiGenIds.length });
  } catch (e: any) {
    logger.error({ err: e?.message }, "generate opportunities error");
    res.status(500).json({ status: "error", message: e?.message || "Failed" });
  }
});

/* ─── POST /api/opportunities/seed ───────────────────────────
   One-time seed with 15 curated real opportunities.
   Won't duplicate if already seeded (checks count > 0).
   ─────────────────────────────────────────────────────────── */
router.post("/opportunities/seed", requireAuth, async (req, res) => {
  const { force } = req.body || {};
  try {
    const existing = await db.select().from(opportunities);
    if (existing.length > 0 && !force) {
      return res.json({ status: "skipped", reason: "already seeded", count: existing.length });
    }

    const SEED: Array<{
      title: string; summary: string; details: string; type: string; market: string;
      expectedReturn: string; riskLevel: number; sector: string; duration: string;
      featured: boolean; vipOnly: boolean; deadline?: string;
    }> = [
      {
        title: "أذون الخزانة المصرية 91 يوم — عائد 27.5% سنوياً",
        summary: "تتيح وزارة المالية أذون خزانة بعائد 27-28% سنوياً، الأعلى في تاريخ مصر. استثمار خالٍ من المخاطر بضمان الحكومة المصرية.",
        details: "أذون الخزانة من أأمن أدوات الاستثمار في مصر — مضمونة 100% من الحكومة. العائد الحالي 27.5% على 91 يوماً (يُطرح بأسعار خصم). تُباع بمزادات البنك المركزي كل أسبوع. يمكن الاشتراك عبر أي بنك مصري أو تطبيق الخدمات المالية. مثالية لمن يريد عائداً محفوظاً يتفوق على التضخم.",
        type: "bond",
        market: "egypt",
        expectedReturn: "27-28% سنوياً",
        riskLevel: 1,
        sector: "أدوات دين حكومية",
        duration: "91 يوم (متجددة)",
        featured: true,
        vipOnly: false,
      },
      {
        title: "CIB — بنك التجاري الدولي (COMI.CA)",
        summary: "أكبر بنك خاص في مصر يحقق أرباحاً قياسية مع ارتفاع أسعار الفائدة. القطاع البنكي هو الأقوى أداءً في EGX هذا العام.",
        details: "CIB يتمتع بميزانية قوية وعائد توزيعات نقدية ثابت. مع استمرار البيئة المرتفعة للفائدة، صافي هامش الفائدة في ارتفاع. السهم يداوم على النمو فوق المؤشر العام. نقطة دخول جيدة عند أي تراجع نحو 85-90 جنيه. استراتيجية احتجاز طويل المدى مناسبة للمستثمر المحافظ.",
        type: "stock",
        market: "egypt",
        expectedReturn: "20-30% سنوياً",
        riskLevel: 2,
        sector: "بنوك",
        duration: "6-12 شهر",
        featured: true,
        vipOnly: false,
      },
      {
        title: "البيتكوين عند مناطق دعم قوية — $57K-$60K",
        summary: "BTC تراجع من قمة $70K ويتداول الآن عند مناطق دعم تاريخية. المحللون يرون تراجعاً صحياً قبل الموجة التالية.",
        details: "بيتكوين يتداول عند $59K — قريب من نطاق الدعم $57K-$60K الذي صمد في التراجعات السابقة. ETFs البيتكوين تسجل تدفقات شرائية متزايدة. قرار الفيدرالي الأمريكي بتثبيت الفائدة يدعم الأصول المخاطرة. المدخل الموصى به: جزء صغير من المحفظة (5-10%) مع stop-loss تحت $55K.",
        type: "crypto",
        market: "crypto",
        expectedReturn: "30-50% (6 أشهر)",
        riskLevel: 4,
        sector: "كريبتو",
        duration: "3-6 أشهر",
        featured: false,
        vipOnly: false,
      },
      {
        title: "الذهب — ملاذ آمن عند مستويات قياسية",
        summary: "أونصة الذهب تتجاوز $3,300 للأونصة مع استمرار التوترات الجيوسياسية وضعف الدولار. التوجه العالمي نحو تنويع الاحتياطيات يدعم الأسعار.",
        details: "الذهب في اتجاه صعودي قوي منذ 2024 — وصل $3,400 ثم تراجع قليلاً. المصريون يستفيدون أيضاً من فرق سعر الدولار. يمكن الاستثمار عبر: شراء سبائك محلياً، أو صندوق فيصل الإسلامي للذهب، أو ETF على ذهب GDGD. الذهب يُعتبر تحوطاً ضد التضخم ومخاطر العملة.",
        type: "commodity",
        market: "global",
        expectedReturn: "15-20% سنوياً",
        riskLevel: 2,
        sector: "سلع قيّمة",
        duration: "12+ شهر",
        featured: false,
        vipOnly: false,
      },
      {
        title: "أبوقير للأسمدة (ABUK) — قطاع صناعي متين",
        summary: "أحد أكبر منتجي الأسمدة في مصر والمنطقة. الطلب العالمي على الأسمدة في ارتفاع مع مشكلات سلاسل التوريد العالمية.",
        details: "ABUK يمتلك ميزة تنافسية بالغاز الطبيعي المحلي الرخيص. صافي الأرباح يرتفع مع ارتفاع أسعار اليوريا عالمياً. الشركة توزع أرباحاً نقدية سخية. السهم أقل ارتباطاً بالتقلبات السياسية المحلية. مناسب للمستثمر الباحث عن ثبات مع نمو معقول.",
        type: "stock",
        market: "egypt",
        expectedReturn: "15-25% سنوياً",
        riskLevel: 2,
        sector: "صناعات كيماوية",
        duration: "6-12 شهر",
        featured: false,
        vipOnly: false,
      },
      {
        title: "ETF iShares MSCI Emerging Markets — تنويع ناشئة",
        summary: "صندوق متداول يعطيك تعرضاً لأسواق الدول الناشئة (الهند، البرازيل، كوريا، مصر) بتكلفة منخفضة جداً.",
        details: "EEM من أشهر ETFs في العالم بأصول تتجاوز $20B. مؤشر الأسواق الناشئة تحسّن مع انتهاء دورة رفع الفائدة الأمريكية. التنويع الجغرافي يقلل مخاطر الارتباط بسوق واحدة. يُتداول عبر منصات دولية مثل Saxo أو Interactive Brokers. مناسب للمستثمر الذي يريد ادخار دولاري منتظم.",
        type: "etf",
        market: "us",
        expectedReturn: "12-18% سنوياً",
        riskLevel: 3,
        sector: "أسواق ناشئة متنوعة",
        duration: "12-36 شهر",
        featured: false,
        vipOnly: false,
      },
      {
        title: "سولانا (SOL) — بلوكتشين الجيل القادم",
        summary: "SOL ارتفع +2.2% اليوم وسط ضعف في BTC. نشاط DeFi و NFT على شبكة سولانا في تصاعد ملحوظ مع قدوم موسم الأول.",
        details: "سولانا من أسرع شبكات البلوكتشين — 65,000 معاملة/ثانية بتكلفة شبه صفرية. Memecoin season على سولانا يجذب سيولة ضخمة. SOL الآن عند $73 بعد مقاومة $80 — أي كسر فوق $80 قد يفتح $100. المخاطرة عالية: لا تضع أكثر من 5% من محفظتك. stop-loss عند $60.",
        type: "crypto",
        market: "crypto",
        expectedReturn: "40-80% (محتمل)",
        riskLevel: 5,
        sector: "كريبتو - بلوكتشين",
        duration: "1-3 أشهر",
        featured: false,
        vipOnly: true,
      },
      {
        title: "العاصمة الإدارية — شقق تجارية مشارك",
        summary: "الطلب على الوحدات التجارية والإدارية في العاصمة الجديدة في ارتفاع مستمر مع اكتمال البنية التحتية وتزايد السكان.",
        details: "العاصمة الإدارية الجديدة تشهد إقبالاً غير مسبوق من الشركات والحكومة. وحدات المكاتب في المناطق التجارية (CBD) حققت عوائد إيجارية 8-12% سنوياً. الأسعار ارتفعت 40-60% خلال 3 سنوات. الدخول عبر: التعاقد المباشر مع المطورين أو صناديق الاستثمار العقاري (REITs). مناسب للاستثمار متوسط المدى.",
        type: "realestate",
        market: "egypt",
        expectedReturn: "30-50% (3 سنوات)",
        riskLevel: 3,
        sector: "عقارات تجارية",
        duration: "24-36 شهر",
        featured: false,
        vipOnly: true,
      },
      {
        title: "صندوق بنك مصر للأسهم — إدارة محترفة",
        summary: "من أقوى الصناديق الاستثمارية في مصر بعائد تاريخي يتفوق على EGX30. مناسب للمستثمر الذي يريد المشاركة في السوق بدون إدارة يومية.",
        details: "بنك مصر للأسهم يستثمر في حزمة متنوعة من أفضل أسهم EGX بإدارة محترفة. العائد التاريخي 5 سنوات تجاوز 18% سنوياً. رسوم إدارية منخفضة مقارنة بالمنافسين. الحد الأدنى للاستثمار 1000 جنيه فقط. يمكن الاشتراك من أي فرع بنك مصر أو عبر التطبيق.",
        type: "fund",
        market: "egypt",
        expectedReturn: "18-22% سنوياً",
        riskLevel: 3,
        sector: "صناديق استثمار",
        duration: "12+ شهر",
        featured: false,
        vipOnly: false,
      },
      {
        title: "شركة المصريين للاتصالات (ETEL) — حصة 45% من أسهم اتصالات مصر",
        summary: "ETEL تمتلك حصة استراتيجية في اتصالات مصر. القطاع الدفاعي يؤدي جيداً في فترات التقلب الاقتصادي.",
        details: "ETEL من الأسهم الدفاعية النادرة في EGX — إيراداتها ثابتة من خدمات الاتصالات. الحكومة تدعم التحول الرقمي مما يعزز الطلب. السهم يوزع أرباحاً سنوية منتظمة. مناسب للمستثمر المحافظ الذي يريد عائداً دفاعياً في بيئة غير مستقرة.",
        type: "stock",
        market: "egypt",
        expectedReturn: "12-18% سنوياً",
        riskLevel: 2,
        sector: "اتصالات",
        duration: "6-12 شهر",
        featured: false,
        vipOnly: false,
      },
      {
        title: "S&P 500 عبر VOO ETF — الاقتصاد الأمريكي",
        summary: "VOO يتتبع أكبر 500 شركة أمريكية بتكلفة 0.03% فقط. متوسط العائد التاريخي 10-12% سنوياً بالدولار.",
        details: "Vanguard S&P 500 ETF من أفضل أدوات الادخار الدولاري طويل المدى. استراتيجية DCA (الشراء الدوري الثابت) تعطي أفضل نتائج على 5+ سنوات. الاقتصاد الأمريكي يُظهر صموداً رغم الفائدة المرتفعة. تداول عبر منصات دولية مرخصة. مناسب كجزء من محفظة متنوعة للادخار الدولاري.",
        type: "etf",
        market: "us",
        expectedReturn: "10-14% سنوياً بالدولار",
        riskLevel: 2,
        sector: "مؤشرات أمريكية",
        duration: "36+ شهر",
        featured: false,
        vipOnly: false,
      },
      {
        title: "سوق الأسهم السعودي (TADAWL) — فرصة خليجية",
        summary: "تداول يُعتبر من أكثر الأسواق الخليجية نضجاً وسيولة. رؤية 2030 تدفع نمو قطاعات الترفيه والبنية التحتية والتقنية.",
        details: "سوق تداول السعودي يوفر تعرضاً لاقتصاد متنوع خارج النفط. شركات مثل أرامكو، الراجحي، وstc تقدم مزيجاً من الاستقرار والنمو. أسعار النفط المستقرة تدعم ميزانية المملكة والإنفاق الحكومي. التداول عبر صناديق مرخصة أو منصات تداول دولية.",
        type: "etf",
        market: "gulf",
        expectedReturn: "14-20% سنوياً",
        riskLevel: 3,
        sector: "أسواق خليجية",
        duration: "12-24 شهر",
        featured: false,
        vipOnly: true,
      },
      {
        title: "إيثريوم (ETH) — بعد الدمج: حصة بـ Staking",
        summary: "ETH يدفع 4-5% عائد سنوي من Staking فوق أي ارتفاع في السعر. شبكة DeFi الأكبر عالمياً بحجم استخدام متنامٍ.",
        details: "Ethereum Staking يمنحك عائداً بالدولار بدون بيع ETH. ETH ETF الأمريكية بدأت تستقطب مليارات. الإيثريوم يرتبط بنمو Web3 والتطبيقات اللامركزية على المدى الطويل. ETH الآن $1,600 — أقل من ذروة $4,900. مناسب للمستثمر الذي يفهم الكريبتو ويريد عائداً مستمراً.",
        type: "crypto",
        market: "crypto",
        expectedReturn: "4-5% Staking + نمو",
        riskLevel: 4,
        sector: "كريبتو - DeFi",
        duration: "6-18 شهر",
        featured: false,
        vipOnly: true,
      },
      {
        title: "سندات الحكومة المصرية بالدولار — عائد 8%",
        summary: "مصر تُصدر سندات دولارية (Eurobonds) بعائد 7.5-8.5% — من أعلى العوائد الدولارية في المنطقة مع انتعاش الاقتصاد المصري.",
        details: "Eurobonds المصرية تداولت بخصم كبير وعادت للمستويات الطبيعية مع تحسن تصنيف مصر الائتماني. العائد الحالي 8% بالدولار يفوق معظم السندات الناشئة. المخاطرة: ارتباط بالتصنيف السيادي المصري. يُتداول عبر بنوك استثمارية دولية. للمستثمر الذي يريد دخلاً ثابتاً بالدولار.",
        type: "bond",
        market: "global",
        expectedReturn: "7.5-8.5% بالدولار",
        riskLevel: 3,
        sector: "سندات سيادية",
        duration: "12-60 شهر",
        featured: true,
        vipOnly: true,
      },
      {
        title: "صناديق ريت العقارية المصرية (REITs)",
        summary: "صناديق الريت المصرية تتيح الاستثمار في العقار بداية من 1000 جنيه مع توزيعات ربحية دورية دون عناء إدارة العقار.",
        details: "سوق الريت المصري في بدايته — فرصة الدخول المبكر قبل النضج. توزيعات ربحية إلزامية لا تقل عن 90% من صافي الدخل. الأصول موزعة على مراكز تجارية وأبراج سكنية ومستشفيات. مناسب للمستثمر الذي يريد تعرضاً عقارياً بسيولة عالية مقارنة بالعقار المباشر.",
        type: "fund",
        market: "egypt",
        expectedReturn: "10-15% (توزيعات + نمو)",
        riskLevel: 2,
        sector: "صناديق عقارية",
        duration: "12+ شهر",
        featured: false,
        vipOnly: false,
      },
    ];

    let inserted = 0;
    for (const s of SEED) {
      const id = crypto.randomUUID().slice(0, 12);
      await db.insert(opportunities).values({
        id,
        title: s.title,
        summary: s.summary,
        details: s.details,
        type: s.type,
        market: s.market,
        expectedReturn: s.expectedReturn,
        riskLevel: s.riskLevel,
        sector: s.sector,
        duration: s.duration,
        deadline: (s as any).deadline || null,
        status: "active",
        featured: s.featured,
        vipOnly: true, // All opportunities are VIP-only
      });
      inserted++;
    }

    res.json({ status: "ok", inserted });
  } catch (e: any) {
    logger.error({ err: e?.message }, "seed opportunities error");
    res.status(500).json({ status: "error", message: e?.message || "Failed" });
  }
});

export default router;
