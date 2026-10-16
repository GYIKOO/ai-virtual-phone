import { loadCharacters } from "./character-storage";
import {
  loadBindingConfig,
  loadApiConfigs,
  loadPresets,
  loadRegexes,
  loadWorldBooks,
  resolveBinding,
  resolveUserIdentity,
} from "./settings-storage";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import { assemblePromptPayload, type LLMMessage } from "./llm-prompt-assembler";
import { previewMessagesForApi, sendLLMRequestPreferStream, sendLLMRequest, sendLLMStreamRequest, ChatEngineError } from "./chat-engine";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { buildCalendarScheduleMarker, getCurrentCalendarScheduleForPrompt } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";
import { parseStoryResponse } from "./story-parser";
import { STORY_PARSER_VERSION } from "./story-parser";
import { loadStoryMessages, replaceStoryMessages, resolveActiveStorySchemes, type StoryCharacterSettings, type StoryGlobalSettings, type StoryMessage } from "./story-storage";
import type { ChatMessage } from "./chat-storage";
import { MacroEngine } from "./macro-engine";
import { prepareStoryInstructionHistory, wrapStoryInstruction, wrapStoryRetryInstruction } from "./story-instructions";
import { resolveStoryUserControlPrompt, resolveStoryUserControlEndingPrompt, DEFAULT_STORY_VOICE_FORMAT_PROMPT } from "./story-constraints";
import { formatPromptTimestamp } from "./prompt-time";
import { buildEnsembleStoryPrompt } from "./story-ensemble-context";
import { estimateStoryMessages, storyInputBudget } from "./story-context-budget";
import { selectStoryPresetPrompts } from "./story-preset-selection";
import { yieldStoryPreparation, throwIfStoryAborted, type StoryGenerationPhase } from "./story-preparation";

import { DEFAULT_STORY_FOLD_TAGS, DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS, storyFoldSignature } from "./story-tag-settings";

export type StoryGenerationOptions = {
  sessionId?: string;
  retryInstruction?: string;
  sessionFoldTags?: string;
  sessionContextExcludedTags?: string;
  settings?: StoryCharacterSettings;
  globalSettings?: StoryGlobalSettings;
  floatingChatContext?: string;
  /** 多人剧情角色列表；第一个角色仍作为 API、预设和语音绑定的主角色。 */
  participantIds?: string[];
  storyMemory?: {
    independent?: boolean;
    inheritRecentMemory?: boolean;
    startedAt?: string;
  };
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
  onPhase?: (phase: StoryGenerationPhase) => void;
};

function buildStorySettingsPrompt(
  settings: StoryCharacterSettings | undefined,
  userName: string,
  globalSettings?: StoryGlobalSettings,
  now = new Date(),
): string {
  if (!settings) return globalSettings?.timeAware !== false
    ? `本轮时间：${formatPromptTimestamp(now.toISOString()) || now.toLocaleString()}。` : "";
  const effective = settings || {};
  // 字数收敛到 50–10000：用户存 0/负数按 50 生效，超过 10000 按 10000 生效
  const minChars = Math.max(50, Math.min(10000, effective.minChars ?? 800));
  const maxChars = Math.max(minChars, Math.min(10000, effective.maxChars ?? 1500));
  const perspective = effective.userPerspective === "third"
    ? "使用第三人称称呼用户（TA/他/她，按用户设定选用）"
    : effective.userPerspective === "username"
      ? `使用用户名“${userName}”称呼用户`
      : "使用第二人称“你”称呼用户";
  // 方案定义统一存于公用仓库，角色设置只带“启用哪一个”的 id
  const { proseStyle, status, theater } = resolveActiveStorySchemes(effective);
  return [
    "# 当前剧情 APP 专属生成设置",
    effective.usePresetNarration ? "" : `正文长度以 ${minChars}—${maxChars} 字为目标；不得为了凑字数重复内容。`,
    effective.usePresetNarration ? "" : perspective + "。",
    // 新建方案 prompt 留空时不注入（避免出现“文风方案【xxx】：”这样的空行）
    effective.usePresetProseStyle ? "" : (proseStyle?.prompt?.trim() ? `正文文风方案【${proseStyle.name || "未命名文风"}】（仅约束写作风格，不是尾部输出格式）：${proseStyle.prompt.trim()}` : (effective.proseStyle ? `文风：${effective.proseStyle}。` : "")),
    effective.usePresetProseStyle || proseStyle?.prompt?.trim() ? "" : (effective.proseStylePrompt?.trim() || ""),
    effective.extraPrompt?.trim() || "",
    ...(effective.customPromptEntries || []).filter((item) => item.enabled && item.content.trim()).map((item) => `专属条目【${item.name || "未命名"}】：${item.content.trim()}`),
    globalSettings?.timeAware !== false ? `本轮时间：${formatPromptTimestamp(now.toISOString()) || now.toLocaleString()}。` : "",
    status?.prompt?.trim() || "",
    theater?.prompt?.trim() || "",
  ].filter(Boolean).join("\n");
}

