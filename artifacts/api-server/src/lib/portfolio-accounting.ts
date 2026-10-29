/**
 * Minimal quote shape (structural, so this module stays dependency-free and
 * can be unit-tested without the market-data layer). Matches the `price` /
 * `source` fields of the StockQuote type in routes/markets.ts.
 */
export type QuoteLike = { price?: number; source?: string };

/**
 * Pure portfolio accounting — the single source of truth for portfolio math.
 *
 * Every buy/sell trade a user records is a ledger row. Positions, average
 * cost, realized P/L, cash and portfolio value are DERIVED here, never typed
 * or stored, so multiple buys/sells of the same symbol stay consistent.
 *
 * Cost-basis rule (moving average, the standard retail-broker convention):
 *   buy:  avgCost = (held·avg + q·price + fees) / (held + q)
 *   sell: realizedPnl += q·price − fees − q·avgCost;  avgCost unchanged
 * Selling more than held is reported as `errors` (the route rejects such a
 * write) and the sell is clamped to held so the remaining timeline still
 * computes for display.
 *
 * The functions are pure (no DB, no clock, no provider) and fully covered by
 * portfolio-accounting.test.ts.
 */

export type TradeSide = "buy" | "sell";

export type PortfolioTxInput = {
  id: string;
  symbol: string;
  side: TradeSide;
  /** Positive integer number of shares. */
  quantity: number;
  /** Price per share in EGP (> 0). */
  price: number;
  /** Commission/fees for this trade in EGP (>= 0). */
  fees: number;
  /** YYYY-MM-DD (Cairo calendar date the trade happened). */
  tradeDate: string;
  /** Stable tie-break for same-day trades (epoch ms of creation). */
  createdAtMs: number;
};

export type SymbolLedger = {
  symbol: string;
  /** Shares currently held (0 = fully sold / never bought). */
  quantity: number;
  /** Average cost per held share in EGP, fees included. 0 when none held. */
  averageCost: number;
  /** quantity × averageCost. */
  costBasis: number;
  /** Net realized profit/loss from closed sells (fees deducted). */
  realizedPnl: number;
  totalFees: number;
  buyCount: number;
  sellCount: number;
  /** Σ qty·price of buys (fees excluded). */
  totalBuyValue: number;
  /** Σ qty·price of sells (fees excluded). */
  totalSellValue: number;
  firstTradeAtMs: number;
  lastTradeAtMs: number;
};

export type TradeEvent = {
  txId: string;
  symbol: string;
  side: TradeSide;
  tradeDate: string;
  quantity: number;
  price: number;
  fees: number;
  /** Net P/L of this sell (fees deducted). Null for buys. */
  realizedPnl: number | null;
  heldAfter: number;
  averageCostAfter: number;
  cashAfter: number;
  /** True when this sell was clamped (requested more than held). */
  clamped: boolean;
};

export type SellExceedsHeld = {
  txId: string;
  code: "sell_exceeds_held";
  symbol: string;
  tradeDate: string;
  held: number;
  requested: number;
};

export type PortfolioComputation = {
  bySymbol: Map<string, SymbolLedger>;
  /** Symbols in first-trade order (stable display order). */
  symbolOrder: string[];
  /** startingCash + Σ sell proceeds − Σ buy outlays (fees included). */
  cash: number;
  /** Σ cost basis of currently held shares. */
  investedCost: number;
  realizedPnl: number;
  totalFees: number;
  buyCount: number;
  sellCount: number;
  events: TradeEvent[];
  /** Non-empty when the ledger itself is inconsistent (invalid sell). */
  errors: SellExceedsHeld[];
};

