import type { AssemblerInput, GroupAssemblerInput, LLMMessage } from "./llm-prompt-assembler";
import type { MemoryConfig } from "./memory-types";
import type { UnifiedRecentItem } from "./short-term-assembler";
import { packStoryContext, storyInputBudget, estimateStoryMessages, type StoryContextCandidate } from "./story-context-budget";
import { compareMemoryTime } from "./memory-context-policy";

export function contextCapacity(config: MemoryConfig): number | undefined {
  return config.contextTokenLimit ?? config.storyContextTokenLimit;
}

type Input = AssemblerInput | GroupAssemblerInput;
type Candidate = StoryContextCandidate & { historyIndex?: number; event?: Extract<UnifiedRecentItem, { kind: "event" }>; member?: number };
export type PromptMemoryPart = {id:string; timestamp:string; text:string; kind:"core"|"long"};

/** Fit complete source units, never substring-edit a rendered prompt or tool protocol. */
export function assembleBudgetedMemory<T extends Input>(input: T, assemble: (value: T) => LLMMessage[], config: MemoryConfig, memoryParts?: PromptMemoryPart[][]): LLMMessage[] {
  const original = assemble(input);
  const inputBudget = storyInputBudget(input.preset, contextCapacity(config));
  if (estimateStoryMessages(original) <= inputBudget) return original;
  const group = "members" in input;
  const owners = group ? input.members.map(m => m.character.id) : [input.character.id];
  // Tool histories are indivisible here. Their protocol already has its own pruning rules.
  const toolHistory = input.history.some(m => m.role === "tool" || m.mediaType === "tool_call" || m.mediaType === "tool_result");
  let lastUser = -1;
  for (let i = input.history.length - 1; i >= 0; i--) if (input.history[i].role === "user") { lastUser = i; break; }
  const protectedStart = toolHistory ? 0 : lastUser >= 0 ? lastUser : Math.max(0, input.history.length - 1);
  const mandatory = input.history.slice(protectedStart);
  const candidates: Candidate[] = [];
  const narrative = input.appTags?.includes("offline") === true;
  for (const [index, message] of input.history.slice(0, protectedStart).entries()) {
    candidates.push({ id: `history:${message.id}`, kind: "recent", owners, timestamp: message.createdAt,
      text: message.content, historyIndex: index, narrative, summary: narrative ? message.contextSummary : undefined,
      unitId: `${message.sessionId}:${message.responseRoundId || message.responseBatchId || message.id}` });
  }
  for (const event of input.unifiedRecentItems || []) if (event.kind === "event") {
    candidates.push({ id: event.entryId || JSON.stringify([event.sourceTag,event.timestamp,event.text]), kind: "recent", owners,
      timestamp: event.timestamp, text: event.text, summary: event.summaryText, narrative: !!event.narrativeText, event });
  }
  if (!input.unifiedRecentItems?.length && "recentBlocks" in input) {
    for (const [index, block] of (input.recentBlocks || []).entries()) if (block.content.trim()) {
      candidates.push({ id: `block:${index}`, kind: "recent", owners, timestamp: "", text: block.content,
        event: {kind:"event",timestamp:"",sourceApp:"chat",sourceTag:block.tag,text:block.content} });
    }
  }
  const members: {coreMemories?: string; longTermMemories?: string}[] = "members" in input
    ? (input as GroupAssemblerInput).members : [input as AssemblerInput];
  for (const [member, data] of members.entries()) for (const kind of ["core", "long"] as const) {
    const parts = memoryParts?.[member]?.filter(part=>part.kind===kind);
    if (parts) {
      for (const part of parts) candidates.push({...part,id:`${member}:${part.id}`,owners:[owners[member]],member});
      continue;
    }
    const content = kind === "core" ? data.coreMemories : data.longTermMemories;
    if (content?.trim()) candidates.push({id:`${kind}:${member}`,kind,owners:[owners[member]],timestamp:"",text:content,member});
  }
  const render = (chosen: {candidate: StoryContextCandidate; text: string}[]) => {
    const rows = chosen as {candidate:Candidate;text:string}[];
    const history = [...mandatory,...rows.flatMap(r=>r.candidate.historyIndex === undefined ? [] : [{...input.history[r.candidate.historyIndex],content:r.text}])]
      .sort((a,b)=>compareMemoryTime(a.createdAt,b.createdAt) || (a.order ?? 0)-(b.order ?? 0));
    const events = rows.flatMap(r=>r.candidate.event ? [{...r.candidate.event,text:r.text}] : []);
    const unifiedRecentItems: UnifiedRecentItem[] = [...events,...history.map((m,historyIndex)=>({kind:"history" as const,historyIndex,timestamp:m.createdAt}))]
      .sort((a,b)=>compareMemoryTime(a.timestamp,b.timestamp));
    const memory = (member: number, kind: "core" | "long") => rows.filter(r=>r.candidate.member===member&&r.candidate.kind===kind)
      .sort((a,b)=>compareMemoryTime(a.candidate.timestamp,b.candidate.timestamp)).map(r=>r.text).join("\n\n");
    const next = {...input,history,unifiedRecentItems,recentBlocks:[],
      ...(group ? {members:input.members.map((m,i)=>({...m,coreMemories:memory(i,"core"),longTermMemories:memory(i,"long")}))}
        : {coreMemories:memory(0,"core"),longTermMemories:memory(0,"long")}) };
    return assemble(next as T);
  };
  return packStoryContext({candidates,inputBudget,render,detail:config.recentContextDetail,
    limits:{recent:config.shortTermTokenBudget > 0 ? config.shortTermTokenBudget : inputBudget,
      core:config.coreMemoryTokenBudget ?? inputBudget,long:config.longTermTokenBudget ?? inputBudget}}).messages;
}
