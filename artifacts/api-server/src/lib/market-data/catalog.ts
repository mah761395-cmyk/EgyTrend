import type { MarketInstrument } from "./types";

export type StockDefinition = { id: string; sym: string; name: string; sector: string };

/** Stable display catalog; vendor ticker mapping is injected only after licensing. */
export const MARKET_INSTRUMENTS: MarketInstrument[] = [
  { id: "egx:EGX30", symbol: "EGX30", name: "EGX30", section: "eg", kind: "index", subtitle: "مؤشر رئيسي", currency: "EGP" },
  { id: "egx:EGX70", symbol: "EGX70", name: "EGX70", section: "eg", kind: "index", subtitle: "مؤشر السبعين", currency: "EGP" },
  { id: "egx:EGX100", symbol: "EGX100", name: "EGX100", section: "eg", kind: "index", subtitle: "مؤشر المائة", currency: "EGP" },
  { id: "fx:USD-EGP", symbol: "USD/EGP", name: "USD/EGP", section: "eg", kind: "fx", subtitle: "دولار/جنيه", currency: "EGP" },
  { id: "fx:EUR-EGP", symbol: "EUR/EGP", name: "EUR/EGP", section: "eg", kind: "fx", subtitle: "يورو/جنيه", currency: "EGP" },
  { id: "fx:GBP-EGP", symbol: "GBP/EGP", name: "GBP/EGP", section: "eg", kind: "fx", subtitle: "إسترليني/جنيه", currency: "EGP" },
  { id: "fx:SAR-EGP", symbol: "SAR/EGP", name: "SAR/EGP", section: "eg", kind: "fx", subtitle: "ريال/جنيه", currency: "EGP" },
  { id: "index:SPX", symbol: "S&P 500", name: "S&P 500", section: "gl", kind: "index", subtitle: "أمريكي", currency: "USD" },
  { id: "index:NASDAQ", symbol: "NASDAQ", name: "NASDAQ", section: "gl", kind: "index", subtitle: "تقني", currency: "USD" },
  { id: "index:DAX", symbol: "DAX", name: "DAX", section: "gl", kind: "index", subtitle: "ألماني", currency: "EUR" },
  { id: "index:FTSE100", symbol: "FTSE 100", name: "FTSE 100", section: "gl", kind: "index", subtitle: "بريطاني", currency: "GBP" },
  { id: "commodity:XAU", symbol: "ذهب", name: "ذهب", section: "cm", kind: "commodity", subtitle: "أوقية", currency: "USD" },
  { id: "commodity:BRENT", symbol: "نفط برنت", name: "نفط برنت", section: "cm", kind: "commodity", subtitle: "برميل", currency: "USD" },
  { id: "commodity:XAG", symbol: "فضة", name: "فضة", section: "cm", kind: "commodity", subtitle: "أوقية", currency: "USD" },
  { id: "commodity:COPPER", symbol: "نحاس", name: "نحاس", section: "cm", kind: "commodity", subtitle: "رطل", currency: "USD" },
  { id: "crypto:BTC", symbol: "BTC", name: "BTC", section: "cr", kind: "crypto", subtitle: "بيتكوين", currency: "USD" },
  { id: "crypto:ETH", symbol: "ETH", name: "ETH", section: "cr", kind: "crypto", subtitle: "إيثريوم", currency: "USD" },
  { id: "crypto:SOL", symbol: "SOL", name: "SOL", section: "cr", kind: "crypto", subtitle: "سولانا", currency: "USD" },
  { id: "crypto:XRP", symbol: "XRP", name: "XRP", section: "cr", kind: "crypto", subtitle: "ريبل", currency: "USD" },
];