export function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function computePortfolio(
  transactions: readonly PortfolioTxInput[],
  startingCash = 0,
): PortfolioComputation {
  const ordered = [...transactions].sort(
    (a, b) =>
      a.tradeDate.localeCompare(b.tradeDate) ||
      a.createdAtMs - b.createdAtMs ||
      a.id.localeCompare(b.id),
  );

  const bySymbol = new Map<string, SymbolLedger>();
  const symbolOrder: string[] = [];
  const events: TradeEvent[] = [];
  const errors: SellExceedsHeld[] = [];
  let cash = Number.isFinite(startingCash) ? startingCash : 0;
  let realizedPnl = 0;
  let totalFees = 0;
  let buyCount = 0;
  let sellCount = 0;

  for (const tx of ordered) {
    const quantity = Math.trunc(tx.quantity);
    const price = Number(tx.price);
    const fees = Number(tx.fees) >= 0 ? Number(tx.fees) : 0;
    if (quantity <= 0 || !Number.isFinite(price) || price <= 0) continue;

    let ledger = bySymbol.get(tx.symbol);
    if (!ledger) {
      ledger = {
        symbol: tx.symbol,
        quantity: 0,
        averageCost: 0,
        costBasis: 0,
        realizedPnl: 0,
        totalFees: 0,
        buyCount: 0,
        sellCount: 0,
        totalBuyValue: 0,
        totalSellValue: 0,
        firstTradeAtMs: tx.createdAtMs,
        lastTradeAtMs: tx.createdAtMs,
      };
      bySymbol.set(tx.symbol, ledger);
      symbolOrder.push(tx.symbol);
    }
    ledger.lastTradeAtMs = Math.max(ledger.lastTradeAtMs, tx.createdAtMs);
    cash = round6(cash);
    let clamped = false;
    let realizedPnlOfTrade: number | null = null;

    if (tx.side === "buy") {
      const outlay = round6(quantity * price + fees);
      cash = round6(cash - outlay);
      const newQty = ledger.quantity + quantity;
      ledger.averageCost = round6((ledger.quantity * ledger.averageCost + quantity * price + fees) / newQty);
      ledger.quantity = newQty;
      buyCount += 1;
      ledger.buyCount += 1;
      ledger.totalBuyValue = round6(ledger.totalBuyValue + quantity * price);
    } else {
      const sold = Math.min(quantity, ledger.quantity);
      clamped = sold < quantity;
      if (clamped) {
        errors.push({
          txId: tx.id,
          code: "sell_exceeds_held",
          symbol: tx.symbol,
          tradeDate: tx.tradeDate,
          held: ledger.quantity,
          requested: quantity,
        });
      }
      const costBasis = round6(sold * ledger.averageCost);
      const proceeds = round6(sold * price - fees);
      realizedPnlOfTrade = round6(proceeds - costBasis);
      ledger.realizedPnl = round6(ledger.realizedPnl + realizedPnlOfTrade);
      ledger.quantity -= sold;
      if (ledger.quantity === 0) ledger.averageCost = 0;
      sellCount += 1;
      ledger.sellCount += 1;
      ledger.totalSellValue = round6(ledger.totalSellValue + sold * price);
      cash = round6(cash + proceeds);
    }

    ledger.totalFees = round6(ledger.totalFees + fees);
    totalFees = round6(totalFees + fees);
    realizedPnl = round6(realizedPnl + (realizedPnlOfTrade ?? 0));
    ledger.costBasis = round6(ledger.quantity * ledger.averageCost);
    cash = round6(cash);

    events.push({
      txId: tx.id,
      symbol: tx.symbol,
      side: tx.side,
      tradeDate: tx.tradeDate,
      quantity,
      price,
      fees,
      realizedPnl: realizedPnlOfTrade,
      heldAfter: ledger.quantity,
      averageCostAfter: ledger.averageCost,
      cashAfter: cash,
      clamped,
    });
  }

  let investedCost = 0;
  for (const ledger of bySymbol.values()) {
    investedCost = round6(investedCost + ledger.costBasis);
  }

  return { bySymbol, symbolOrder, cash, investedCost, realizedPnl, totalFees, buyCount, sellCount, events, errors };
}

export type SymbolMarketEntry = {
  marketPrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
  /** % of total portfolio value (null when totalValue is null or 0). */
  weightPct: number | null;
};

export type MarketAttachment = {
  /** Sum over priced held positions (always finite). */
  pricedMarketValue: number;
  /** Null when some held position lacks a verified price. */
  marketValue: number | null;
  missingSymbols: string[];
  /** cash + pricedMarketValue (partial view for display). */
  totalValuePriced: number;
  /** cash + marketValue; null when some held position lacks a price. */
  totalValue: number | null;
  /** Sum of unrealized P/L over priced held positions. */
  unrealizedPnlPriced: number;
  /** Null when some held position lacks a price. */
  unrealizedPnl: number | null;
  perSymbol: Map<string, SymbolMarketEntry>;
  /** Largest single-symbol weight in % of totalValue; null when not evaluable. */
  topConcentrationPct: number | null;
};

