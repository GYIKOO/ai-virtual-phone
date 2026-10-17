import type { Character } from "./character-types";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import type { UserIdentity } from "@/components/settings/user-identity";
import type { AssemblerInput, LLMMessage } from "./llm-prompt-assembler";
import type { CalendarOwnerType, CalendarScheduleItem } from "./calendar-types";
import { loadCharacters } from "./character-storage";
import {
  loadBindingConfig,
  loadApiConfigs,
  loadPresets,
  loadWorldBooks,
  loadRegexes,
  resolveBinding,
  resolveUserIdentity,
} from "./settings-storage";
import { assemblePromptPayload } from "./llm-prompt-assembler";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { getCustomStickerExample, getCustomStickerNames } from "./custom-sticker-storage";
import { previewMessagesForApi, sendLLMRequest, type ChatEngineError } from "./chat-engine";
import { buildCalendarScheduleMarker, cloneWeekPlanWithManualEdits, normalizeGeneratedScheduleItems, loadCalendarWeekPlan, loadCalendarStore, refreshCalendarData, formatCalendarCommitments, withCalendarWriteLock, flushCalendarStore } from "./calendar-storage";
import {
  getWeekDates,
  getWeekStartIso,
  getWeekdayLabel,
  isCalendarTimeRangeAllowed,
  normalizeTime,
  sanitizeScheduleEmoji,
} from "./calendar-utils";

type CalendarAssemblerResolved = {
  apiConfig: ApiConfig;
  preset: PresetConfig | null;
  regexes: RegexConfig[];
  llmMessages: LLMMessage[];
  ownerName: string;
};

function buildSyntheticUserCharacter(identity: UserIdentity | null): Character {
  const now = new Date().toISOString();
  const personaLines = [
    identity?.bio?.trim(),
    identity?.occupation ? `职业：${identity.occupation}` : "",
    identity?.age ? `年龄：${identity.age}` : "",
    identity?.gender && identity.gender !== "保密" ? `性别：${identity.gender}` : "",
    identity?.customSettings?.trim(),
  ].filter(Boolean);

  return {
    id: "__calendar_user__",
    name: identity?.name?.trim() || "用户",
    avatar: identity?.avatarUrl || null,
    persona: personaLines.join("\n") || "这是用户本人。",
    wechatID: "",
    createdAt: now,
    updatedAt: now,
  };
}

function buildCalendarTriggerInstruction(ownerName: string, weekDates: string[], commitments = "", now = Date.now()): string {
  return [
    `请为${ownerName}生成 ${weekDates[0]} 到 ${weekDates[6]} 这一周的日程安排。`,
    "请参考保留的安排，为目标周未来的空闲时段补充日程。",
    "每行一条，格式：YYYY-MM-DD|周几|开始时间|结束时间|地点|emoji|事项。emoji 段填一个最贴合该事项的表情符号。",
    "作息时间不受限制（早起、夜跑、通宵都可以安排），但每一天最多 5 条日程，宁缺毋滥。",
    `本次安排范围：从 ${new Date(now).toLocaleString()} 起至目标周结束，时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone}。已有约定、手动安排及已开始的活动予以保留。\n相关约定：\n${commitments || "无"}`,
  ].join("\n");
}

function stripCodeFences(text: string): string {
  return text
    .replace(/^```[a-zA-Z]*\s*/g, "")
    .replace(/\s*```$/g, "")
    .trim();
}

function parseScheduleLines(rawText: string, weekStart: string): CalendarScheduleItem[] {
  const weekDates = new Set(getWeekDates(weekStart));
  const lines = stripCodeFences(rawText)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const parsed: Array<{
    date: string;
    startTime: string;
    endTime: string;
    location: string;
    title: string;
    emoji?: string;
  }> = [];

  for (const rawLine of lines) {
    const line = rawLine
      .replace(/^[-*]\s*/, "")
      .replace(/^\d+[.)、]\s*/, "")
      .trim();
    if (!line.includes("|")) continue;
    const parts = line.split("|").map(part => part.trim());
    if (parts.length < 6) continue;

    const date = parts[0];
    const startTime = normalizeTime(parts[2]);
    const endTime = normalizeTime(parts[3]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !weekDates.has(date)) continue;
    if (!startTime || !endTime || !isCalendarTimeRangeAllowed(startTime, endTime)) continue;

    const location = parts[4] === "无" ? "" : parts[4];
    // 新格式第 6 段为 emoji（YYYY-MM-DD|周几|开始|结束|地点|emoji|事项）；
    // 兼容旧格式（第 6 段直接是事项）：仅当该段确实是 emoji 时才按新格式取。
    let emoji = "";
    let title: string;
    if (parts.length >= 7) {
      const candidate = sanitizeScheduleEmoji(parts[5]);
      if (candidate && Array.from(parts[5]).length <= 3) {
        emoji = candidate;
        title = parts.slice(6).join("|");
      } else {
        title = parts.slice(5).join("|");
      }
    } else {
      title = parts[5];
    }
    if (!title.trim()) continue;

    parsed.push({
      date,
      startTime,
      endTime,
      location,
      title,
      emoji,
    });
  }

  return normalizeGeneratedScheduleItems(parsed);
}