export const EGX_STOCKS: StockDefinition[] = [
  { id: "stock:egx:COMI", sym: "COMI", name: "البنك التجاري الدولي", sector: "بنوك" },
  { id: "stock:egx:HBCO", sym: "HBCO", name: "HSBC مصر", sector: "بنوك" },
  { id: "stock:egx:ADIB", sym: "ADIB", name: "مصرف أبوظبي الإسلامي", sector: "بنوك" },
  { id: "stock:egx:AIBC", sym: "AIBC", name: "بنك الاستثمار العربي", sector: "بنوك" },
  { id: "stock:egx:ABCB", sym: "ABCB", name: "بنك ABC مصر", sector: "بنوك" },
  { id: "stock:egx:EDBE", sym: "EDBE", name: "بنك تنمية الصادرات", sector: "بنوك" },
  { id: "stock:egx:MCQE", sym: "MCQE", name: "مصر للأسمنت - قنا", sector: "مواد بناء" },
  { id: "stock:egx:FWRY", sym: "FWRY", name: "فوري للتكنولوجيا", sector: "تقنية" },
  { id: "stock:egx:HRHO", sym: "HRHO", name: "هيرميس القابضة", sector: "مالية" },
  { id: "stock:egx:GBCO", sym: "GBCO", name: "جي بي اوتو (جي بي كورب)", sector: "صناعة" },
  { id: "stock:egx:SFAP", sym: "SFAP", name: "مصر للتأمين", sector: "مالية" },
  { id: "stock:egx:CIEB", sym: "CIEB", name: "كريدي أجريكول مصر", sector: "بنوك" },
  { id: "stock:egx:IDKO", sym: "IDKO", name: "إيدكو للغاز", sector: "مالية" },
  { id: "stock:egx:EFIH", sym: "EFIH", name: "إي فاينانس", sector: "تقنية" },
  { id: "stock:egx:OTLQ", sym: "OTLQ", name: "أوراسكوم TMT", sector: "تقنية" },
  { id: "stock:egx:ETEL", sym: "ETEL", name: "المصرية للاتصالات", sector: "اتصالات" },
  { id: "stock:egx:GGHE", sym: "GGHE", name: "جلوبال تيليكوم", sector: "اتصالات" },
  { id: "stock:egx:MTEL", sym: "MTEL", name: "أورنج مصر", sector: "اتصالات" },
  { id: "stock:egx:OCDI", sym: "OCDI", name: "سوديك", sector: "عقارات" },
  { id: "stock:egx:TMGH", sym: "TMGH", name: "طلعت مصطفى", sector: "عقارات" },
  { id: "stock:egx:MASR", sym: "MASR", name: "مدينة مصر للإسكان (مدينة نصر)", sector: "عقارات" },
  { id: "stock:egx:PHDC", sym: "PHDC", name: "بالم هيلز", sector: "عقارات" },
  { id: "stock:egx:HELI", sym: "HELI", name: "مصر الجديدة للإسكان والتعمير", sector: "عقارات" },
  { id: "stock:egx:CIRA", sym: "CIRA", name: "القاهرة للاستثمار والتعمير", sector: "عقارات" },
  { id: "stock:egx:CCAP", sym: "CCAP", name: "القلعة للاستشارات المالية", sector: "مالية" },
  { id: "stock:egx:ABUK", sym: "ABUK", name: "أبوقير للأسمدة", sector: "صناعة" },
  { id: "stock:egx:SWDY", sym: "SWDY", name: "السويدي إليكتريك", sector: "صناعة" },
  { id: "stock:egx:ESRS", sym: "ESRS", name: "عز للصلب", sector: "صناعة" },
  { id: "stock:egx:AMOC", sym: "AMOC", name: "أموك (الإسكندرية للزيوت المعدنية)", sector: "طاقة" },
  { id: "stock:egx:ACGC", sym: "ACGC", name: "العربية لحليج الأقطان", sector: "صناعة" },
  { id: "stock:egx:SKPC", sym: "SKPC", name: "سيدي كرير للبتروكيماويات", sector: "صناعة" },
  { id: "stock:egx:ORWE", sym: "ORWE", name: "النساجون الشرقيون", sector: "صناعة" },
  { id: "stock:egx:ARPH", sym: "ARPH", name: "العربية للأوراق", sector: "صناعة" },
  { id: "stock:egx:SPIN", sym: "SPIN", name: "سبينالكس (الإسكندرية للغزل والنسيج)", sector: "صناعة" },
  { id: "stock:egx:KABO", sym: "KABO", name: "كابو (النصر للملابس والمنسوجات)", sector: "صناعة" },
  { id: "stock:egx:CLHO", sym: "CLHO", name: "كليوباترا للمستشفيات", sector: "صحة" },
  { id: "stock:egx:ISPH", sym: "ISPH", name: "ابن سينا فارما", sector: "صحة" },
  { id: "stock:egx:ACDP", sym: "ACDP", name: "أكوردا إيجيبت", sector: "صحة" },
  { id: "stock:egx:BMWO", sym: "BMWO", name: "بيوميديكال للرعاية", sector: "صحة" },
  { id: "stock:egx:PHAR", sym: "PHAR", name: "إيبي فارما", sector: "أدوية" },
  { id: "stock:egx:EGCH", sym: "EGCH", name: "إيجيبت للصناعات الكيماوية", sector: "أدوية" },
  { id: "stock:egx:EAST", sym: "EAST", name: "الشرق للدخان", sector: "غذائية" },
  { id: "stock:egx:JUFO", sym: "JUFO", name: "جهينة للأغذية", sector: "غذائية" },
  { id: "stock:egx:EFID", sym: "EFID", name: "إيديتا للصناعات الغذائية", sector: "غذائية" },
  { id: "stock:egx:POUL", sym: "POUL", name: "القاهرة للدواجن", sector: "غذائية" },
  { id: "stock:egx:DOMT", sym: "DOMT", name: "دومتي (العربية للأغذية)", sector: "غذائية" },
  { id: "stock:egx:OLFI", sym: "OLFI", name: "عبور لاند للصناعات الغذائية", sector: "غذائية" },
  { id: "stock:egx:AMER", sym: "AMER", name: "عامر جروب", sector: "استثمار" },
  { id: "stock:egx:ASCM", sym: "ASCM", name: "أسيك للتعدين", sector: "مواد بناء" },
  { id: "stock:egx:ARCO", sym: "ARCO", name: "العربية للمقاولات", sector: "مواد بناء" },
  { id: "stock:egx:HELB", sym: "HELB", name: "هيلنان للفنادق", sector: "مواد بناء" },
  { id: "stock:egx:KAHA", sym: "KAHA", name: "قها للمحاصيل الغذائية", sector: "غذائية" },
  { id: "stock:egx:SCOM", sym: "SCOM", name: "سيدي كرير للصناعات", sector: "طاقة" },
  { id: "stock:egx:AMCO", sym: "AMCO", name: "أموك للطاقة", sector: "طاقة" },
];