export type StoryGenerationResult = {
  rawText: string;
  renderedText: string;
  storySummary: string;
  regexSignature: string;
  parserVersion: number;
  promptMessages: LLMMessage[];
  model: string;
  presetName: string;
};

export type StoryPreviewResult = {
  messages: LLMMessage[];
  characterName: string;
  model: string;
  presetName: string;
};

function escapeTagName(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripContextExcludedTags(text: string, excludedTags?: string): string {
  const tags = Array.from(new Set((excludedTags ?? DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS).split(",").map(t => t.trim()).filter(Boolean)));
  if (tags.length === 0) return text;

  const tagAlternation = tags.map(escapeTagName).join("|");
  const rx = new RegExp(`<(${tagAlternation})>[\\s\\S]*?<\\/\\1>`, "gi");
  return text.replace(rx, "").replace(/\n{3,}/g, "\n\n").trim();
}

function toHistoryMessage(message: StoryMessage, contextExcludedTags?: string): ChatMessage {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.contextRole || message.role,
    content: stripContextExcludedTags(message.rawContent, contextExcludedTags),
    status: "sent",
    createdAt: message.createdAt,
  };
}

function resolveStoryConfigs(characterId: string): {
  apiConfig: ApiConfig;
  preset: PresetConfig | null;
  regexes: RegexConfig[];
  worldBooks: WorldBookConfig[];
  regexSignature: string;
  summaryTag: string;
} {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }

  const bindings = loadBindingConfig();
  const activeSlot = resolveBinding(bindings, characterId, "story");
  if (!activeSlot.apiConfigId) {
    throw new ChatEngineError(`No API Configuration bound for ${character.name}. Please go to Settings -> 绑定管理 -> 剧情 to assign one.`);
  }

  const apiConfig = loadApiConfigs().find((config) => config.id === activeSlot.apiConfigId);
  if (!apiConfig) {
    throw new ChatEngineError(`API Configuration not found for ${character.name}.`);
  }

  const presets = loadPresets();
  let preset = activeSlot.presetId ? presets.find((item) => item.id === activeSlot.presetId) || null : null;
  if (!preset) {
    preset = presets.find((item) => item.builtIn) ?? null;
  }

  const allRegexes = loadRegexes();
  const charBinding = bindings.characterBindings.find((item) => item.characterId === characterId);
  const storyOverrideRegexIds = charBinding?.appOverrides.story?.regexIds;
  const regexIds = storyOverrideRegexIds && storyOverrideRegexIds.length > 0
    ? storyOverrideRegexIds
    : activeSlot.regexIds || [];
  const regexes = regexIds
    .map((id) => allRegexes.find((regex) => regex.id === id))
    .filter(Boolean) as RegexConfig[];

  const allWorldBooks = loadWorldBooks();
  const worldBooks = (activeSlot.worldBookIds || [])
    .map((id) => allWorldBooks.find((worldBook) => worldBook.id === id))
    .filter(Boolean) as WorldBookConfig[];
  const summaryTag = preset?.story_summary_tag?.trim() || "summary";

  return {
    apiConfig,
    preset,
    regexes,
    worldBooks,
    regexSignature: [...regexes.map((regex) => `${regex.id}:${regex.updatedAt}`), `summary:${summaryTag}`].join("|"),
    summaryTag,
  };
}