async function resolveCalendarAssemblerInput(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
  regenerating = false,
): Promise<CalendarAssemblerResolved> {
  const bindings = loadBindingConfig();
  const activeSlot = resolveBinding(bindings, ownerType === "character" ? ownerId : undefined, "calendar");

  if (!activeSlot.apiConfigId) {
    throw new Error("未绑定日历 API，请先在配置绑定中为日历设置 API。");
  }

  const apiConfigs = loadApiConfigs();
  const apiConfig = apiConfigs.find(entry => entry.id === activeSlot.apiConfigId);
  if (!apiConfig) {
    throw new Error("日历 API 配置不存在。");
  }

  const presets = loadPresets();
  let preset = activeSlot.presetId ? presets.find(entry => entry.id === activeSlot.presetId) ?? null : null;
  if (!preset) preset = presets.find(entry => entry.builtIn) ?? null;

  const allWorldBooks = loadWorldBooks();
  const worldBooks = (activeSlot.worldBookIds || [])
    .map(id => allWorldBooks.find(entry => entry.id === id))
    .filter(Boolean) as WorldBookConfig[];

  const allRegexes = loadRegexes();
  const regexes = (activeSlot.regexIds || [])
    .map(id => allRegexes.find(entry => entry.id === id))
    .filter(Boolean) as RegexConfig[];

  const userIdentity = resolveUserIdentity(ownerType === "character" ? ownerId : undefined, "calendar");
  const character =
    ownerType === "character"
      ? loadCharacters().find(entry => entry.id === ownerId)
      : buildSyntheticUserCharacter(resolveUserIdentity(undefined, "calendar"));

  if (!character) {
    throw new Error("日历目标不存在。");
  }

  const memConfig = loadMemoryConfig();
  let coreMemories = "";
  let longTermMemories = "";
  let recentBlocks: import("./short-term-assembler").RecentBlock[] = [];
  let unifiedRecentItems: import("./short-term-assembler").UnifiedRecentItem[] = [];
  let wbActivationContext = "";

  if (ownerType === "character") {
    const prepared = prepareShortTermContext(ownerId, "calendar", { history: [] });
    recentBlocks = prepared.recentBlocks;
    unifiedRecentItems = prepared.unifiedRecentItems;
    wbActivationContext = prepared.wbActivationContext;
    const [coreResults, longResults] = await Promise.all([
      retrieveCoreMemoriesForPrompt(ownerId, memConfig).catch(() => []),
      retrieveMemoriesForPrompt(ownerId, wbActivationContext, memConfig).catch(() => []),
    ]);
    coreMemories = formatCoreMemories(coreResults);
    longTermMemories = formatLongTermMemories(longResults);
  }

  const scheduleSummary = regenerating
    ? `本周保留安排：\n${(loadCalendarWeekPlan(ownerType,ownerId,weekStart)?.items||[])
      .filter(item=>item.source==="manual" || Date.parse(`${item.date}T${item.startTime}:00`)<Date.now())
      .map(item=>`${item.date} ${item.startTime}-${item.endTime} ${item.title}`).join("\n")}\n本周及下周约定：\n${formatCalendarCommitments(ownerId,weekStart,userIdentity?.id)}`
    : buildCalendarScheduleMarker(ownerType, ownerId, weekStart, userIdentity?.id || "");
  const llmMessages = assemblePromptPayload({
    character,
    history: [],
    preset,
    worldBooks,
    regexes,
    userIdentity,
    appId: "calendar",
    scheduleSummary,
    coreMemories,
    longTermMemories,
    worldBookActivationContext: wbActivationContext || undefined,
    recentBlocks,
    unifiedRecentItems,
    customStickerNames: ownerType === "character" ? getCustomStickerNames(ownerId) : "",
    customStickerExample: ownerType === "character" ? getCustomStickerExample(ownerId) : "",
  } as AssemblerInput);

  return {
    apiConfig,
    preset,
    regexes,
    llmMessages,
    ownerName: character.name,
  };
}

