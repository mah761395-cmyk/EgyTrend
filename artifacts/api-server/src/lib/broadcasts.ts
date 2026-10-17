import crypto from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import {
  appUsersTable,
  broadcastMediaTable,
  broadcastMessagesTable,
  broadcastMessageUserStatesTable,
  broadcastTestDeliveriesTable,
  db,
  subscriptionPlansTable,
  type BroadcastAction,
  type BroadcastBlock,
  type BroadcastContent,
  type BroadcastInline,
} from "@workspace/db";
import { getEffectivePrice } from "./pricing";
import { type UserClaims, getVipEntitlement } from "./userAuth";
import { cairoCalendarDaysUntil } from "./subscription-time";

export const BROADCAST_TYPES = ["offer", "greeting", "new_feature", "maintenance", "important"] as const;
export const BROADCAST_AUDIENCES = ["all", "guests", "free", "vip", "expiring", "new_users"] as const;
export const BROADCAST_STATUSES = ["draft", "published", "paused", "archived"] as const;

export type BroadcastType = typeof BROADCAST_TYPES[number];
export type BroadcastAudience = typeof BROADCAST_AUDIENCES[number];
export type BroadcastStatus = typeof BROADCAST_STATUSES[number];

type BroadcastMessageRow = typeof broadcastMessagesTable.$inferSelect;
type BroadcastMediaRow = typeof broadcastMediaTable.$inferSelect;

const MAX_TITLE = 140;
const MAX_CONTENT = 5_000;
const MAX_BLOCKS = 24;
const MAX_LIST_ITEMS = 20;
const MAX_IMAGE_BYTES = 180_000;

export const BROADCAST_TEMPLATES = [
  {
    key: "eid_al_fitr",
    label: "تهنئة عيد الفطر",
    messageType: "greeting" as const,
    title: "عيد فطر مبارك 🌙",
    contentMarkdown: "كل سنة وأنتم طيبين يا {{name}}. فريق EgyTrend يتمنى لكم عيدًا سعيدًا.",
  },
  {
    key: "eid_al_adha",
    label: "تهنئة عيد الأضحى",
    messageType: "greeting" as const,
    title: "عيد أضحى مبارك 🐑",
    contentMarkdown: "كل سنة وأنتم طيبين يا {{name}}. نتمنى لكم أيامًا سعيدة وآمنة.",
  },
  {
    key: "ramadan",
    label: "تهنئة رمضان",
    messageType: "greeting" as const,
    title: "رمضان كريم 🌙",
    contentMarkdown: "رمضان كريم يا {{name}}. نتمنى لكم شهرًا مباركًا.",
  },
  {
    key: "new_year",
    label: "رأس السنة",
    messageType: "greeting" as const,
    title: "سنة جديدة سعيدة ✨",
    contentMarkdown: "سنة جديدة سعيدة يا {{name}}. شكرًا لوجودك مع EgyTrend.",
  },
  {
    key: "discount_offer",
    label: "عرض خصم",
    messageType: "offer" as const,
    title: "عرض على الاشتراك ✨",
    contentMarkdown: "السعر الحالي {{price}} بدلًا من {{old_price}}. نسبة الخصم: {{discount_percent}}.",
  },
  {
    key: "new_feature",
    label: "ميزة جديدة",
    messageType: "new_feature" as const,
    title: "ميزة جديدة وصلت 🚀",
    contentMarkdown: "أضفنا ميزة جديدة لتحسين تجربتك. افتح المنصة واكتشف التفاصيل.",
  },
  {
    key: "scheduled_maintenance",
    label: "صيانة مجدولة",
    messageType: "maintenance" as const,
    title: "صيانة مجدولة 🔧",
    contentMarkdown: "سيكون هناك تحديث تقني في الموعد الذي تحدده الإدارة. قد تتأثر بعض الخدمات مؤقتًا.",
  },
] as const;

export type BroadcastEffectiveState = "draft" | "scheduled" | "active" | "ended" | "paused" | "archived";

export type BroadcastDraftInput = {
  title: string;
  contentMarkdown: string;
  messageType: BroadcastType;
  audience: BroadcastAudience;
  priority: number;
  status: BroadcastStatus;
  startsAt: Date | null;
  endsAt: Date | null;
  imageMediaId: string | null;
  action: BroadcastAction;
  variablePlanKey: string | null;
  marketingEmailRequested?: boolean;
};

export type BroadcastPublicMessage = {
  id: string;
  title: string;
  content: BroadcastContent;
  messageType: BroadcastType;
  audience: BroadcastAudience;
  imageUrl: string | null;
  action: BroadcastAction;
  startsAt: string | null;
  endsAt: string | null;
  generatedAt: string;
  variableSource: "current_server_price" | "not_requested" | "unavailable";
};