function mergeParticipantWorldBooks(base: WorldBookConfig[], participantIds?: string[]): WorldBookConfig[] {
  const ids = Array.from(new Set(participantIds || [])).filter(Boolean);
  if (ids.length <= 1) return base;
  const bindings = loadBindingConfig();
  const allWorldBooks = loadWorldBooks();
  const merged = new Map(base.map((book) => [book.id, book]));
  for (const id of ids) {
    const slot = resolveBinding(bindings, id, "story");
    for (const worldBookId of slot.worldBookIds || []) {
      const book = allWorldBooks.find((item) => item.id === worldBookId);
      if (book) merged.set(book.id, book);
    }
  }
  return [...merged.values()];
}

export function getStoryRenderSignature(characterId: string, foldTags?: string): { regexSignature: string; parserVersion: number; regexes: RegexConfig[] } {
  const { regexSignature, regexes } = resolveStoryConfigs(characterId);
  return {
    regexSignature: storyFoldSignature(regexSignature, foldTags),
    parserVersion: STORY_PARSER_VERSION,
    regexes,
  };
}

function checkEnsembleRequestBudget(characterId: string, participantIds: string[] | undefined, api: ApiConfig, preset: PresetConfig | null, messages: LLMMessage[]): void {
  const ids = new Set([characterId, ...(participantIds || [])]);
  if (loadCharacters().filter(character => ids.has(character.id)).length < 2) return;
  if (estimateStoryMessages(previewMessagesForApi(api, preset, messages)) > storyInputBudget(preset, loadMemoryConfig().storyContextTokenLimit)) {
    throw new ChatEngineError("多人剧情在请求转换后超过上下文预算，请缩减预设、世界书或本轮输入后重试。");
  }
}

