import { assemblePromptPayload, isContextMarkerEnabled, type AssemblerInput, type LLMMessage } from "./llm-prompt-assembler";
import { prepareShortTermContext, type UnifiedRecentItem } from "./short-term-assembler";
import { loadStoryRecallTurns, type StoryMessage } from "./story-storage";
import { resolveUserIdentity } from "./settings-storage";
import { createStoryMemoryRanker } from "./memory-service";
import { formatMemoryEntry, memoryEventRange } from "./memory-time";
import type { MemoryConfig } from "./memory-types";
import type { Character } from "./character-types";
import type { ChatMessage } from "./chat-storage";
import { getCurrentCalendarScheduleForPrompt, buildCalendarScheduleMarker } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";
import { formatCharactersRelationsForPrompt } from "./character-world-storage";
import { buildRelationMentionContext } from "./character-relation-context";
import { formatPromptTimestamp } from "./prompt-time";
import { packStoryContext, packStoryContextAsync, storyInputBudget, estimateStoryMessages, compareStoryTimes, type StoryContextCandidate, type SelectedStoryContext } from "./story-context-budget";
import { yieldStoryPreparation, throwIfStoryAborted, type StoryGenerationPhase } from "./story-preparation";
import { contextCapacity } from "./prompt-memory-budget";

type Candidate = StoryContextCandidate & {
  history?: ChatMessage[];
  sourceIds?: string[];
  sourceApp?: string;
  timelineSourceApp?: Extract<UnifiedRecentItem, { kind: "event" }>["sourceApp"];
  sourceTag?: string;
  macroRole?: "user" | "assistant";
  background?: "current" | "week";
};