function hasValue<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function plainText(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    /* Raw tags are stripped before any markdown parsing, so they can never be stored/rendered. */
    .replace(/<[^>]*>/g, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, max);
}

export function safeBroadcastUrl(value: unknown): string | null {
  const raw = String(value ?? "").trim().slice(0, 500);
  if (!raw) return null;
  if (raw.startsWith("/")) {
    return /^\/(?!\/)[a-zA-Z0-9_?=&%./#-]{1,500}$/.test(raw) ? raw : null;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function pushInlineText(out: BroadcastInline[], value: string, options: Omit<BroadcastInline, "text"> = {}): void {
  const text = plainText(value, 500);
  if (text) out.push({ text, ...options });
}

/**
 * Minimal markdown subset: **bold**, [label](https-or-local-link), bullets,
 * and numbered lists. Everything else is literal sanitized text.
 */
export function parseBroadcastMarkdown(value: unknown): BroadcastContent | null {
  const source = plainText(value, MAX_CONTENT);
  if (!source) return null;
  const lines = source.split("\n");
  const blocks: BroadcastBlock[] = [];
  const inline = (line: string): BroadcastInline[] => {
    const result: BroadcastInline[] = [];
    const token = /(\*\*([^*\n]{1,300})\*\*|\[([^\]\n]{1,300})\]\(([^)\n]{1,500})\))/g;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = token.exec(line)) !== null && result.length < 40) {
      pushInlineText(result, line.slice(cursor, match.index));
      if (match[2] !== undefined) {
        pushInlineText(result, match[2], { bold: true });
      } else {
        const href = safeBroadcastUrl(match[4]);
        /* An unsafe markdown URL remains non-clickable visible text. */
        pushInlineText(result, match[3] || match[0], href ? { link: href } : {});
      }
      cursor = match.index + match[0].length;
    }
    pushInlineText(result, line.slice(cursor));
    return result;
  };

  for (let i = 0; i < lines.length && blocks.length < MAX_BLOCKS;) {
    const line = lines[i]!.trim();
    if (!line) { i += 1; continue; }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    const ordered = /^\d{1,2}[.)]\s+(.+)$/.exec(line);
    if (bullet || ordered) {
      const orderedList = Boolean(ordered);
      const items: BroadcastInline[][] = [];
      while (i < lines.length && items.length < MAX_LIST_ITEMS) {
        const candidate = lines[i]!.trim();
        const matched = orderedList ? /^\d{1,2}[.)]\s+(.+)$/.exec(candidate) : /^[-*]\s+(.+)$/.exec(candidate);
        if (!matched) break;
        const parts = inline(matched[1] || "");
        if (parts.length) items.push(parts);
        i += 1;
      }
      if (items.length) blocks.push({ type: orderedList ? "ordered_list" : "bullet_list", items });
      continue;
    }
    const paragraph: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i]!.trim() && !/^[-*]\s+/.test(lines[i]!.trim()) && !/^\d{1,2}[.)]\s+/.test(lines[i]!.trim())) {
      paragraph.push(lines[i]!.trim());
      i += 1;
    }
    const inlines = inline(paragraph.join(" "));
    if (inlines.length) blocks.push({ type: "paragraph", inlines });
  }
  return blocks.length ? { version: 1, blocks } : null;
}

function validStoredContent(value: unknown): value is BroadcastContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const content = value as BroadcastContent;
  return content.version === 1 && Array.isArray(content.blocks) && content.blocks.length > 0;
}

/** Defense in depth for legacy/manual DB writes: output is reconstructed from
 * an allowlisted AST even though normal admin input was already parsed. */
function sanitizeStoredContent(value: unknown): BroadcastContent | null {
  if (!validStoredContent(value)) return null;
  const cleanInlines = (input: unknown): BroadcastInline[] => (Array.isArray(input) ? input : []).slice(0, 40).flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const candidate = raw as Record<string, unknown>;
    const text = plainText(candidate.text, 500);
    if (!text) return [];
    const link = candidate.link === undefined ? null : safeBroadcastUrl(candidate.link);
    return [{ text, ...(candidate.bold === true ? { bold: true } : {}), ...(link ? { link } : {}) }];
  });
  const blocks: BroadcastBlock[] = [];
  for (const raw of value.blocks.slice(0, MAX_BLOCKS)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const candidate = raw as Record<string, unknown>;
    if (candidate.type === "paragraph") {
      const inlines = cleanInlines(candidate.inlines);
      if (inlines.length) blocks.push({ type: "paragraph", inlines });
    } else if (candidate.type === "bullet_list" || candidate.type === "ordered_list") {
      const items = (Array.isArray(candidate.items) ? candidate.items : []).slice(0, MAX_LIST_ITEMS)
        .map((item) => cleanInlines(item)).filter((item) => item.length);
      if (items.length) blocks.push({ type: candidate.type, items });
    }
  }
  return blocks.length ? { version: 1, blocks } : null;
}

