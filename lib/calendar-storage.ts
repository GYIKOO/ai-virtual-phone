import type { CalendarColorKey, CalendarOwnerType, CalendarScheduleItem, CalendarWeekPlan, CalendarCommitment } from "./calendar-types";
import { resolveUserIdentity } from "./settings-storage";
import {
  formatIsoDate,
  getOwnerStorageKey,
  getWeekDates,
  getWeekStartIso,
  getWeekdayLabel,
  isCalendarColorKey,
  isCalendarTimeRangeAllowed,
  normalizeTime,
  pickScheduleColorKey,
  sanitizeScheduleEmoji,
  sortScheduleItems,
  timeToMinutes,
} from "./calendar-utils";
import { kvGet, kvSet, kvSetAsync, kvRefresh, registerKvMigration } from "./kv-db";
import { getSystemTimeZone } from "./character-time";

const STORAGE_KEY = "ai_phone_calendar_plans_v1";
const CALENDAR_CONFIG_KEY = "ai_phone_calendar_config_v1";
registerKvMigration(STORAGE_KEY);
registerKvMigration(CALENDAR_CONFIG_KEY);

export type PersistedCalendarStore = {
  plans: CalendarWeekPlan[];
  commitments: CalendarCommitment[];
  appliedBatches: string[];
  revision: number;
};

export type CalendarConfig = {
  /** Explicit opt-in list; the old global toggle never opts everyone in. */
  autoGenerateCharacterIds: string[];
  autoGenerateEnabled: boolean;
  theme: string;
  /** 详情页时间轴一页显示的天数（1/2/3/5/7），默认 2 */
  daysPerPage: number;
};

const DEFAULT_CALENDAR_CONFIG: CalendarConfig = {
  autoGenerateCharacterIds: [],
  autoGenerateEnabled: false,
  theme: "light",
  daysPerPage: 2,
};

export const CALENDAR_DAYS_PER_PAGE_OPTIONS = [1, 2, 3, 5, 7] as const;

export function normalizeCalendarDaysPerPage(value: unknown): number {
  const num = typeof value === "number" ? Math.round(value) : NaN;
  return (CALENDAR_DAYS_PER_PAGE_OPTIONS as readonly number[]).includes(num)
    ? num
    : DEFAULT_CALENDAR_CONFIG.daysPerPage;
}

/** 旧版主题 id → 新版主题 id（v2 改版后主题全部重定义） */
const LEGACY_THEME_MAP: Record<string, string> = {
  ocean: "light",
  orange: "cream",
  honey: "cream",
  melon: "mint",
};

export const CALENDAR_THEME_IDS = ["light", "dark", "cream", "mint", "mist", "sakura"] as const;

export function normalizeCalendarTheme(theme: unknown): string {
  if (typeof theme !== "string" || !theme) return DEFAULT_CALENDAR_CONFIG.theme;
  const mapped = LEGACY_THEME_MAP[theme] ?? theme;
  return (CALENDAR_THEME_IDS as readonly string[]).includes(mapped) ? mapped : DEFAULT_CALENDAR_CONFIG.theme;
}

export function loadCalendarStore(): PersistedCalendarStore {
  const empty = (): PersistedCalendarStore => ({ plans: [], commitments: [], appliedBatches: [], revision: 0 });
  if (typeof window === "undefined") return empty();
  try {
    const raw = kvGet(STORAGE_KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<PersistedCalendarStore>;
    return { plans: Array.isArray(parsed.plans) ? parsed.plans : [],
      commitments: Array.isArray(parsed.commitments) ? parsed.commitments : [],
      appliedBatches: Array.isArray(parsed.appliedBatches) ? parsed.appliedBatches : [],
      revision: Number.isSafeInteger(parsed.revision) ? parsed.revision! : 0 };
  } catch {
    return empty();
  }
}

const loadStore = loadCalendarStore;
export function saveCalendarStore(store: PersistedCalendarStore): void {
  if (typeof window === "undefined") return;
  kvSet(STORAGE_KEY, JSON.stringify({ ...store, revision: loadStore().revision + 1 }));
  if (typeof Event !== "undefined") window.dispatchEvent?.(new Event("calendar-updated"));
}
const saveStore = saveCalendarStore;
let calendarWriteQueue: Promise<unknown> = Promise.resolve();
export async function withCalendarWriteLock<T>(action: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) return await navigator.locks.request("float-calendar-write",action);
  const next = calendarWriteQueue.then(action,action);
  calendarWriteQueue = next.catch(() => undefined);
  return next;
}

