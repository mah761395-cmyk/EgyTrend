/* Shared design system: one source of truth for tokens + ui primitives,
 * loaded by BOTH entries (index + admin) at page start. (Imported from JS,
 * not <link>: Vite 7 drops shared linked CSS when multiple HTML entries
 * reference the same file.) */
import "../tokens.css";
import "../ui.css";

export {};

/*
 * A deliberately tiny bridge between the legacy inline UI and Lightweight
 * Charts. Importing this module does NOT load the chart renderer: the package
 * is dynamically imported only when a user opens an asset detail overlay.
 *
 * Data arrives from /api/markets/history only. This renderer knows nothing
 * about market-data vendors, API keys or browser-side feeds.
 */

type ChartPoint = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

type IndicatorPoint = { time: string; value: number };

type MountOptions = {
  host: HTMLElement;
  rsiHost?: HTMLElement | null;
  points: ChartPoint[];
  movingAverage20?: IndicatorPoint[];
  rsi14?: IndicatorPoint[];
  mode?: "candles" | "line";
  onHover?: (point: ChartPoint | null) => void;
  onVolumeAvailability?: (available: boolean) => void;
};

type ChartController = {
  setMode: (mode: "candles" | "line") => void;
  setIndicators: (indicators: { movingAverage20?: IndicatorPoint[]; rsi14?: IndicatorPoint[] }) => void;
  destroy: () => void;
};

type ChartBridge = { mount: (options: MountOptions) => Promise<ChartController> };

declare global {
  interface Window {
    EgyTrendCharts?: ChartBridge;
  }
}

const validPrice = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

function usablePoints(points: ChartPoint[]): ChartPoint[] {
  const dates = new Set<string>();
  return points.filter((point) => {
    if (!point || !/^\d{4}-\d{2}-\d{2}$/.test(String(point.time))) return false;
    if (![point.open, point.high, point.low, point.close].every(validPrice)) return false;
    if (point.high < Math.max(point.open, point.close) || point.low > Math.min(point.open, point.close)) return false;
    if (dates.has(point.time)) return false;
    dates.add(point.time);
    return true;
  });
}