/** The storage is still per character; only the scene's read/selection layer is shared. */
export async function buildEnsembleStoryPrompt(options: {
  base: AssemblerInput;
  characters: Character[];
  config: MemoryConfig;
  excludedMessageIds: string[];
  independent: boolean;
  afterTimestamp?: string;
  tail: LLMMessage[];
  queryInstruction?: string;
  formatStoryMessage: (message: StoryMessage) => ChatMessage;
  cleanText: (text: string) => string;
  historySummaries?: Map<string, string>;
  signal?: AbortSignal;
  onPhase?: (phase: StoryGenerationPhase) => void;
}): Promise<LLMMessage[]> {
  const { base, characters, config } = options;
  const ensemble = characters.length > 1;
  const marker = (name: string) => isContextMarkerEnabled(base.preset, name);
  const recentEnabled = marker("shortTermMemory") || marker("chatHistory");
  const now = new Date();
  const time = (timestamp: string) => base.timeAware === false ? "" : (formatPromptTimestamp(timestamp) || timestamp);
  const names = new Map(characters.map(character => [character.id, character.name]));
  const ownersLabel = (ids: string[]) => ids.map(id => names.get(id) || id).join("、");
  const excluded = new Set(options.excludedMessageIds);
  const currentHistory = base.history;
  // Keep the immediate exchange intact. Never discard the user's current input to fit memories.
  const mandatoryHistory = currentHistory.slice(-2);
  const candidates: Candidate[] = [];
  const contexts = new Map<string, ReturnType<typeof prepareShortTermContext>>();
  if (!options.independent && recentEnabled) {
    for (const character of characters) {
      await yieldStoryPreparation(options.signal);
      contexts.set(character.id, prepareShortTermContext(character.id, "story", {
        history: currentHistory, tokenBudget: 0,
        userName: resolveUserIdentity(character.id, "story")?.name ?? base.userIdentity?.name ?? "用户",
        excludeStoryMessageIds: options.excludedMessageIds,
        afterTimestamp: options.afterTimestamp, timeAware: base.timeAware,
      }));
    }
  }
  if (recentEnabled) {
    const renderedTurns = new Map<string, { fullText?: string; summary: string }>();
    // Older current-page prose competes once, not once per participant.
    for (const [index, message] of currentHistory.slice(0, -2).entries()) {
      candidates.push({ id: `history:${message.id}`, kind: "recent", owners: characters.map(c => c.id),
        timestamp: message.createdAt, text: message.content, history: [message], sourceIds: [message.id],
        summary: options.historySummaries?.get(message.id)
          ? `[${time(message.createdAt)} 剧情摘要]\n${options.cleanText(options.historySummaries.get(message.id)!)}` : undefined,
        sourceApp: "story", narrative: true,
        unitId: message.role === "user" && currentHistory[index + 1]?.role === "assistant"
          ? `history-turn:${currentHistory[index + 1].id}` : `history-turn:${message.id}` });
    }
    for (const character of characters) {
      await yieldStoryPreparation(options.signal);
      const context = contexts.get(character.id);
      if (!context) continue;
      // Projection eligibility comes from the existing native timeline's source filters.
      const events = context.unifiedRecentItems.filter((item): item is Extract<UnifiedRecentItem, { kind: "event" }> => item.kind === "event");
      const storyTurns = new Map(loadStoryRecallTurns(character.id, options.afterTimestamp).map(turn => [turn.id, turn]));
      for (const event of events) {
        const turn = event.entryId ? storyTurns.get(event.entryId) : undefined;
        if (turn?.messages.some(message => excluded.has(message.id))) continue;
        const turnKey = turn?.id;
        if (turn && turnKey && !renderedTurns.has(turnKey)) {
          renderedTurns.set(turnKey, {
            fullText: turn.messages.map(message => {
              const rendered = options.formatStoryMessage(message);
              return `[${time(message.createdAt)} ${message.role === "user" ? "用户发言" : "剧情正文"}]\n${rendered.content}`;
            }).join("\n\n"),
            summary: options.cleanText(turn.summary).trim(),
          });
        }
        const { fullText, summary } = (turnKey && renderedTurns.get(turnKey)) || { summary: "" };
        candidates.push({
          id: event.entryId || `${character.id}:${event.sourceTag}:${event.timestamp}:${event.text}`,
          kind: "recent", owners: [character.id], timestamp: event.timestamp,
          text: fullText || event.narrativeText || event.text,
          summary: summary ? `[${time(event.timestamp)} 剧情摘要]\n${summary}` : (fullText || event.narrativeText ? event.text : undefined),
          narrative: !!(turn || event.narrativeText),
          sourceIds: turn?.messages.map(message => message.id), sourceApp: event.sourceApp,
          sourceTag: event.sourceTag,
          timelineSourceApp: event.sourceApp,
          macroRole: turn || event.narrativeText ? "assistant" : event.dialogueRole,
        });
      }
    }
  }
  // Resolve each card's {{char}} before the scene's lead-character macro pass.
  const cardText = (character: Character, text: string) => text.replace(/\{\{\s*char\s*\}\}/gi, () => character.name);
  const roster = characters.map(character => `角色资料：${character.name}\n${cardText(character, character.persona || "")}`).join("\n\n");
  const personalities = characters.filter(character => character.personality?.trim())
    .map(character => `角色性格：${character.name}\n${cardText(character, character.personality!)}`).join("\n\n");
  const knowledgeRule = "以下记忆按角色归属提供，用于呈现各自的认知、动机与反应。角色之间的信息传递以剧情中实际发生的交流和经历为依据。多位角色共有的来源只展示一次，各自的个人理解仍按归属呈现。";
  const relationCache = new Map<string, string>();
  const enabledLimit = (value: number | undefined) => Number.isFinite(value) && value! >= 0 ? value! : 100000;
  const limits = { recent: Math.max(0, (enabledLimit(config.shortTermTokenBudget) || 100000) - estimateStoryMessages(mandatoryHistory)), long: enabledLimit(config.longTermTokenBudget), core: enabledLimit(config.coreMemoryTokenBudget) };
  const render = (selected: SelectedStoryContext[]) => {
    const chosen = selected as { candidate: Candidate; text: string }[];
    const history = [...mandatoryHistory, ...chosen.flatMap(item => item.text === item.candidate.text ? item.candidate.history || [] : [])]
      .sort((a, b) => compareStoryTimes(a.createdAt, b.createdAt) || a.id.localeCompare(b.id));
    const memoryText = (kind: "long" | "core") => chosen.filter(item => item.candidate.kind === kind && !item.candidate.background)
      .sort((a,b)=>compareStoryTimes(a.candidate.timestamp,b.candidate.timestamp))
      .map(item => ensemble ? `【记忆归属：${ownersLabel(item.candidate.owners)}；来源：${item.candidate.sourceApp || "个人记忆"}】\n${item.text}` : item.text).join("\n\n");
    const events: UnifiedRecentItem[] = chosen.filter(item => item.candidate.kind === "recent" && (!item.candidate.history || item.text !== item.candidate.text))
      .map(item => ({ kind: "event", entryId: item.candidate.id, timestamp: item.candidate.timestamp,
        sourceApp: item.candidate.timelineSourceApp || "story", sourceTag: item.candidate.sourceTag || "recent_events",
        text: ensemble ? `【记录归属：${ownersLabel(item.candidate.owners)}；来源：${item.candidate.sourceApp || "日程与关系"}】\n${item.text}` : item.text }));
    const unified: UnifiedRecentItem[] = [...events, ...history.map((message, historyIndex) => ({ kind: "history" as const, historyIndex, timestamp: message.createdAt }))]
      .sort((a, b) => compareStoryTimes(a.timestamp, b.timestamp));
    // Macro references use only selected material and retain provenance. A shared
    // narrative is a scene record, not a private utterance attributed to its lead.
    const references = [
      ...history.filter(message => message.role === "user" || message.role === "assistant").map(message => ({
        timestamp: message.createdAt, role: message.role, current: true,
        text: `[${time(message.createdAt)} 当前分页·${message.role === "user" ? "用户输入" : "剧情正文"}]\n${message.content}`,
      })),
      ...chosen.filter(item => item.candidate.kind === "recent" && !item.candidate.history && item.candidate.macroRole).map(item => ({
        timestamp: item.candidate.timestamp, role: item.candidate.macroRole, current: false,
        text: `[${time(item.candidate.timestamp)} ${item.candidate.narrative ? "剧情记录" : "聊天记录"}；相关角色：${ownersLabel(item.candidate.owners)}]\n${item.text}`,
      })),
    ].sort((a,b) => compareStoryTimes(a.timestamp,b.timestamp) || Number(a.current)-Number(b.current));
    const historyMacroContext = recentEnabled ? {
      // The user's actual current-page input remains the generation request.
      lastUserMessage: references.filter(row => row.current && row.role === "user").at(-1)?.text || "",
      lastCharMessage: references.filter(row => row.role === "assistant").at(-1)?.text || "",
      lastMessage: references.at(-1)?.text || "",
    } : undefined;
    const schedules = chosen.filter(item => item.candidate.background);
    const scheduleText = (items: typeof chosen) => items.map(item => `角色：${ownersLabel(item.candidate.owners)}\n${item.text}`).join("\n\n");
    let relations = "";
    if (!options.independent && marker("characterRelations")) {
      const mentionText = buildRelationMentionContext(currentHistory.map(message => message.content), [
        ...chosen.filter(item => !item.candidate.background && !item.candidate.history).map(item => item.text),
        options.queryInstruction || "",
      ]);
      if (!relationCache.has(mentionText)) relationCache.set(mentionText, formatCharactersRelationsForPrompt(characters.map(character => character.id), {
        appId: "story", mentionText,
        userIdentityIds: base.userIdentity === undefined ? undefined : base.userIdentity ? [base.userIdentity.id] : [],
        describedCharacterIds: characters.map(character => character.id),
      }));
      relations = relationCache.get(mentionText)!;
    }
    return [...assemblePromptPayload({ ...base, history,
      worldBookActivationContext: query,
      historyMacroContext,
      recentBlocks: events.length ? [{ tag: "recent_events", content: events.map(item => item.kind === "event" ? item.text : "").join("\n\n") }] : [],
      unifiedRecentItems: unified,
      coreMemories: memoryText("core"), longTermMemories: memoryText("long"),
      markerContentOverrides: ensemble ? { ...base.markerContentOverrides,
        charDescription: `# 多人见面剧情\n${roster}\n${knowledgeRule}`, charPersonality: personalities } : base.markerContentOverrides,
      scheduleSummary: scheduleText(schedules), currentSchedule: scheduleText(schedules.filter(item => item.candidate.background === "current")),
      characterRelations: options.independent ? null : ensemble ? relations : undefined,
      dwellingContext: options.independent || ensemble ? null : undefined,
    }), ...options.tail];
  };
  // A page is a view of the chronology, not the retrieval clock. Reserve recent
  // narrative anchors as well as recent chat so a burst of online bubbles cannot
  // erase the scene from the query. This only bounds retrieval text, not history.
  const queryRows = [...new Map<string, { id: string; timestamp: string; text: string; narrative?: boolean }>([
    ...candidates.filter(c => c.kind === "recent").map(c => [c.id, c] as const),
    ...currentHistory.map(message => [`history:${message.id}`, {
      id: `history:${message.id}`, timestamp: message.createdAt, text: message.content, narrative: true,
    }] as const),
  ]).values()].sort((a,b) => compareStoryTimes(a.timestamp,b.timestamp));
  const localAnchorIds = new Set(currentHistory.slice(-2).map(message => `history:${message.id}`));
  const queryAnchors = new Set([
    ...queryRows.slice(-10), ...queryRows.filter(row => row.narrative && !row.id.startsWith("history:")).slice(-3),
    ...queryRows.filter(row => localAnchorIds.has(row.id)),
  ]);
  const query = [
    ...queryRows.filter(row => queryAnchors.has(row)).map(row => `[${time(row.timestamp)}]\n${row.text.slice(-800)}`),
    options.queryInstruction?.slice(-4000),
  ].filter(Boolean).join("\n");
  const inputBudget = storyInputBudget(base.preset, contextCapacity(config));
  // Fail before embedding calls if immutable material alone cannot fit.
  packStoryContext({ candidates: [], inputBudget, limits, render });
  if (!options.independent) {
    options.onPhase?.("recalling");
    await yieldStoryPreparation(options.signal);
    const rankMemory = createStoryMemoryRanker(query, config, options.signal);
    // Bound concurrent storage reads. Results are consumed in the original participant/type order.
    for (let offset = 0; offset < characters.length; offset += 4) {
      const batch = characters.slice(offset, offset + 4);
      const rankedBatch = await Promise.all(batch.map(async character => ({
        character,
        core: marker("memoryCore") ? await rankMemory(character.id, "core") : [],
        long: marker("memoryLongTerm") ? await rankMemory(character.id, "long_term") : [],
      })));
      for (const { character, core, long } of rankedBatch) {
        await yieldStoryPreparation(options.signal);
        for (const [type, kind, enabled] of [
          ["core", "core", marker("memoryCore")], ["long_term", "long", marker("memoryLongTerm")],
        ] as const) {
          if (!enabled) continue;
          const ranked = type === "core" ? core : long;
          for (const { entry, score } of ranked) {
            const sources = [...new Set(entry.sourceMessageIds || [])].sort();
            // Exact source + content identity can share storage projections; distinct interpretations stay distinct.
            const identity = sources.length ? `${sources.join("|")}:${entry.content}` : `${character.id}:${entry.id}`;
            candidates.push({ id: `${kind}:${identity}`, kind, owners: [character.id],
              timestamp: Number.isFinite(memoryEventRange(entry)?.end ?? Date.parse(entry.createdAt))
                ? new Date(memoryEventRange(entry)?.end ?? Date.parse(entry.createdAt)).toISOString() : "",
              text: base.timeAware === false ? entry.content : formatMemoryEntry(entry, now.getTime()),
              score, sourceApp: entry.sourceApp, sourceIds: sources });
          }
        }
        const currentSchedule = marker("calendarSchedule") ? getCurrentCalendarScheduleForPrompt("character", character.id, now) : "";
        const weekSchedule = marker("calendarSchedule") ? buildCalendarScheduleMarker("character", character.id, getWeekStartIso(now)) : "";
        for (const [key, text, score] of [["current", currentSchedule, 2], ["week", weekSchedule, 0]] as const) {
          if (text) candidates.push({ id: `life:${character.id}:${key}`, kind: "core", owners: [character.id],
            timestamp: now.toISOString(), text, sourceApp: "日程", score, background: key });
        }
      }
    }
  }
  options.onPhase?.("preparing");
  await yieldStoryPreparation(options.signal);
  throwIfStoryAborted(options.signal);
  let lastYield = Date.now();
  return (await packStoryContextAsync({ candidates, inputBudget, limits, render, detail: config.recentContextDetail }, async () => {
    throwIfStoryAborted(options.signal);
    if (Date.now() - lastYield >= 8) {
      await yieldStoryPreparation(options.signal);
      lastYield = Date.now();
    }
  })).messages;
}