export async function flushCalendarStore(): Promise<void> {
  const value = kvGet(STORAGE_KEY);
  if (value !== null && value !== undefined) await kvSetAsync(STORAGE_KEY,value);
}

/** Await persistence before releasing the shared mutation lock. */
export async function saveCalendarStoreAsync(store: PersistedCalendarStore): Promise<void> {
  if (typeof window === "undefined") throw new Error("日历存储尚未就绪");
  await kvSetAsync(STORAGE_KEY,JSON.stringify({...store,revision:loadStore().revision+1}));
  if (typeof Event !== "undefined") window.dispatchEvent?.(new Event("calendar-updated"));
}

export function calendarIdentity(ownerId?: string): string {
  return resolveUserIdentity?.(ownerId, "calendar")?.id || "";
}

export function loadCalendarCommitments(ownerId?: string, identityId = calendarIdentity(ownerId)): CalendarCommitment[] {
  return loadStore().commitments.filter(row => row.userIdentityId === identityId && (!ownerId || row.participantIds.includes(ownerId)));
}

function commitmentItems(ownerType: CalendarOwnerType, ownerId: string, weekStart: string, identityId?: string): CalendarScheduleItem[] {
  const dates = new Set(getWeekDates(weekStart));
  return loadCalendarCommitments(ownerType === "character" ? ownerId : undefined, identityId)
    .filter(row => row.status !== "cancelled" && row.date && dates.has(row.date) && row.startTime && row.endTime)
    .map(row => ({ id: `commitment:${row.id}`, commitmentId: row.id, date: row.date!, weekday: getWeekdayLabel(row.date!),
      startTime: row.startTime!, endTime: row.endTime!, location: row.location, title: `约定：${row.title}`, emoji: "📌",
      source: "manual", colorKey: "violet", createdAt: row.createdAt, updatedAt: row.updatedAt }));
}

export function formatCalendarCommitments(ownerId: string | undefined, weekStart?: string, identityId?: string): string {
  const end = weekStart ? getWeekDates(weekStart).at(-1)! : undefined;
  const nextEnd = end ? new Date(`${end}T12:00:00`) : undefined;
  nextEnd?.setDate(nextEnd.getDate() + 7);
  const rows = loadCalendarCommitments(ownerId, identityId).filter(row => row.status === "confirmed"
    && (!weekStart || !row.date || (row.date >= weekStart && row.date <= formatIsoDate(nextEnd!))));
  return rows.map(row => `${row.id} | ${row.date || "日期待定"} ${row.startTime || "时间待定"}${row.endTime ? `-${row.endTime}` : ""} | ${row.title} | ${row.location || "地点待定"} | 参与角色：${row.participantIds.join("、")}`).join("\n");
}

export function loadCalendarConfig(): CalendarConfig {
  if (typeof window === "undefined") return { ...DEFAULT_CALENDAR_CONFIG };
  try {
    const raw = kvGet(CALENDAR_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CALENDAR_CONFIG };
    const parsed = { ...DEFAULT_CALENDAR_CONFIG, ...JSON.parse(raw) } as CalendarConfig;
    parsed.theme = normalizeCalendarTheme(parsed.theme);
    parsed.daysPerPage = normalizeCalendarDaysPerPage(parsed.daysPerPage);
    parsed.autoGenerateCharacterIds = Array.isArray(parsed.autoGenerateCharacterIds)
      ? [...new Set(parsed.autoGenerateCharacterIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())))] : [];
    return parsed;
  } catch {
    return { ...DEFAULT_CALENDAR_CONFIG };
  }
}

export function saveCalendarConfig(config: CalendarConfig): void {
  if (typeof window === "undefined") return;
  kvSet(CALENDAR_CONFIG_KEY, JSON.stringify(config));
  window.dispatchEvent(new Event("calendar-config-updated"));
}

/** Refresh shared calendar data before a cross-tab automatic generation lock is used. */
export async function refreshCalendarData(): Promise<void> {
  await Promise.all([kvRefresh(STORAGE_KEY), kvRefresh(CALENDAR_CONFIG_KEY)]);
}