/**
 * Attach live market data to a computation. A verified price means: a finite
 * price with a named source (what `quoteEligibleForAlert` also requires).
 * Missing prices are reported explicitly — never filled with stale/fake data.
 */
export function attachMarketValue(
  computation: PortfolioComputation,
  quotes: ReadonlyMap<string, QuoteLike | null | undefined>,
  extraHeld?: ReadonlyMap<string, { quantity: number; averageCost: number }>,
): MarketAttachment {
  const perSymbol = new Map<string, SymbolMarketEntry>();
  let pricedMarketValue = 0;
  let missingSymbols: string[] = [];
  let allPriced = true;
  let unrealizedPnlPriced = 0;

  const heldSymbols: Array<{ symbol: string; quantity: number; averageCost: number }> = [];
  for (const [symbol, ledger] of computation.bySymbol) {
    if (ledger.quantity > 0) heldSymbols.push({ symbol, quantity: ledger.quantity, averageCost: ledger.averageCost });
  }
  if (extraHeld) {
    for (const [symbol, held] of extraHeld) {
      if (!computation.bySymbol.has(symbol) && held.quantity > 0) {
        heldSymbols.push({ symbol, quantity: held.quantity, averageCost: held.averageCost });
      }
    }
  }

  for (const held of heldSymbols) {
    const point = quotes.get(held.symbol);
    const price = quoteVerified(point) ? point.price : null;
    if (price === null) {
      missingSymbols.push(held.symbol);
      allPriced = false;
      perSymbol.set(held.symbol, { marketPrice: null, marketValue: null, unrealizedPnl: null, unrealizedPnlPct: null, weightPct: null });
      continue;
    }
    const marketValue = round6(held.quantity * price);
    const unrealized = round6((price - held.averageCost) * held.quantity);
    pricedMarketValue = round6(pricedMarketValue + marketValue);
    unrealizedPnlPriced = round6(unrealizedPnlPriced + unrealized);
    perSymbol.set(held.symbol, {
      marketPrice: price,
      marketValue,
      unrealizedPnl: unrealized,
      unrealizedPnlPct: held.averageCost > 0 ? round6(((price - held.averageCost) / held.averageCost) * 100) : null,
      weightPct: null, // filled after totalValue is known
    });
  }

  const totalValue: number | null = allPriced ? round6(computation.cash + pricedMarketValue) : null;
  /* Weights are only meaningful when the total is a sane asset base
   * (declared cash may be negative if the user under-declared it; then a
   * position would "weigh" more than 100%, which would mislead). */
  const weightsValid = totalValue !== null && totalValue > 0 && totalValue >= pricedMarketValue;
  if (weightsValid) {
    for (const [symbol, entry] of perSymbol) {
      if (entry.marketValue !== null) entry.weightPct = round6((entry.marketValue / totalValue) * 100);
    }
  }

  let topConcentrationPct: number | null = null;
  if (weightsValid) {
    topConcentrationPct = 0;
    for (const entry of perSymbol.values()) {
      if (entry.weightPct !== null && entry.weightPct > topConcentrationPct) topConcentrationPct = entry.weightPct;
    }
  }

  return {
    pricedMarketValue,
    marketValue: allPriced ? pricedMarketValue : null,
    missingSymbols,
    totalValuePriced: round6(computation.cash + pricedMarketValue),
    totalValue,
    unrealizedPnlPriced,
    unrealizedPnl: allPriced ? unrealizedPnlPriced : null,
    perSymbol,
    topConcentrationPct,
  };
}

/** Quote eligibility reused by alerts: finite positive price + named source. */
export function quoteVerified(quote: QuoteLike | null | undefined): quote is QuoteLike & { price: number; source: string } {
  if (!quote) return false;
  const { price, source } = quote;
  return typeof price === "number" && Number.isFinite(price) && price > 0 && typeof source === "string" && source.trim().length > 0;
}