export const US_STOCKS: StockDefinition[] = [
  { id: "stock:us:AAPL", sym: "AAPL", name: "Apple", sector: "Technology" },
  { id: "stock:us:MSFT", sym: "MSFT", name: "Microsoft", sector: "Technology" },
  { id: "stock:us:NVDA", sym: "NVDA", name: "NVIDIA", sector: "Technology" },
  { id: "stock:us:GOOGL", sym: "GOOGL", name: "Alphabet (Google)", sector: "Technology" },
  { id: "stock:us:META", sym: "META", name: "Meta Platforms", sector: "Technology" },
  { id: "stock:us:AVGO", sym: "AVGO", name: "Broadcom", sector: "Technology" },
  { id: "stock:us:ADBE", sym: "ADBE", name: "Adobe", sector: "Technology" },
  { id: "stock:us:CRM", sym: "CRM", name: "Salesforce", sector: "Technology" },
  { id: "stock:us:ORCL", sym: "ORCL", name: "Oracle", sector: "Technology" },
  { id: "stock:us:QCOM", sym: "QCOM", name: "Qualcomm", sector: "Technology" },
  { id: "stock:us:AMD", sym: "AMD", name: "AMD", sector: "Technology" },
  { id: "stock:us:INTC", sym: "INTC", name: "Intel", sector: "Technology" },
  { id: "stock:us:CSCO", sym: "CSCO", name: "Cisco", sector: "Technology" },
  { id: "stock:us:IBM", sym: "IBM", name: "IBM", sector: "Technology" },
  { id: "stock:us:NFLX", sym: "NFLX", name: "Netflix", sector: "Technology" },
  { id: "stock:us:AMZN", sym: "AMZN", name: "Amazon", sector: "Consumer" },
  { id: "stock:us:TSLA", sym: "TSLA", name: "Tesla", sector: "Consumer" },
  { id: "stock:us:WMT", sym: "WMT", name: "Walmart", sector: "Consumer" },
  { id: "stock:us:HD", sym: "HD", name: "Home Depot", sector: "Consumer" },
  { id: "stock:us:MCD", sym: "MCD", name: "McDonald's", sector: "Consumer" },
  { id: "stock:us:NKE", sym: "NKE", name: "Nike", sector: "Consumer" },
  { id: "stock:us:SBUX", sym: "SBUX", name: "Starbucks", sector: "Consumer" },
  { id: "stock:us:COST", sym: "COST", name: "Costco", sector: "Consumer" },
  { id: "stock:us:DIS", sym: "DIS", name: "Walt Disney", sector: "Consumer" },
  { id: "stock:us:LOW", sym: "LOW", name: "Lowe's", sector: "Consumer" },
  { id: "stock:us:TGT", sym: "TGT", name: "Target", sector: "Consumer" },
  { id: "stock:us:BRK-B", sym: "BRK-B", name: "Berkshire Hathaway", sector: "Finance" },
  { id: "stock:us:JPM", sym: "JPM", name: "JPMorgan Chase", sector: "Finance" },
  { id: "stock:us:V", sym: "V", name: "Visa", sector: "Finance" },
  { id: "stock:us:MA", sym: "MA", name: "Mastercard", sector: "Finance" },
  { id: "stock:us:BAC", sym: "BAC", name: "Bank of America", sector: "Finance" },
  { id: "stock:us:GS", sym: "GS", name: "Goldman Sachs", sector: "Finance" },
  { id: "stock:us:MS", sym: "MS", name: "Morgan Stanley", sector: "Finance" },
  { id: "stock:us:AXP", sym: "AXP", name: "American Express", sector: "Finance" },
  { id: "stock:us:C", sym: "C", name: "Citigroup", sector: "Finance" },
  { id: "stock:us:PYPL", sym: "PYPL", name: "PayPal", sector: "Finance" },
  { id: "stock:us:UNH", sym: "UNH", name: "UnitedHealth Group", sector: "Healthcare" },
  { id: "stock:us:LLY", sym: "LLY", name: "Eli Lilly", sector: "Healthcare" },
  { id: "stock:us:JNJ", sym: "JNJ", name: "Johnson & Johnson", sector: "Healthcare" },
  { id: "stock:us:ABBV", sym: "ABBV", name: "AbbVie", sector: "Healthcare" },
  { id: "stock:us:MRK", sym: "MRK", name: "Merck", sector: "Healthcare" },
  { id: "stock:us:TMO", sym: "TMO", name: "Thermo Fisher", sector: "Healthcare" },
  { id: "stock:us:PFE", sym: "PFE", name: "Pfizer", sector: "Healthcare" },
  { id: "stock:us:ABT", sym: "ABT", name: "Abbott Labs", sector: "Healthcare" },
  { id: "stock:us:BMY", sym: "BMY", name: "Bristol-Myers Squibb", sector: "Healthcare" },
  { id: "stock:us:PG", sym: "PG", name: "Procter & Gamble", sector: "Consumer" },
  { id: "stock:us:KO", sym: "KO", name: "Coca-Cola", sector: "Consumer" },
  { id: "stock:us:PEP", sym: "PEP", name: "PepsiCo", sector: "Consumer" },
  { id: "stock:us:XOM", sym: "XOM", name: "ExxonMobil", sector: "Energy" },
  { id: "stock:us:CVX", sym: "CVX", name: "Chevron", sector: "Energy" },
  { id: "stock:us:BA", sym: "BA", name: "Boeing", sector: "Industrials" },
  { id: "stock:us:CAT", sym: "CAT", name: "Caterpillar", sector: "Industrials" },
  { id: "stock:us:HON", sym: "HON", name: "Honeywell", sector: "Industrials" },
  { id: "stock:us:GE", sym: "GE", name: "GE Aerospace", sector: "Industrials" },
  { id: "stock:us:F", sym: "F", name: "Ford Motor", sector: "Industrials" },
  { id: "stock:us:GM", sym: "GM", name: "General Motors", sector: "Industrials" },
  { id: "stock:us:T", sym: "T", name: "AT&T", sector: "Telecom" },
  { id: "stock:us:VZ", sym: "VZ", name: "Verizon", sector: "Telecom" },
];