function normalizeAction(raw: unknown): { action: BroadcastAction; error?: string } {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const kind = String(input.kind || "none");
  if (kind === "none") return { action: { kind: "none" } };
  if (kind === "link") {
    const label = plainText(input.label, 40);
    const url = safeBroadcastUrl(input.url);
    if (!label || !url) return { action: { kind: "none" }, error: "زر الرسالة يحتاج نصًا ورابط https أو مسارًا داخليًا صالحًا." };
    return { action: { kind: "link", label, url } };
  }
  /* Payment requests still do not redeem coupons. Failing closed avoids a
   * broadcast promising a discount that cannot be applied. */
  if (kind === "coupon_copy" || kind === "coupon_apply") {
    return { action: { kind: "none" }, error: "الكوبونات غير متاحة في رسائل المدير قبل ربط redemption الفعلي بطلب الدفع." };
  }
  return { action: { kind: "none" }, error: "نوع زر الرسالة غير صالح." };
}

function parseDate(value: Date | null): Date | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? new Date(value) : null;
}

export function validateBroadcastDraft(input: unknown): { value?: BroadcastDraftInput; error?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "بيانات الرسالة غير صالحة." };
  const raw = input as Record<string, unknown>;
  const title = plainText(raw.title, MAX_TITLE);
  const content = parseBroadcastMarkdown(raw.contentMarkdown);
  const messageType = raw.messageType;
  const audience = raw.audience;
  const status = raw.status;
  const priority = Number(raw.priority ?? 0);
  if (title.length < 2 || !content) return { error: "أدخل عنوانًا ونصًا صالحين؛ HTML الخام لا يُقبل." };
  if (!hasValue(BROADCAST_TYPES, messageType) || !hasValue(BROADCAST_AUDIENCES, audience) || !hasValue(BROADCAST_STATUSES, status)) {
    return { error: "نوع الرسالة أو الجمهور أو الحالة غير صالح." };
  }
  if (!Number.isInteger(priority) || priority < -1000 || priority > 1000) return { error: "الأولوية يجب أن تكون رقمًا صحيحًا بين -1000 و1000." };
  const startsAt = raw.startsAt instanceof Date ? parseDate(raw.startsAt) : null;
  const endsAt = raw.endsAt instanceof Date ? parseDate(raw.endsAt) : null;
  if (status === "published" && !startsAt) return { error: "حدد وقت بداية بتوقيت القاهرة قبل نشر الرسالة." };
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) return { error: "وقت النهاية يجب أن يكون بعد وقت البداية." };
  const mediaId = raw.imageMediaId === null || raw.imageMediaId === undefined || raw.imageMediaId === ""
    ? null : String(raw.imageMediaId).trim();
  if (mediaId && !/^[a-zA-Z0-9_-]{8,100}$/.test(mediaId)) return { error: "معرف الصورة غير صالح." };
  const action = normalizeAction(raw.action);
  if (action.error) return { error: action.error };
  const variablePlanKey = raw.variablePlanKey === null || raw.variablePlanKey === undefined || raw.variablePlanKey === ""
    ? null : String(raw.variablePlanKey).trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  if (raw.variablePlanKey && !variablePlanKey) return { error: "مفتاح باقة المتغيرات غير صالح." };
  if (raw.marketingEmailRequested === true) {
    return { error: "الإرسال الجماعي بالبريد غير مفعّل: يلزم أولًا consent موثق وموافقة تشغيل منفصلة، ولا يمكن تأكيده الآن." };
  }
  return {
    value: {
      title,
      contentMarkdown: String(raw.contentMarkdown),
      messageType,
      audience,
      priority,
      status,
      startsAt,
      endsAt,
      imageMediaId: mediaId,
      action: action.action,
      variablePlanKey,
      marketingEmailRequested: false,
    },
  };
}

export function broadcastEffectiveState(message: Pick<BroadcastMessageRow, "status" | "startsAt" | "endsAt" | "archivedAt">, now = new Date()): BroadcastEffectiveState {
  if (message.status === "archived" || message.archivedAt) return "archived";
  if (message.status === "draft") return "draft";
  if (message.status === "paused") return "paused";
  if (message.startsAt && message.startsAt.getTime() > now.getTime()) return "scheduled";
  if (message.endsAt && message.endsAt.getTime() <= now.getTime()) return "ended";
  return "active";
}