export async function generateStoryCompletion(
  characterId: string,
  history: StoryMessage[],
  options?: StoryGenerationOptions,
): Promise<StoryGenerationResult> {
  options?.onPhase?.("preparing");
  await yieldStoryPreparation(options?.signal);
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }

  const { apiConfig, preset: resolvedPreset, regexes, worldBooks, regexSignature, summaryTag } = resolveStoryConfigs(characterId);
  const preset = selectStoryPresetPrompts(resolvedPreset, options?.settings?.enabledPresetPromptIds);
  const effectiveFoldTags = options?.sessionFoldTags?.trim() ?? DEFAULT_STORY_FOLD_TAGS;
  const effectiveContextExcludedTags = options?.sessionContextExcludedTags?.trim() ?? DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS;
  const llmMessages = await buildStoryPromptMessages(
    characterId,
    history,
    preset,
    regexes,
    worldBooks,
    effectiveContextExcludedTags,
    options?.settings,
    options?.globalSettings,
    options?.floatingChatContext,
    options?.participantIds,
    options?.storyMemory,
    options?.sessionId,
    options?.retryInstruction,
    options,
  );
  await yieldStoryPreparation(options?.signal);
  checkEnsembleRequestBudget(characterId, options?.participantIds, apiConfig, preset, llmMessages);
  throwIfStoryAborted(options?.signal);
  options?.onPhase?.("requesting");
  await yieldStoryPreparation(options?.signal);

  const userIdentity = resolveUserIdentity(characterId, "story");
  const macroEngine = new MacroEngine(character.name, userIdentity?.name ?? "用户");

  let rawOutput: string;
  if (options?.globalSettings?.streamingEnabled) {
    let receivedDelta = false;
    try {
      const streamed = await sendLLMStreamRequest(apiConfig, preset, llmMessages, regexes, {
        characterName: character.name,
      }, { skipOutputRegex: true, includeReasoning: true, appId: "story", appTags: ["story"], signal: options?.signal }, {
        onDelta: (text) => {
          receivedDelta = true;
          options.onDelta?.(text);
        },
        onReasoningDelta: () => { receivedDelta = true; },
      });
      rawOutput = streamed.content;
    } catch (error) {
      // 某些中转只是不支持 SSE：在尚未吐出任何正文时安全回退普通生成；
      // 已经吐过增量则不重试，避免一次操作生成两份互相不同的正文。
      if (receivedDelta || options.signal?.aborted) throw error;
      rawOutput = await sendLLMRequest(apiConfig, preset, llmMessages, regexes, {
        characterName: character.name,
      }, { skipOutputRegex: true, includeReasoning: true, appId: "story", appTags: ["story"], signal: options?.signal });
    }
  } else {
    rawOutput = await sendLLMRequestPreferStream(apiConfig, preset, llmMessages, regexes, {
      characterName: character.name,
    }, { skipOutputRegex: true, includeReasoning: true, appId: "story", appTags: ["story"], signal: options?.signal });
  }

  const parsed = parseStoryResponse(rawOutput, regexes, {
    summaryTag,
    foldTags: effectiveFoldTags,
    macroEngine,
    activeTags: ["story"],
  });
  return {
    rawText: parsed.rawText,
    renderedText: parsed.renderedText,
    storySummary: parsed.summaryText,
    regexSignature: storyFoldSignature(regexSignature, effectiveFoldTags),
    parserVersion: STORY_PARSER_VERSION,
    promptMessages: llmMessages,
    model: apiConfig.defaultModel,
    presetName: preset?.name || "默认预设",
  };
}

