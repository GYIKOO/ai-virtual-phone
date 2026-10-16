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
import { formatCharacterRelationsForPrompt } from "./character-world-storage";
import { formatPromptTimestamp } from "./prompt-time";
import { packStoryContext, storyInputBudget, estimateStoryMessages, compareStoryTimes, type StoryContextCandidate, type SelectedStoryContext } from "./story-context-budget";

type Candidate = StoryContextCandidate & {
  history?: ChatMessage[];
  sourceIds?: string[];
  sourceApp?: string;
  background?: boolean;
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
}): Promise<LLMMessage[]> {
  const { base, characters, config } = options;
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
  if (!options.independent) {
    for (const character of characters) {
      contexts.set(character.id, prepareShortTermContext(character.id, "story", {
        history: currentHistory, tokenBudget: 0,
        userName: resolveUserIdentity(character.id, "story")?.name ?? base.userIdentity?.name ?? "用户",
        excludeStoryMessageIds: options.excludedMessageIds,
        afterTimestamp: options.afterTimestamp, timeAware: base.timeAware,
      }));
    }
  }
  if (recentEnabled) {
    // Older current-page prose competes once, not once per participant.
    for (const message of currentHistory.slice(0, -2)) {
      candidates.push({ id: `history:${message.id}`, kind: "recent", owners: characters.map(c => c.id),
        timestamp: message.createdAt, text: message.content, history: [message], sourceIds: [message.id],
        summary: options.historySummaries?.get(message.id)
          ? `[${time(message.createdAt)} 剧情摘要]\n${options.cleanText(options.historySummaries.get(message.id)!)}` : undefined,
        sourceApp: "story" });
    }
    for (const character of characters) {
      const context = contexts.get(character.id);
      if (!context) continue;
      // Projection eligibility comes from the existing native timeline's source filters.
      const events = context.unifiedRecentItems.filter((item): item is Extract<UnifiedRecentItem, { kind: "event" }> => item.kind === "event");
      const storyTurns = new Map(loadStoryRecallTurns(character.id, options.afterTimestamp).map(turn => [turn.id, turn]));
      for (const event of events) {
        const turn = event.entryId ? storyTurns.get(event.entryId) : undefined;
        if (turn?.messages.some(message => excluded.has(message.id))) continue;
        const fullText = turn?.messages.map(message => {
          const rendered = options.formatStoryMessage(message);
          return `[${time(message.createdAt)} ${message.role === "user" ? "用户发言" : "剧情正文"}]\n${rendered.content}`;
        }).join("\n\n");
        const summary = turn ? options.cleanText(turn.summary).trim() : "";
        candidates.push({
          id: event.entryId || `${character.id}:${event.sourceTag}:${event.timestamp}:${event.text}`,
          kind: "recent", owners: [character.id], timestamp: event.timestamp,
          text: fullText || event.text,
          summary: summary ? `[${time(event.timestamp)} 剧情摘要]\n${summary}` : undefined,
          sourceIds: turn?.messages.map(message => message.id), sourceApp: event.sourceApp,
        });
      }
    }
  }
  const roster = characters.map((character, index) => [
    `## ${character.name}`,
    // The lead character is already described by the base preset's markers.
    index > 0 && marker("charDescription") ? character.persona?.trim() : "",
    index > 0 && marker("charPersonality") ? character.personality?.trim() : "",
  ].filter(Boolean).join("\n")).join("\n\n");
  const knowledgeRule = "以下记忆按角色归属提供，用于呈现各自的认知、动机与反应。角色之间的信息传递以剧情中实际发生的交流和经历为依据。多位角色共有的来源只展示一次，各自的个人理解仍按归属呈现。";
  const rosterMessage: LLMMessage = { role: "system", content: `# 多人见面剧情\n${roster}\n${knowledgeRule}` };
  const enabledLimit = (value: number | undefined) => Number.isFinite(value) && value! >= 0 ? value! : 100000;
  const limits = { recent: Math.max(0, (enabledLimit(config.shortTermTokenBudget) || 100000) - estimateStoryMessages(mandatoryHistory)), long: enabledLimit(config.longTermTokenBudget), core: enabledLimit(config.coreMemoryTokenBudget) };
  const render = (selected: SelectedStoryContext[]) => {
    const chosen = selected as { candidate: Candidate; text: string }[];
    const history = [...mandatoryHistory, ...chosen.flatMap(item => item.text === item.candidate.text ? item.candidate.history || [] : [])]
      .sort((a, b) => compareStoryTimes(a.createdAt, b.createdAt) || a.id.localeCompare(b.id));
    const memoryText = (kind: "long" | "core") => chosen.filter(item => item.candidate.kind === kind && !item.candidate.background)
      .map(item => `【记忆归属：${ownersLabel(item.candidate.owners)}；来源：${item.candidate.sourceApp || "个人记忆"}】\n${item.text}`).join("\n\n");
    const events: UnifiedRecentItem[] = chosen.filter(item => item.candidate.kind === "recent" && (!item.candidate.history || item.text !== item.candidate.text))
      .map(item => ({ kind: "event", entryId: item.candidate.id, timestamp: item.candidate.timestamp,
        sourceApp: "story", sourceTag: "recent_events",
        text: `【记录归属：${ownersLabel(item.candidate.owners)}；来源：${item.candidate.sourceApp || "日程与关系"}】\n${item.text}` }));
    const unified: UnifiedRecentItem[] = [...events, ...history.map((message, historyIndex) => ({ kind: "history" as const, historyIndex, timestamp: message.createdAt }))]
      .sort((a, b) => compareStoryTimes(a.timestamp, b.timestamp));
    const background: LLMMessage[] = chosen.filter(item => item.candidate.background).map(item => ({ role: "system",
      content: `【${ownersLabel(item.candidate.owners)}：日程与关系】\n${item.text}` }));
    return [...assemblePromptPayload({ ...base, history,
      worldBookActivationContext: query,
      recentBlocks: events.length ? [{ tag: "recent_events", content: events.map(item => item.kind === "event" ? item.text : "").join("\n\n") }] : [],
      unifiedRecentItems: unified,
      coreMemories: memoryText("core"), longTermMemories: memoryText("long"),
      scheduleSummary: undefined, currentSchedule: undefined, characterRelations: null, dwellingContext: null,
    }), rosterMessage, ...background, ...options.tail];
  };
  // Retrieval is anchored in the current scene, not separately in each character's unrelated last chat.
  const scene = currentHistory.slice(-8).map(message => message.content).join("\n");
  const query = [scene.slice(-12000), options.queryInstruction?.slice(-4000)].filter(Boolean).join("\n")
    || candidates.filter(c => c.kind === "recent").sort((a, b) => compareStoryTimes(a.timestamp, b.timestamp)).slice(-5).map(c => c.summary || c.text).join("\n").slice(-12000);
  const inputBudget = storyInputBudget(base.preset, config.storyContextTokenLimit);
  // Fail before embedding calls if immutable material alone cannot fit.
  packStoryContext({ candidates: [], inputBudget, limits, render });
  if (!options.independent) {
    const rankMemory = createStoryMemoryRanker(query, config);
    for (const character of characters) {
      for (const [type, kind, enabled] of [
        ["core", "core", marker("memoryCore")], ["long_term", "long", marker("memoryLongTerm")],
      ] as const) {
        if (!enabled) continue;
        const ranked = await rankMemory(character.id, type);
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
      const relations = marker("characterRelations") ? formatCharacterRelationsForPrompt(character.id) : "";
      for (const [key, text, score] of [["current", currentSchedule, 2], ["relations", relations, 1], ["week", weekSchedule, 0]] as const) {
        if (text) candidates.push({ id: `life:${character.id}:${key}`, kind: "core", owners: [character.id],
          timestamp: now.toISOString(), text, sourceApp: "日程与关系", score, background: true });
      }
    }
  }
  return packStoryContext({ candidates, inputBudget, limits, render }).messages;
}
