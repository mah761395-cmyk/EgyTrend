import { escapeHtml, sendMail } from "../mailer";
import { safeUpstreamErrorSummary } from "./http";
import type { JsonCache } from "./cache";
import type { ProviderDescriptor, ProviderHealth } from "./types";

const HEALTH_PREFIX = "egytrend:market:health:v1:";
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export type StoredProviderHealth = {
  lastSuccessAt?: number;
  lastFailureAt?: number;
  consecutiveFailures: number;
  alertedAt?: number;
};

/**
 * Stores provider health in the same Redis/memory cache layer. The monitor
 * never includes API keys, request URLs or user data in state or notifications.
 */
export class ProviderHealthMonitor {
  constructor(
    private readonly cache: JsonCache,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private key(id: string): string {
    return `${HEALTH_PREFIX}${id}`;
  }

  private async read(id: string): Promise<StoredProviderHealth> {
    const entry = await this.cache.get<StoredProviderHealth>(this.key(id));
    return entry?.value ?? { consecutiveFailures: 0 };
  }

  private async write(id: string, value: StoredProviderHealth): Promise<void> {
    const now = this.now();
    await this.cache.set(this.key(id), {
      value,
      cachedAt: now,
      // Health history should survive normal quote cache expiry but not live forever.
      expiresAt: now + 24 * 60 * 60 * 1000,
      staleUntil: now + 7 * 24 * 60 * 60 * 1000,
    });
  }

  async recordSuccess(providerId: string): Promise<void> {
    const current = await this.read(providerId);
    await this.write(providerId, {
      ...current,
      lastSuccessAt: this.now(),
      consecutiveFailures: 0,
    });
  }

  async recordFailure(provider: ProviderDescriptor, error: unknown): Promise<void> {
    if (provider.state !== "configured") return;
    const now = this.now();
    const current = await this.read(provider.id);
    const next: StoredProviderHealth = {
      ...current,
      lastFailureAt: now,
      consecutiveFailures: current.consecutiveFailures + 1,
    };

    const lastGood = current.lastSuccessAt ?? 0;
    const downForMs = lastGood ? now - lastGood : 0;
    const shouldAlert =
      Boolean(lastGood) &&
      downForMs >= 15 * 60 * 1000 &&
      (!current.alertedAt || now - current.alertedAt >= ALERT_COOLDOWN_MS);

    if (shouldAlert) {
      next.alertedAt = now;
      await maybeSendProviderAlert(provider, downForMs, error);
    }
    await this.write(provider.id, next);
  }

  async status(descriptors: ProviderDescriptor[]): Promise<ProviderHealth[]> {
    const now = this.now();
    return Promise.all(descriptors.map(async (descriptor) => {
      const current = await this.read(descriptor.id);
      const lastGood = current.lastSuccessAt ?? 0;
      const degraded = descriptor.state === "configured" && Boolean(lastGood) && now - lastGood >= 15 * 60 * 1000;
      return {
        providerId: descriptor.id,
        state: descriptor.state,
        lastSuccessAt: current.lastSuccessAt,
        lastFailureAt: current.lastFailureAt,
        consecutiveFailures: current.consecutiveFailures,
        degraded,
      };
    }));
  }
}

async function maybeSendProviderAlert(
  provider: ProviderDescriptor,
  downForMs: number,
  error: unknown,
): Promise<void> {
  // Preview/local environments must not mail arbitrary people. Production mail
  // additionally requires a deliberate opt-in and an owner-controlled address.
  if (process.env.NODE_ENV !== "production") return;
  if (process.env["DATA_SOURCE_ALERTS_ENABLED"] !== "true") return;
  const to = (process.env["DATA_ALERT_EMAIL"] || "").trim();
  if (!to) return;

  const minutes = Math.floor(downForMs / 60_000);
  // A raw fetch error may include a provider URL containing a query API key.
  // The safe summary intentionally contains no URL or vendor response body.
  const reason = safeUpstreamErrorSummary(error);
  await sendMail(
    to,
    `EgyTrend: مصدر بيانات متعطل لأكثر من 15 دقيقة (${provider.name})`,
    `<p dir="rtl">مصدر <strong>${escapeHtml(provider.name)}</strong> لم ينجح منذ نحو ${minutes} دقيقة.</p>` +
      `<p dir="rtl">السبب المختصر: ${escapeHtml(reason)}</p>` +
      `<p dir="rtl">راجِع <code>/api/markets/health</code>؛ لا تحتوي الرسالة على مفاتيح أو بيانات مستخدمين.</p>`,
  );
}