const generatingWeeks = new Set<string>();

export async function generateWeeklyCalendarSchedule(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
  options?: { automatic?: boolean; referenceTime?: number; signal?: AbortSignal; canSave?: () => boolean },
): Promise<{ success: boolean; error?: string; items?: CalendarScheduleItem[] }> {
  if (ownerType !== "character") {
    return { success: false, error: "用户日程不支持 AI 生成，请手动填写。" };
  }
  const key = `${ownerType}:${ownerId}:${weekStart}`;
  if (generatingWeeks.has(key)) return { success: false, error: "该角色本周日程正在生成，请稍候。" };
  generatingWeeks.add(key);
  // Keep the persisted plan intact while generating; the prompt omits replaceable
  // generated slots. A concurrent edit invalidates this result instead of being lost.
  const revision=loadCalendarStore().revision;
  try {
    const resolved = await resolveCalendarAssemblerInput(ownerType, ownerId, weekStart, !options?.automatic);
    const weekDates = getWeekDates(weekStart);
    const triggerInstruction = buildCalendarTriggerInstruction(resolved.ownerName, weekDates, formatCalendarCommitments(ownerId,weekStart), options?.referenceTime);

    const messages: LLMMessage[] = [
      ...resolved.llmMessages,
      {
        role: "user",
        content: triggerInstruction,
        _debugMeta: { marker: "calendar_trigger" },
      },
    ];

    const rawText = await sendLLMRequest(
      resolved.apiConfig,
      resolved.preset,
      messages,
      resolved.regexes,
      { characterName: `日历:${resolved.ownerName}` },
      { appId: "calendar", appTags: ["calendar"], signal: options?.signal },
    );

    const items = parseScheduleLines(rawText, weekStart);
    if (items.length === 0) {
      return { success: false, error: "日历生成结果为空，或格式无法解析。" };
    }

    if (options?.signal?.aborted || options?.canSave?.() === false) {
      return { success: false, error: "日程生成已取消。" };
    }
    // A manual generation or another tab may have completed while awaiting the API.
    if (options?.automatic && loadCalendarWeekPlan(ownerType, ownerId, weekStart)?.items.some(item => item.source === "generated")) {
      return { success: true };
    }
    const accepted = options?.automatic ? items.filter(item =>
      new Date(`${item.date}T${item.startTime}:00`).getTime() >= (options.referenceTime ?? Date.now())) : items;
    const save=async()=>{
      await refreshCalendarData();
      if(loadCalendarStore().revision!==revision) return false;
      if(options?.signal?.aborted || options?.canSave?.()===false) return false;
      if (accepted.length) {
        cloneWeekPlanWithManualEdits(ownerType, ownerId, weekStart, accepted);
        await flushCalendarStore();
      }
      return true;
    };
    const saved=await withCalendarWriteLock(save);
    if(!saved) return {success:false,error:"生成期间日历已更新或任务已取消，现有安排已保留，请重新生成。"};
    return { success: true, items: accepted };
  } catch (error) {
    const err = error as ChatEngineError | Error;
    return { success: false, error: err?.message || "生成日历失败" };
  } finally {
    generatingWeeks.delete(key);
  }
}

export async function previewCalendarPromptPayload(
  ownerType: CalendarOwnerType,
  ownerId: string,
  weekStart: string,
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
  if (ownerType !== "character") {
    throw new Error("用户日程不支持 AI 生成预览。");
  }
  const resolved = await resolveCalendarAssemblerInput(ownerType, ownerId, weekStart, true);
  const weekDates = getWeekDates(weekStart);
  const triggerInstruction = buildCalendarTriggerInstruction(resolved.ownerName, weekDates, formatCalendarCommitments(ownerId,weekStart));

  const messages: LLMMessage[] = [
    ...resolved.llmMessages,
    {
      role: "user",
      content: triggerInstruction,
      _debugMeta: { marker: "calendar_trigger" },
    },
  ];

  const apiMessages = previewMessagesForApi(resolved.apiConfig, resolved.preset, messages);
  return {
    messages: apiMessages,
    characterName: `日历:${resolved.ownerName}`,
    model: resolved.apiConfig.defaultModel,
    presetName: resolved.preset?.name ?? "(无预设)",
  };
}

export function createDefaultScheduleDraft(date: string) {
  return {
    date,
    weekday: getWeekdayLabel(date),
    startTime: "09:00",
    endTime: "10:00",
    location: "",
    title: "",
    emoji: "",
    source: "manual" as const,
  };
}

export function getCurrentWeekStart(): string {
  return getWeekStartIso(new Date());
}