export function loadCalendarWeekPlan(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
  identityId?: string,
): CalendarWeekPlan | null {
  const store = loadStore();
  const plan = store.plans.find(
    entry => entry.ownerType === ownerType && entry.ownerId === ownerId && entry.weekStart === weekStart,
  );
  const protectedItems = commitmentItems(ownerType, ownerId, weekStart, identityId);
  if (!plan && !protectedItems.length) return null;
  return {
    id: `calendar_week_${ownerType}_${ownerId}_${weekStart}`, ownerType, ownerId, weekStart, updatedAt: "",
    ...plan,
    items: sortScheduleItems([...(plan?.items || []).filter(item => !item.commitmentId
      && (item.source === "manual" || !protectedItems.some(commitment => commitment.date === item.date && commitment.startTime < item.endTime && commitment.endTime > item.startTime))), ...protectedItems]
      .filter(item => isCalendarTimeRangeAllowed(item.startTime, item.endTime))
      .map(item => ({
        ...item,
        weekday: item.weekday || getWeekdayLabel(item.date),
        colorKey: item.colorKey || pickScheduleColorKey(item.startTime),
      }))),
  };
}

export function loadOwnerCalendarPlans(
  ownerType: CalendarOwnerType,
  ownerId: string,
  identityId?: string,
): CalendarWeekPlan[] {
  const store = loadStore();
  const weeks = new Set([...store.plans
    .filter(entry => entry.ownerType === ownerType && entry.ownerId === ownerId)
    .map(entry => entry.weekStart), ...loadCalendarCommitments(ownerType === "character" ? ownerId : undefined, identityId)
      .filter(row => row.date).map(row => getWeekStartIso(new Date(`${row.date}T12:00:00`)))]);
  return [...weeks].map(week => loadCalendarWeekPlan(ownerType, ownerId, week, identityId)!).filter(Boolean)
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

export function saveCalendarWeekPlan(plan: CalendarWeekPlan): CalendarWeekPlan {
  const store = loadStore();
  const normalized: CalendarWeekPlan = {
    ...plan,
    updatedAt: new Date().toISOString(),
    items: sortScheduleItems(plan.items.filter(item => !item.commitmentId && !item.id.startsWith("commitment:")).map(item => ({
      ...item,
      weekday: item.weekday || getWeekdayLabel(item.date),
      colorKey: item.colorKey || pickScheduleColorKey(item.startTime),
    }))),
  };
  const nextPlans = store.plans.filter(
    entry => !(entry.ownerType === plan.ownerType && entry.ownerId === plan.ownerId && entry.weekStart === plan.weekStart),
  );
  nextPlans.push(normalized);
  saveStore({ ...store, plans: nextPlans });
  return normalized;
}

export function replaceCalendarWeekItems(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
  items: CalendarScheduleItem[],
): CalendarWeekPlan {
  const existing = loadCalendarWeekPlan(ownerType, ownerId, weekStart);
  const plan: CalendarWeekPlan = {
    id: existing?.id ?? `calendar_week_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ownerType,
    ownerId,
    weekStart,
    items,
    updatedAt: new Date().toISOString(),
  };
  return saveCalendarWeekPlan(plan);
}

export function upsertCalendarScheduleItem(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
  item: Omit<CalendarScheduleItem, "id" | "weekday" | "colorKey" | "createdAt" | "updatedAt"> & Partial<Pick<CalendarScheduleItem, "id" | "weekday" | "colorKey" | "createdAt" | "updatedAt">>,
): CalendarWeekPlan {
  const plan = loadStore().plans.find(row => row.ownerType === ownerType && row.ownerId === ownerId && row.weekStart === weekStart);
  const existingItems = plan?.items ?? [];
  const now = new Date().toISOString();
  const normalized: CalendarScheduleItem = {
    id: item.id ?? `calendar_item_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    date: item.date,
    weekday: item.weekday || getWeekdayLabel(item.date),
    startTime: item.startTime,
    endTime: item.endTime,
    location: item.location.trim(),
    title: item.title.trim(),
    emoji: sanitizeScheduleEmoji(item.emoji),
    colorKey: item.colorKey || pickScheduleColorKey(item.startTime),
    source: item.source,
    createdAt: item.createdAt ?? now,
    updatedAt: now,
  };
  const nextItems = existingItems.filter(entry => entry.id !== normalized.id);
  nextItems.push(normalized);
  return replaceCalendarWeekItems(ownerType, ownerId, weekStart, nextItems);
}

export function deleteCalendarScheduleItem(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
  itemId: string,
): CalendarWeekPlan {
  const plan = loadStore().plans.find(row => row.ownerType === ownerType && row.ownerId === ownerId && row.weekStart === weekStart);
  return replaceCalendarWeekItems(ownerType, ownerId, weekStart, (plan?.items ?? []).filter(item => item.id !== itemId));
}

export function formatCalendarScheduleForPrompt(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
  identityId = "",
): string {
  const plan = loadCalendarWeekPlan(ownerType, ownerId, weekStart, identityId);
  if (!plan || plan.items.length === 0) {
    return "本周暂无明确日程安排。";
  }

  const grouped = new Map<string, CalendarScheduleItem[]>();
  for (const item of plan.items) {
    const arr = grouped.get(item.date) || [];
    arr.push(item);
    grouped.set(item.date, arr);
  }

  return getWeekDates(weekStart)
    .map(date => {
      const items = sortScheduleItems(grouped.get(date) || []);
      if (items.length === 0) {
        return `${date} ${getWeekdayLabel(date)}：暂无明确安排`;
      }
      const summary = items
        .map(item => `${item.startTime}-${item.endTime} @${item.location || "未定"} ${item.title}`)
        .join("；");
      return `${date} ${getWeekdayLabel(date)}：${summary}`;
    })
    .join("\n");
}

export function formatCalendarScheduleItemForPrompt(item: Pick<CalendarScheduleItem, "startTime" | "endTime" | "location" | "title">): string {
  return `${item.startTime}-${item.endTime} @${item.location || "未定"} ${item.title}`;
}

export function getCurrentCalendarScheduleForPrompt(
  ownerType: CalendarOwnerType,
  ownerId: string,
  now = new Date(),
  identityId = "",
): string {
  const date = formatIsoDate(now);
  const weekStart = getWeekStartIso(now);
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  const plan = loadCalendarWeekPlan(ownerType, ownerId, weekStart, identityId);
  if (!plan) return "无";

  const activeItems = sortScheduleItems(plan.items).filter(item => {
    if (item.date !== date) return false;
    const start = timeToMinutes(item.startTime);
    const end = timeToMinutes(item.endTime);
    if (Number.isNaN(start) || Number.isNaN(end)) return false;
    return start <= currentMinute && currentMinute < end;
  });

  if (activeItems.length === 0) return "无";
  return activeItems.map(formatCalendarScheduleItemForPrompt).join("；");
}

/** Nearby plans, including adjacent weeks. Calendar dates currently use the device timezone. */
export function buildNearbyCalendarScheduleForPrompt(
  ownerType: CalendarOwnerType, ownerId: string, now = new Date(),
  identityId = "",
): string {
  const at = now.getTime();
  const rows = loadOwnerCalendarPlans(ownerType, ownerId, identityId).flatMap(plan => plan.items)
    .map(item => ({ item, start: Date.parse(`${item.date}T${item.startTime}:00`), end: Date.parse(`${item.date}T${item.endTime}:00`) }))
    .filter(row => Number.isFinite(row.start) && Number.isFinite(row.end) && row.end > row.start
      && row.end >= at - 24 * 3600000 && row.start <= at + 12 * 3600000);
  const groups = [
    { label: "按日程当前进行中", items: rows.filter(r => r.start <= at && r.end > at).sort((a, b) => a.start - b.start) },
    { label: "过去24小时内按计划已结束", items: rows.filter(r => r.end <= at).sort((a, b) => b.end - a.end) },
    { label: "未来12小时内的计划", items: rows.filter(r => r.start > at).sort((a, b) => a.start - b.start) },
  ];
  return [
    `附近日程（时区：${getSystemTimeZone()}；日历中的安排，实际进展以经历记录为准）：`,
    ...groups.map(group => `${group.label}：\n${group.items.length ? group.items.slice(0, 10).map(({ item }) => `${item.date} ${formatCalendarScheduleItemForPrompt(item)}`).join("\n") : "暂无安排"}`),
  ].join("\n");
}

/**
 * 重新生成前清掉本周的 AI 生成条目（保留手动条目）。
 * 否则旧的生成结果会经由日程 marker 进入提示词，被模型原样照抄——
 * 导致"重新生成永远一字不差"。返回被移除的条目，供生成失败时恢复。
 */
export function clearGeneratedWeekItems(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
): CalendarScheduleItem[] {
  const existing = loadCalendarWeekPlan(ownerType, ownerId, weekStart);
  const items = existing?.items ?? [];
  const removed = items.filter(item => item.source !== "manual");
  if (removed.length === 0) return [];
  replaceCalendarWeekItems(ownerType, ownerId, weekStart, items.filter(item => item.source === "manual"));
  return removed;
}

/** 生成失败时，把 clearGeneratedWeekItems 移除的条目加回本周计划。 */
export function restoreCalendarWeekItems(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
  itemsToRestore: CalendarScheduleItem[],
): void {
  if (itemsToRestore.length === 0) return;
  const existing = loadCalendarWeekPlan(ownerType, ownerId, weekStart);
  replaceCalendarWeekItems(ownerType, ownerId, weekStart, sortScheduleItems([
    ...(existing?.items ?? []),
    ...itemsToRestore,
  ]));
}

export function buildCalendarScheduleMarker(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
  identityId = "",
): string {
  const ownerLabel = ownerType === "user" ? "用户" : "角色";
  return [
    `当前查看周起始日期：${weekStart}`,
    `${ownerLabel}本周日程：`,
    formatCalendarScheduleForPrompt(ownerType, ownerId, weekStart, identityId),
    `本周及下周的有效约定（与日程分开保存）：\n${formatCalendarCommitments(ownerType === "character" ? ownerId : undefined, weekStart, identityId) || "无"}`,
  ].join("\n");
}

export function normalizeGeneratedScheduleItems(
  rawItems: Array<{
    date: string;
    startTime: string;
    endTime: string;
    location: string;
    title: string;
    emoji?: string;
    colorKey?: CalendarColorKey;
  }>,
): CalendarScheduleItem[] {
  const now = new Date().toISOString();
  return sortScheduleItems(
    rawItems
      .map(item => ({
        id: `calendar_item_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        date: item.date,
        weekday: getWeekdayLabel(item.date),
        startTime: normalizeTime(item.startTime) || item.startTime,
        endTime: normalizeTime(item.endTime) || item.endTime,
        location: item.location.trim(),
        title: item.title.trim(),
        emoji: sanitizeScheduleEmoji(item.emoji),
        colorKey: isCalendarColorKey(item.colorKey) ? item.colorKey : pickScheduleColorKey(item.startTime),
        source: "generated" as const,
        createdAt: now,
        updatedAt: now,
      }))
      .filter(item => isCalendarTimeRangeAllowed(item.startTime, item.endTime)),
  );
}

export function cloneWeekPlanWithManualEdits(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
  generatedItems: CalendarScheduleItem[],
): CalendarWeekPlan {
  const existing = loadStore().plans.find(row => row.ownerType === ownerType && row.ownerId === ownerId && row.weekStart === weekStart);
  const now=Date.now();
  const manualItems = (existing?.items ?? []).filter(item => item.source === "manual" || Date.parse(`${item.date}T${item.startTime}:00`) < now);
  const commitments=loadCalendarCommitments(ownerType === "character" ? ownerId : undefined)
    .filter(row=>row.status==="confirmed" && row.date && row.startTime && row.endTime);
  const overlaps=(item:CalendarScheduleItem,other:{date:string;startTime:string;endTime:string})=>item.date===other.date && item.startTime<other.endTime && item.endTime>other.startTime;
  const nextItems = generatedItems.filter(item => item.source !== "manual" && Date.parse(`${item.date}T${item.startTime}:00`) >= now
    && !manualItems.some(other=>overlaps(item,other))
    && !commitments.some(row=>overlaps(item,{date:row.date!,startTime:row.startTime!,endTime:row.endTime!})));
  for (const item of manualItems) {
    const collides = nextItems.find(
      entry =>
        entry.date === item.date &&
        entry.startTime === item.startTime &&
        entry.endTime === item.endTime &&
        entry.title === item.title,
    );
    if (!collides) {
      nextItems.push(item);
    }
  }
  return replaceCalendarWeekItems(ownerType, ownerId, weekStart, nextItems);
}

export function validateScheduleDraft(item: {
  date: string;
  startTime: string;
  endTime: string;
  location: string;
  title: string;
}): string | null {
  const start = normalizeTime(item.startTime);
  const end = normalizeTime(item.endTime);
  if (!item.date || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)) return "请选择日期";
  if (!start || !end) return "请输入正确的时间格式";
  if (start >= end) return "结束时间需要晚于开始时间";
  if (!item.title.trim()) return "请输入事项";
  return null;
}

export function getCalendarOwnerLabel(ownerType: CalendarOwnerType, ownerName: string): string {
  return ownerType === "user" ? `${ownerName}的日程` : `${ownerName}的日程`;
}

export function getCalendarOwnerKey(ownerType: CalendarOwnerType, ownerId: string): string {
  return getOwnerStorageKey(ownerType, ownerId);
}