function imageDimensions(mimeType: string, bytes: Buffer): { width: number; height: number } | null {
  if (mimeType === "image/png" && bytes.length >= 24) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mimeType === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++] || 0;
      /* Standalone JPEG markers have no two-byte segment length. */
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 1 >= bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      const sof = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
      if (sof && length >= 7) return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
      offset += length;
    }
    return null;
  }
  if (mimeType === "image/webp") {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const kind = bytes.subarray(offset, offset + 4).toString("ascii");
      const length = bytes.readUInt32LE(offset + 4);
      const data = offset + 8;
      if (data + length > bytes.length) return null;
      if (kind === "VP8X" && length >= 10) {
        return { width: 1 + bytes.readUIntLE(data + 4, 3), height: 1 + bytes.readUIntLE(data + 7, 3) };
      }
      if (kind === "VP8 " && length >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) {
        return { width: bytes.readUInt16LE(data + 6) & 0x3fff, height: bytes.readUInt16LE(data + 8) & 0x3fff };
      }
      if (kind === "VP8L" && length >= 5 && bytes[data] === 0x2f) {
        const b1 = bytes[data + 1] || 0, b2 = bytes[data + 2] || 0, b3 = bytes[data + 3] || 0, b4 = bytes[data + 4] || 0;
        return { width: 1 + (b1 | ((b2 & 0x3f) << 8)), height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)) };
      }
      offset = data + length + (length % 2);
    }
  }
  return null;
}