async function buildStoryPromptMessages(
  characterId: string,
  history: StoryMessage[],
  preset: PresetConfig | null,
  regexes: RegexConfig[],
  worldBooks: WorldBookConfig[],
  contextExcludedTags: string = DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS,
  settings?: StoryCharacterSettings,
  globalSettings?: StoryGlobalSettings,
  floatingChatContext?: string,
  participantIds?: string[],
  storyMemory?: StoryGenerationOptions["storyMemory"],
  sessionId?: string,
  retryInstruction?: string,
  preparation?: Pick<StoryGenerationOptions, "signal" | "onPhase">,
): Promise<LLMMessage[]> {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }

  const userIdentity = resolveUserIdentity(characterId, "story");
  const allCharacters = loadCharacters();
  const participantCharacters = Array.from(new Set([characterId, ...(participantIds || [])]))
    .map((id) => allCharacters.find((item) => item.id === id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const effectiveWorldBooks = mergeParticipantWorldBooks(worldBooks, participantCharacters.map((item) => item.id));
  const isEnsemble = participantCharacters.length > 1;
  const instructionHistory = prepareStoryInstructionHistory(history);
  const historyMessages = instructionHistory.history.map((message) => toHistoryMessage(message, contextExcludedTags));
  const historyIds = new Set(history.map(message => message.id));
  const historySessionId = sessionId || history[0]?.sessionId;
  const storedMessages = historySessionId ? loadStoryMessages(historySessionId) : [];
  const memConfig = loadMemoryConfig();
  const independent = Boolean(storyMemory?.independent);
  const timeAware = globalSettings?.timeAware !== false;
  const now = new Date();
  const finish = (messages: LLMMessage[]) => {
    const settingsPrompt = buildStorySettingsPrompt(settings, userIdentity?.name ?? "用户", globalSettings, now);
    if (independent) messages.push({ role: "system", content: "# 独立剧情隔离规则\n本分线只使用角色基础设定、已绑定世界书和本分线内已经发生的内容。不得读取或推断角色短期记忆、核心记忆、长期记忆、日程、关系网、住宅状态、线上私聊/群聊、悬浮小手机内容或其他剧情分线。世界书属于世界设定，仍然有效。" });
    if (settingsPrompt) messages.push({ role: "system", content: settingsPrompt });
    if (!independent && settings?.floatingPhoneInContext && floatingChatContext?.trim()) messages.push({ role: "system", content: `# 悬浮小手机最近线上聊天\n以下记录用于衔接线上与线下剧情，不要逐字复述：\n${floatingChatContext.trim()}` });
    const userControlPrompt = resolveStoryUserControlPrompt(settings).trim();
    if (userControlPrompt) messages.push({ role: "system", content: userControlPrompt });
    if (settings?.enforceVoiceFormat) {
      const prompt = (settings.voiceFormatPrompt ?? DEFAULT_STORY_VOICE_FORMAT_PROMPT).trim();
      if (prompt) messages.push({ role: "system", content: prompt });
    }
    const ending = resolveStoryUserControlEndingPrompt(settings).trim();
    if (ending) messages.push({ role: "system", content: ending });
    if (instructionHistory.directorInstruction.trim()) messages.push({ role: "user", content: wrapStoryInstruction(instructionHistory.directorInstruction), _debugMeta: { marker: "本轮导演指令" } });
    if (retryInstruction?.trim()) messages.push({ role: "user", content: wrapStoryRetryInstruction(retryInstruction), _debugMeta: { marker: "临时重试要求" } });
    return messages;
  };
  if (isEnsemble) {
    return buildEnsembleStoryPrompt({
      signal: preparation?.signal, onPhase: preparation?.onPhase,
      base: { character, history: historyMessages, preset, worldBooks: effectiveWorldBooks, regexes, userIdentity, appId: "story", timeAware },
      characters: participantCharacters, config: memConfig, independent,
      excludedMessageIds: [...new Set([...storedMessages.map(message => message.id), ...historyIds])],
      afterTimestamp: storyMemory?.inheritRecentMemory === false ? storyMemory.startedAt : undefined,
      tail: finish([]), queryInstruction: [instructionHistory.directorInstruction, retryInstruction].filter(Boolean).join("\n"),
      formatStoryMessage: message => toHistoryMessage(message, contextExcludedTags),
      cleanText: text => stripContextExcludedTags(text, contextExcludedTags),
      historySummaries: new Map(instructionHistory.history.filter(message => message.storySummary).map(message => [message.id, message.storySummary!])),
    });
  }
  const context = independent
    ? {
      recentBlocks: [],
      truncatedHistory: historyMessages,
      wbActivationContext: historyMessages.slice(-10).map((message) => message.content).join("\n"),
      unifiedRecentItems: [],
    }
    : prepareShortTermContext(characterId, "story", {
      userName: userIdentity?.name ?? "用户",
      history: historyMessages,
      // Current-page prose is already in history. Exclude its projections too,
      // including discarded retry suffixes, while retaining other pages' events.
      excludeStoryMessageIds: [...new Set([...storedMessages.map(message => message.id), ...historyIds])],
      afterTimestamp: storyMemory?.inheritRecentMemory === false ? storyMemory.startedAt : undefined,
      timeAware,
    });
  const { recentBlocks, truncatedHistory, wbActivationContext, unifiedRecentItems } = context;

  let memories: Awaited<ReturnType<typeof retrieveMemoriesForPrompt>> | null = null;
  let coreMemories: Awaited<ReturnType<typeof retrieveCoreMemoriesForPrompt>> | null = null;
  if (!independent) {
    [memories, coreMemories] = await Promise.all([
      retrieveMemoriesForPrompt(characterId, wbActivationContext, memConfig).catch(() => null),
      retrieveCoreMemoriesForPrompt(characterId, memConfig).catch(() => null),
    ]);
  }

  const messages = assemblePromptPayload({
    character,
    history: truncatedHistory,
    preset,
    worldBooks: effectiveWorldBooks,
    regexes,
    userIdentity,
    appId: "story",
    scheduleSummary: independent || isEnsemble ? undefined : buildCalendarScheduleMarker("character", characterId, getWeekStartIso(now)),
    currentSchedule: independent || isEnsemble ? undefined : getCurrentCalendarScheduleForPrompt("character", characterId, now),
    coreMemories: !isEnsemble && coreMemories ? formatCoreMemories(coreMemories) : "",
    longTermMemories: !isEnsemble && memories ? formatLongTermMemories(memories) : "",
    worldBookActivationContext: wbActivationContext,
    recentBlocks: isEnsemble ? [] : recentBlocks,
    unifiedRecentItems: isEnsemble ? [] : unifiedRecentItems,
    timeAware,
    characterRelations: independent || isEnsemble ? null : undefined,
    dwellingContext: independent || isEnsemble ? null : undefined,
  });
  return finish(messages);
}

export async function previewStoryPromptPayload(
  characterId: string,
  history: StoryMessage[],
  options?: StoryGenerationOptions,
): Promise<StoryPreviewResult> {
  const character = loadCharacters().find((item) => item.id === characterId);
  if (!character) {
    throw new ChatEngineError(`Character not found: ${characterId}`);
  }
  const { apiConfig, preset: resolvedPreset, regexes, worldBooks } = resolveStoryConfigs(characterId);
  const preset = selectStoryPresetPrompts(resolvedPreset, options?.settings?.enabledPresetPromptIds);
  const effectiveContextExcludedTags = options?.sessionContextExcludedTags?.trim() ?? DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS;
  const llmMessages = await buildStoryPromptMessages(characterId, history, preset, regexes, worldBooks, effectiveContextExcludedTags, options?.settings, options?.globalSettings, options?.floatingChatContext, options?.participantIds, options?.storyMemory, options?.sessionId, options?.retryInstruction);
  checkEnsembleRequestBudget(characterId, options?.participantIds, apiConfig, preset, llmMessages);
  return {
    messages: previewMessagesForApi(apiConfig, preset, llmMessages),
    characterName: character.name,
    model: apiConfig.defaultModel,
    presetName: preset?.name || "默认预设",
  };
}

export function rebuildStorySessionRenderCache(characterId: string, sessionId: string, options?: { sessionFoldTags?: string }): StoryMessage[] {
  const { regexSignature, parserVersion } = getStoryRenderSignature(characterId, options?.sessionFoldTags);
  const { regexes, summaryTag } = resolveStoryConfigs(characterId);
  const effectiveFoldTags = options?.sessionFoldTags?.trim() ?? DEFAULT_STORY_FOLD_TAGS;

  const character = loadCharacters().find((c) => c.id === characterId);
  const userIdentity = resolveUserIdentity(characterId, "story");
  const macroEngine = new MacroEngine(character?.name ?? "", userIdentity?.name ?? "用户");

  const rebuilt = loadStoryMessages(sessionId).map((message) => {
    if (message.role !== "assistant") {
      return {
        ...message,
        renderedContent: message.renderedContent || message.rawContent,
        regexSignature,
        parserVersion,
      };
    }
    const parsed = parseStoryResponse(message.rawContent, regexes, {
      summaryTag,
      foldTags: effectiveFoldTags,
      macroEngine,
      activeTags: ["story"],
    });
    return {
      ...message,
      renderedContent: parsed.renderedText,
      storySummary: parsed.summaryText,
      regexSignature,
      parserVersion,
    };
  });
  replaceStoryMessages(sessionId, rebuilt);
  return rebuilt;
}