/** The import is intentionally here, rather than at module scope, for a true lazy chunk. */
async function mount(options: MountOptions): Promise<ChartController> {
  const points = usablePoints(options.points);
  if (points.length < 2) throw new Error("insufficient_history");

  const lib = await import("lightweight-charts");
  const { createChart, ColorType, CandlestickSeries, LineSeries, HistogramSeries } = lib;
  const background = "#07140f";
  const common = {
    layout: { background: { type: ColorType.Solid, color: background }, textColor: "#9ab5a7", fontFamily: "IBM Plex Sans Arabic, Arial, sans-serif" },
    grid: { vertLines: { color: "rgba(144, 182, 159, .08)" }, horzLines: { color: "rgba(144, 182, 159, .08)" } },
    rightPriceScale: { borderColor: "rgba(144, 182, 159, .18)" },
    timeScale: { borderColor: "rgba(144, 182, 159, .18)", timeVisible: false },
    localization: { locale: "ar-EG" },
  } as const;
  const width = Math.max(240, options.host.clientWidth || 320);
  const mainChart = createChart(options.host, { ...common, width, height: 278, handleScroll: true, handleScale: true });

  const candleSeries = mainChart.addSeries(CandlestickSeries, {
    upColor: "#10b981", downColor: "#f05252", borderUpColor: "#10b981", borderDownColor: "#f05252",
    wickUpColor: "#36d399", wickDownColor: "#fb7185",
  });
  const lineSeries = mainChart.addSeries(LineSeries, { color: "#34d399", lineWidth: 2, crosshairMarkerVisible: true });
  const maSeries = mainChart.addSeries(LineSeries, { color: "#fbbf24", lineWidth: 2, crosshairMarkerVisible: false, visible: false });
  candleSeries.setData(points.map((point) => ({ time: point.time, open: point.open, high: point.high, low: point.low, close: point.close })));
  lineSeries.setData(points.map((point) => ({ time: point.time, value: point.close })));

  // A zero volume bar would be invented where a provider omitted the field.
  // Render volume only if every visible bar actually carries that field.
  const hasCompleteVolume = points.every((point) => typeof point.volume === "number" && Number.isFinite(point.volume) && point.volume >= 0);
  options.onVolumeAvailability?.(hasCompleteVolume);
  if (hasCompleteVolume) {
    const volumeSeries = mainChart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" }, priceScaleId: "volume", lastValueVisible: false, priceLineVisible: false,
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.76, bottom: 0 } });
    volumeSeries.setData(points.map((point) => ({
      time: point.time,
      value: point.volume!,
      color: point.close >= point.open ? "rgba(16,185,129,.42)" : "rgba(240,82,82,.42)",
    })));
    candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.29 } });
    lineSeries.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.29 } });
    maSeries.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.29 } });
  }

  let rsiChart: ReturnType<typeof createChart> | null = null;
  let rsiSeries: ReturnType<typeof mainChart.addSeries> | null = null;
  const setIndicators = (indicators: { movingAverage20?: IndicatorPoint[]; rsi14?: IndicatorPoint[] }) => {
    const ma = (indicators.movingAverage20 || []).filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(String(point.time)) && Number.isFinite(point.value));
    maSeries.setData(ma.map((point) => ({ time: point.time, value: point.value })));
    maSeries.applyOptions({ visible: ma.length > 0 });

    const rsi = (indicators.rsi14 || []).filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(String(point.time)) && Number.isFinite(point.value) && point.value >= 0 && point.value <= 100);
    if (!options.rsiHost) return;
    options.rsiHost.hidden = rsi.length === 0;
    if (!rsi.length) return;
    if (!rsiChart) {
      rsiChart = createChart(options.rsiHost, { ...common, width: Math.max(240, options.rsiHost.clientWidth || width), height: 130, timeScale: { ...common.timeScale, visible: false } });
      rsiSeries = rsiChart.addSeries(LineSeries, { color: "#a78bfa", lineWidth: 2, crosshairMarkerVisible: false });
      rsiChart.priceScale("right").applyOptions({ autoScale: false, scaleMargins: { top: 0.12, bottom: 0.12 } });
    }
    rsiSeries?.setData(rsi.map((point) => ({ time: point.time, value: point.value })));
    rsiChart.timeScale().fitContent();
  };

  const setMode = (mode: "candles" | "line") => {
    candleSeries.applyOptions({ visible: mode === "candles" });
    lineSeries.applyOptions({ visible: mode === "line" });
  };
  setMode(options.mode || "candles");
  setIndicators({ movingAverage20: options.movingAverage20, rsi14: options.rsi14 });
  mainChart.timeScale().fitContent();

  const byTime = new Map(points.map((point) => [point.time, point]));
  mainChart.subscribeCrosshairMove((param) => {
    const time = typeof param.time === "string" ? param.time : "";
    options.onHover?.(byTime.get(time) || null);
  });

  const resize = () => {
    const nextWidth = Math.max(240, options.host.clientWidth || width);
    mainChart.applyOptions({ width: nextWidth });
    if (rsiChart && options.rsiHost) rsiChart.applyOptions({ width: Math.max(240, options.rsiHost.clientWidth || nextWidth) });
  };
  // ResizeObserver is widespread but the fallback keeps the free basic chart
  // usable on older/lower-end mobile browsers too.
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
  if (observer) observer.observe(options.host);
  else window.addEventListener("resize", resize, { passive: true });

  return {
    setMode,
    setIndicators,
    destroy() {
      observer?.disconnect();
      if (!observer) window.removeEventListener("resize", resize);
      mainChart.remove();
      rsiChart?.remove();
    },
  };
}

window.EgyTrendCharts = { mount };