export function validateBroadcastImageDataUrl(value: unknown): { mimeType?: string; dataUrl?: string; sizeBytes?: number; error?: string } {
  const raw = String(value || "").trim();
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(raw);
  if (!match) return { error: "الصورة يجب أن تكون PNG أو JPG أو WebP بصيغة مرفوعة آمنة." };
  let bytes: Buffer;
  try { bytes = Buffer.from(match[2]!, "base64"); } catch { return { error: "تعذر قراءة الصورة." }; }
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return { error: "حجم الصورة يجب ألا يتجاوز 180 كيلوبايت." };
  const mimeType = match[1]!;
  const isPng = mimeType === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = mimeType === "image/jpeg" && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isWebp = mimeType === "image/webp" && bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!isPng && !isJpeg && !isWebp) return { error: "نوع ملف الصورة لا يطابق محتواه." };
  const dimensions = imageDimensions(mimeType, bytes);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 4096 || dimensions.height > 4096 || dimensions.width * dimensions.height > 12_000_000) {
    return { error: "أبعاد الصورة غير صالحة أو أكبر من الحد الآمن." };
  }
  return { mimeType, dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`, sizeBytes: bytes.length };
}

function messageId(): string { return `broadcast-${crypto.randomUUID()}`; }
function stateId(): string { return `broadcast-state-${crypto.randomUUID()}`; }

export async function createBroadcastMedia(input: { dataUrl: unknown; employeeId: number; now?: Date }): Promise<{ media?: BroadcastMediaRow; error?: string }> {
  const image = validateBroadcastImageDataUrl(input.dataUrl);
  if (!image.mimeType || !image.dataUrl || !image.sizeBytes) return { error: image.error || "صورة غير صالحة." };
  const now = input.now || new Date();
  const [media] = await db.insert(broadcastMediaTable).values({
    id: `broadcast-media-${crypto.randomUUID()}`,
    mimeType: image.mimeType,
    dataUrl: image.dataUrl,
    sizeBytes: image.sizeBytes,
    createdBy: input.employeeId,
    createdAt: now,
  }).returning();
  return { media };
}

async function mediaExists(mediaId: string | null): Promise<boolean> {
  if (!mediaId) return true;
  const [media] = await db.select({ id: broadcastMediaTable.id }).from(broadcastMediaTable)
    .where(and(eq(broadcastMediaTable.id, mediaId), isNull(broadcastMediaTable.archivedAt))).limit(1);
  return Boolean(media);
}

export async function createBroadcast(input: BroadcastDraftInput, employeeId: number, now = new Date()): Promise<{ message?: BroadcastMessageRow; error?: string }> {
  const content = parseBroadcastMarkdown(input.contentMarkdown);
  if (!content) return { error: "نص الرسالة غير صالح." };
  if (!(await mediaExists(input.imageMediaId))) return { error: "الصورة المختارة لم تعد متاحة." };
  const [message] = await db.insert(broadcastMessagesTable).values({
    id: messageId(),
    title: input.title,
    content,
    messageType: input.messageType,
    audience: input.audience,
    priority: input.priority,
    status: input.status,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    imageMediaId: input.imageMediaId,
    action: input.action,
    variablePlanKey: input.variablePlanKey,
    marketingEmailRequested: false,
    createdBy: employeeId,
    updatedBy: employeeId,
    createdAt: now,
    updatedAt: now,
  }).returning();
  return { message };
}

export async function updateBroadcast(id: string, input: BroadcastDraftInput, employeeId: number, now = new Date()): Promise<{ message?: BroadcastMessageRow; error?: string }> {
  const content = parseBroadcastMarkdown(input.contentMarkdown);
  if (!content) return { error: "نص الرسالة غير صالح." };
  if (!(await mediaExists(input.imageMediaId))) return { error: "الصورة المختارة لم تعد متاحة." };
  const updated = await db.update(broadcastMessagesTable).set({
    title: input.title,
    content,
    messageType: input.messageType,
    audience: input.audience,
    priority: input.priority,
    status: input.status,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    imageMediaId: input.imageMediaId,
    action: input.action,
    variablePlanKey: input.variablePlanKey,
    marketingEmailRequested: false,
    marketingEmailConfirmedAt: null,
    updatedBy: employeeId,
    updatedAt: now,
    archivedAt: input.status === "archived" ? now : null,
  }).where(eq(broadcastMessagesTable.id, id)).returning();
  return updated.length ? { message: updated[0] } : { error: "الرسالة غير موجودة." };
}

export async function pauseBroadcast(id: string, employeeId: number, now = new Date()): Promise<BroadcastMessageRow | null> {
  const rows = await db.update(broadcastMessagesTable).set({ status: "paused", updatedBy: employeeId, updatedAt: now })
    .where(eq(broadcastMessagesTable.id, id)).returning();
  return rows[0] || null;
}

export async function archiveBroadcast(id: string, employeeId: number, now = new Date()): Promise<BroadcastMessageRow | null> {
  const rows = await db.update(broadcastMessagesTable).set({ status: "archived", archivedAt: now, updatedBy: employeeId, updatedAt: now })
    .where(eq(broadcastMessagesTable.id, id)).returning();
  return rows[0] || null;
}

export async function duplicateBroadcast(id: string, employeeId: number, now = new Date()): Promise<BroadcastMessageRow | null> {
  const [source] = await db.select().from(broadcastMessagesTable).where(eq(broadcastMessagesTable.id, id)).limit(1);
  if (!source) return null;
  const [copy] = await db.insert(broadcastMessagesTable).values({
    id: messageId(),
    title: `${source.title} — نسخة`.slice(0, MAX_TITLE),
    content: source.content,
    messageType: source.messageType,
    audience: source.audience,
    priority: source.priority,
    status: "draft",
    startsAt: null,
    endsAt: null,
    imageMediaId: source.imageMediaId,
    action: source.action,
    variablePlanKey: source.variablePlanKey,
    marketingEmailRequested: false,
    createdBy: employeeId,
    updatedBy: employeeId,
    createdAt: now,
    updatedAt: now,
  }).returning();
  return copy || null;
}

type ViewerContext = {
  claims: UserClaims | null;
  user: { id: number; name: string; createdAt: Date; marketingEmailOptIn: boolean } | null;
  entitlement: Awaited<ReturnType<typeof getVipEntitlement>> | null;
  now: Date;
};

async function viewerContext(claims: UserClaims | null, now: Date): Promise<ViewerContext> {
  if (!claims) return { claims: null, user: null, entitlement: null, now };
  const [user] = await db.select({
    id: appUsersTable.id,
    name: appUsersTable.name,
    createdAt: appUsersTable.createdAt,
    marketingEmailOptIn: appUsersTable.marketingEmailOptIn,
  }).from(appUsersTable).where(and(eq(appUsersTable.id, claims.sub), eq(appUsersTable.status, "active"))).limit(1);
  if (!user) return { claims: null, user: null, entitlement: null, now };
  const entitlement = await getVipEntitlement(claims, now);
  return { claims, user, entitlement, now };
}

function matchesAudience(message: BroadcastMessageRow, context: ViewerContext): boolean {
  const effective = broadcastEffectiveState(message, context.now);
  if (effective !== "active") return false;
  if (message.audience === "all") return true;
  if (message.audience === "guests") return !context.user;
  if (!context.user || !context.entitlement) return false;
  if (message.audience === "free") return !context.entitlement.active;
  if (message.audience === "vip") return context.entitlement.active;
  if (message.audience === "new_users") return context.now.getTime() - context.user.createdAt.getTime() <= 7 * 24 * 60 * 60 * 1000;
  if (message.audience === "expiring") {
    const end = context.entitlement.expiresAt;
    if (!context.entitlement.active || !end) return false;
    const days = cairoCalendarDaysUntil(end, context.now);
    return days >= 0 && days <= 7;
  }
  return false;
}

function contentHasPricingVariables(content: BroadcastContent, title: string): boolean {
  return /\{\{(?:price|old_price|discount_percent)\}\}/.test(`${title}\n${JSON.stringify(content)}`);
}

function replaceVariables(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(name|price|old_price|discount_percent)\}\}/g, (_whole, key: string) => vars[key] || "غير متاح حاليًا");
}

function resolveContentVariables(content: BroadcastContent, vars: Record<string, string>): BroadcastContent {
  return {
    version: 1,
    blocks: content.blocks.map((block) => ({
      type: block.type,
      ...(block.inlines ? { inlines: block.inlines.map((inline) => ({ ...inline, text: replaceVariables(inline.text, vars) })) } : {}),
      ...(block.items ? { items: block.items.map((item) => item.map((inline) => ({ ...inline, text: replaceVariables(inline.text, vars) }))) } : {}),
    })),
  };
}

async function pricingVariables(message: BroadcastMessageRow, context: ViewerContext): Promise<{ vars: Record<string, string>; source: BroadcastPublicMessage["variableSource"] }> {
  const vars: Record<string, string> = { name: plainText(context.user?.name || "ضيفنا", 80) || "ضيفنا", price: "غير متاح حاليًا", old_price: "غير متاح حاليًا", discount_percent: "غير متاح حاليًا" };
  if (!contentHasPricingVariables(message.content, message.title)) return { vars, source: "not_requested" };
  if (!message.variablePlanKey) return { vars, source: "unavailable" };
  const [plan] = await db.select().from(subscriptionPlansTable)
    .where(and(eq(subscriptionPlansTable.key, message.variablePlanKey), eq(subscriptionPlansTable.isActive, true))).limit(1);
  if (!plan) return { vars, source: "unavailable" };
  const effective = await getEffectivePrice(context.claims, plan, context.now);
  if (!Number.isFinite(effective.price) || effective.price <= 0) return { vars, source: "unavailable" };
  vars.price = `${Number(effective.price).toLocaleString("ar-EG")} ج`;
  if (Number.isFinite(effective.oldPrice) && Number(effective.oldPrice) > effective.price) vars.old_price = `${Number(effective.oldPrice).toLocaleString("ar-EG")} ج`;
  if (Number.isFinite(effective.discountPercent) && Number(effective.discountPercent) > 0) vars.discount_percent = `${Number(effective.discountPercent).toLocaleString("ar-EG")}%`;
  return { vars, source: "current_server_price" };
}

function safeStoredAction(value: BroadcastAction): BroadcastAction {
  if (value?.kind === "link" && value.label && safeBroadcastUrl(value.url)) {
    return { kind: "link", label: plainText(value.label, 40), url: safeBroadcastUrl(value.url)! };
  }
  return { kind: "none" };
}

async function toPublicMessage(message: BroadcastMessageRow, media: BroadcastMediaRow | null, context: ViewerContext): Promise<BroadcastPublicMessage> {
  const pricing = await pricingVariables(message, context);
  const safeContent = sanitizeStoredContent(message.content);
  const content = safeContent ? resolveContentVariables(safeContent, pricing.vars) : { version: 1 as const, blocks: [{ type: "paragraph" as const, inlines: [{ text: "غير متاح حاليًا" }] }] };
  return {
    id: message.id,
    title: replaceVariables(plainText(message.title, MAX_TITLE), pricing.vars),
    content,
    messageType: message.messageType as BroadcastType,
    audience: message.audience as BroadcastAudience,
    imageUrl: media && !media.archivedAt ? `/api/broadcasts/media/${encodeURIComponent(media.id)}` : null,
    action: safeStoredAction(message.action),
    startsAt: message.startsAt?.toISOString() || null,
    endsAt: message.endsAt?.toISOString() || null,
    generatedAt: context.now.toISOString(),
    variableSource: pricing.source,
  };
}

function eligibleAudienceKeys(context: ViewerContext): BroadcastAudience[] {
  if (!context.user) return ["all", "guests"];
  const result: BroadcastAudience[] = ["all"];
  if (context.entitlement?.active) result.push("vip"); else result.push("free");
  if (context.now.getTime() - context.user.createdAt.getTime() <= 7 * 24 * 60 * 60 * 1000) result.push("new_users");
  const endsAt = context.entitlement?.expiresAt;
  if (context.entitlement?.active && endsAt) {
    const days = cairoCalendarDaysUntil(endsAt, context.now);
    if (days >= 0 && days <= 7) result.push("expiring");
  }
  return result;
}

async function loadCandidateMessages(now: Date, audiences: BroadcastAudience[], userId?: number): Promise<Array<{ message: BroadcastMessageRow; media: BroadcastMediaRow | null }>> {
  /* Filter schedule + audience in SQL before priority selection. Registered
   * viewers additionally left-join their display state so a page with many
   * old/seen announcements cannot starve the first unseen candidate. */
  const conditions = and(
    eq(broadcastMessagesTable.status, "published"),
    isNull(broadcastMessagesTable.archivedAt),
    inArray(broadcastMessagesTable.audience, audiences),
    or(isNull(broadcastMessagesTable.startsAt), lte(broadcastMessagesTable.startsAt, now)),
    or(isNull(broadcastMessagesTable.endsAt), gt(broadcastMessagesTable.endsAt, now)),
  );
  if (userId) {
    return db.select({ message: broadcastMessagesTable, media: broadcastMediaTable }).from(broadcastMessagesTable)
      .leftJoin(broadcastMediaTable, eq(broadcastMessagesTable.imageMediaId, broadcastMediaTable.id))
      .leftJoin(broadcastMessageUserStatesTable, and(
        eq(broadcastMessageUserStatesTable.messageId, broadcastMessagesTable.id),
        eq(broadcastMessageUserStatesTable.userId, userId),
      ))
      .where(and(conditions, isNull(broadcastMessageUserStatesTable.id)))
      .orderBy(desc(broadcastMessagesTable.priority), desc(broadcastMessagesTable.createdAt)).limit(100);
  }
  return db.select({ message: broadcastMessagesTable, media: broadcastMediaTable }).from(broadcastMessagesTable)
    .leftJoin(broadcastMediaTable, eq(broadcastMessagesTable.imageMediaId, broadcastMediaTable.id))
    .where(conditions)
    .orderBy(desc(broadcastMessagesTable.priority), desc(broadcastMessagesTable.createdAt)).limit(100);
}

/** Server-truth preview used by the admin composer. It does not write, send
 * e-mail, claim a display, or make a draft publicly visible. */
export async function previewBroadcastDraft(input: BroadcastDraftInput, now = new Date()): Promise<{ message?: BroadcastPublicMessage; imageDataUrl?: string | null; error?: string }> {
  const content = parseBroadcastMarkdown(input.contentMarkdown);
  if (!content) return { error: "نص الرسالة غير صالح." };
  let media: BroadcastMediaRow | null = null;
  if (input.imageMediaId) {
    media = await broadcastMediaById(input.imageMediaId);
    if (!media) return { error: "الصورة المختارة لم تعد متاحة." };
  }
  const virtual = {
    id: "broadcast-preview",
    title: input.title,
    content,
    messageType: input.messageType,
    audience: input.audience,
    priority: input.priority,
    status: "published",
    startsAt: input.startsAt || now,
    endsAt: input.endsAt,
    imageMediaId: input.imageMediaId,
    action: input.action,
    variablePlanKey: input.variablePlanKey,
    marketingEmailRequested: false,
    marketingEmailConfirmedAt: null,
    createdBy: 0,
    updatedBy: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  } as BroadcastMessageRow;
  const context: ViewerContext = { claims: null, user: null, entitlement: null, now };
  return { message: await toPublicMessage(virtual, media, context), imageDataUrl: media?.dataUrl || null };
}

export async function activeBroadcastForViewer(input: { claims: UserClaims | null; excludeIds?: string[]; now?: Date }): Promise<BroadcastPublicMessage | null> {
  const now = input.now || new Date();
  const context = await viewerContext(input.claims, now);
  const candidates = (await loadCandidateMessages(now, eligibleAudienceKeys(context), context.user?.id)).filter((entry) => matchesAudience(entry.message, context));
  if (!candidates.length) return null;
  let unseen = candidates;
  if (!context.user) {
    const excluded = new Set((input.excludeIds || []).filter((id) => /^[a-zA-Z0-9_-]{1,100}$/.test(id)).slice(0, 50));
    unseen = candidates.filter((entry) => !excluded.has(entry.message.id));
  }
  const selected = unseen[0];
  return selected ? toPublicMessage(selected.message, selected.media, context) : null;
}

/** Resolves only media attached to an active announcement that this exact
 * viewer is eligible to receive. Draft/scheduled/private media stay behind
 * the authenticated admin media route. */
export async function activeBroadcastMediaForViewer(mediaId: string, claims: UserClaims | null, now = new Date()): Promise<BroadcastMediaRow | null> {
  const context = await viewerContext(claims, now);
  const audiences = eligibleAudienceKeys(context);
  const rows = await db.select({ message: broadcastMessagesTable, media: broadcastMediaTable }).from(broadcastMessagesTable)
    .innerJoin(broadcastMediaTable, eq(broadcastMessagesTable.imageMediaId, broadcastMediaTable.id))
    .where(and(
      eq(broadcastMessagesTable.status, "published"),
      inArray(broadcastMessagesTable.audience, audiences),
      eq(broadcastMediaTable.id, mediaId),
      isNull(broadcastMediaTable.archivedAt),
      isNull(broadcastMessagesTable.archivedAt),
      or(isNull(broadcastMessagesTable.startsAt), lte(broadcastMessagesTable.startsAt, now)),
      or(isNull(broadcastMessagesTable.endsAt), gt(broadcastMessagesTable.endsAt, now)),
    ))
    .orderBy(desc(broadcastMessagesTable.priority), desc(broadcastMessagesTable.createdAt)).limit(20);
  return rows.find((row) => matchesAudience(row.message, context))?.media || null;
}

export async function claimBroadcastForUser(messageId: string, claims: UserClaims | null, now = new Date()): Promise<{ message?: BroadcastPublicMessage; status: "claimed" | "already_seen" | "not_available" }> {
  const context = await viewerContext(claims, now);
  if (!context.user) return { status: "not_available" };
  const rows = await db.select({ message: broadcastMessagesTable, media: broadcastMediaTable }).from(broadcastMessagesTable)
    .leftJoin(broadcastMediaTable, eq(broadcastMessagesTable.imageMediaId, broadcastMediaTable.id))
    .where(eq(broadcastMessagesTable.id, messageId)).limit(1);
  const selected = rows[0];
  if (!selected || !matchesAudience(selected.message, context)) return { status: "not_available" };
  const inserted = await db.insert(broadcastMessageUserStatesTable).values({
    id: stateId(),
    messageId,
    userId: context.user.id,
    seenAt: now,
    updatedAt: now,
  }).onConflictDoNothing().returning({ id: broadcastMessageUserStatesTable.id });
  if (!inserted.length) return { status: "already_seen" };
  return { status: "claimed", message: await toPublicMessage(selected.message, selected.media, context) };
}

export async function recordBroadcastUserEvent(input: {
  messageId: string;
  claims: UserClaims | null;
  event: "close" | "do_not_show_again" | "cta_click" | "coupon_copy";
  now?: Date;
}): Promise<boolean> {
  const context = await viewerContext(input.claims, input.now || new Date());
  if (!context.user) return false;
  const now = input.now || new Date();
  const set = input.event === "close" ? { closedAt: now, updatedAt: now }
    : input.event === "do_not_show_again" ? { doNotShowAgainAt: now, closedAt: now, updatedAt: now }
      : input.event === "cta_click" ? { ctaClickedAt: now, updatedAt: now }
        : { couponCopiedAt: now, updatedAt: now };
  const updated = await db.update(broadcastMessageUserStatesTable).set(set)
    .where(and(eq(broadcastMessageUserStatesTable.messageId, input.messageId), eq(broadcastMessageUserStatesTable.userId, context.user.id)))
    .returning({ id: broadcastMessageUserStatesTable.id });
  return Boolean(updated.length);
}

export async function listBroadcastsForAdmin(now = new Date()): Promise<Array<{
  message: BroadcastMessageRow;
  mediaUrl: string | null;
  effectiveState: BroadcastEffectiveState;
  stats: { views: number; closes: number; clicks: number; couponUsage: null; couponUsageSource: "unavailable_until_payment_redemption" };
}>> {
  const rows = await db.select({ message: broadcastMessagesTable, media: broadcastMediaTable }).from(broadcastMessagesTable)
    .leftJoin(broadcastMediaTable, eq(broadcastMessagesTable.imageMediaId, broadcastMediaTable.id))
    .orderBy(desc(broadcastMessagesTable.createdAt)).limit(200);
  const ids = rows.map((row) => row.message.id);
  const states = ids.length
    ? await db.select({
      messageId: broadcastMessageUserStatesTable.messageId,
      seenAt: broadcastMessageUserStatesTable.seenAt,
      closedAt: broadcastMessageUserStatesTable.closedAt,
      ctaClickedAt: broadcastMessageUserStatesTable.ctaClickedAt,
    }).from(broadcastMessageUserStatesTable).where(inArray(broadcastMessageUserStatesTable.messageId, ids))
    : [];
  return rows.map((row) => {
    const state = states.filter((item) => item.messageId === row.message.id);
    return {
      message: row.message,
      mediaUrl: row.media && !row.media.archivedAt ? `/api/broadcasts/media/${encodeURIComponent(row.media.id)}` : null,
      effectiveState: broadcastEffectiveState(row.message, now),
      stats: {
        views: state.filter((item) => Boolean(item.seenAt)).length,
        closes: state.filter((item) => Boolean(item.closedAt)).length,
        clicks: state.filter((item) => Boolean(item.ctaClickedAt)).length,
        couponUsage: null,
        couponUsageSource: "unavailable_until_payment_redemption" as const,
      },
    };
  });
}

export async function createBroadcastTestDelivery(messageId: string, employeeId: number, now = new Date()): Promise<boolean> {
  const [message] = await db.select({ id: broadcastMessagesTable.id }).from(broadcastMessagesTable)
    .where(eq(broadcastMessagesTable.id, messageId)).limit(1);
  if (!message) return false;
  await db.insert(broadcastTestDeliveriesTable).values({
    id: `broadcast-test-${crypto.randomUUID()}`,
    messageId,
    employeeId,
    createdAt: now,
  });
  return true;
}

export async function broadcastMediaById(id: string): Promise<BroadcastMediaRow | null> {
  const [media] = await db.select().from(broadcastMediaTable)
    .where(and(eq(broadcastMediaTable.id, id), isNull(broadcastMediaTable.archivedAt))).limit(1);
  return media || null;
}