/* ── TradingView display symbols ─────────────────────────────────────────────
 * The platform's own quotes stay fail-closed: no licensed provider, no price in
 * the product's data layer. Where TradingView publishes a page for an instrument,
 * the UI may additionally show TradingView's own widget. That widget renders
 * inside TradingView's frame with its attribution and its own latency, so the
 * value never becomes a platform quote and nothing is redistributed by us.
 * Only symbols whose public TradingView page was verified are listed; anything
 * else stays explicitly unavailable instead of pointing at a symbol TradingView
 * would render as invalid. */
export type TvSymbol = { s: string; d: string };

/* Verified 404 on TradingView: no page exists, so no widget is offered. */
const EGX_WITHOUT_TV = new Set([
  "ABCB", "ACDP", "AIBC", "AMCO", "ARPH", "ARCO", "BMWO", "EDBE", "ESRS",
  "HELB", "GGHE", "IDKO", "KAHA", "MTEL", "OTLQ", "SFAP", "SCOM",
]);
/* Verified as NYSE listings (the remaining US entries are Nasdaq). */
const US_NYSE = new Set([
  "ABT", "ABBV", "BA", "BAC", "AXP", "BMY", "C", "CAT", "CVX", "CRM", "F",
  "DIS", "GS", "GM", "HD", "GE", "IBM", "JNJ", "KO", "JPM", "MCD", "LOW",
  "MA", "MRK", "LLY", "MS", "NKE", "ORCL", "PG", "PFE", "TGT", "T", "TMO",
  "UNH", "V", "XOM", "VZ",
]);
const INSTRUMENT_TV: Record<string, string> = {
  /* EGX70/EGX100 have no TradingView page, so they stay unavailable. */
  "egx:EGX30": "EGX:EGX30",
  "index:SPX": "SP:SPX",
  "index:NASDAQ": "NASDAQ:IXIC",
  "index:DAX": "XETR:DAX",
  "index:FTSE100": "TVC:UKX",
  "commodity:XAU": "TVC:GOLD",
  "commodity:BRENT": "TVC:UKOIL",
  "commodity:XAG": "TVC:SILVER",
  "commodity:COPPER": "COMEX:HG1!",
  "crypto:BTC": "BINANCE:BTCUSDT",
  "crypto:ETH": "BINANCE:ETHUSDT",
  "crypto:SOL": "BINANCE:SOLUSDT",
  "crypto:XRP": "BINANCE:XRPUSDT",
};

export function tvSymbolForInstrument(id: string): string | null {
  const known = INSTRUMENT_TV[id];
  if (known) return known;
  if (id.startsWith("stock:egx:")) {
    const sym = id.slice("stock:egx:".length);
    return EGX_WITHOUT_TV.has(sym) ? null : `EGX:${sym}`;
  }
  if (id.startsWith("stock:us:")) {
    const sym = id.slice("stock:us:".length);
    /* BRK-B has no matching page under either exchange slug. */
    if (sym === "BRK-B") return null;
    return `${US_NYSE.has(sym) ? "NYSE" : "NASDAQ"}:${sym}`;
  }
  return null;
}


