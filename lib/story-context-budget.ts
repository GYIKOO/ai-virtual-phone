import type { LLMMessage } from "./llm-prompt-assembler";
import type { PresetConfig } from "./settings-types";
import { estimateTokens } from "./token-counter";
import { selectRecentContext, compareMemoryTime, type ContextDetail } from "./memory-context-policy";

export type StoryBudgetKind = "recent" | "long" | "core";
export type StoryContextCandidate = {
  id: string;
  kind: StoryBudgetKind;
  owners: string[];
  timestamp: string;
  text: string;
  /** Existing summary, never a freshly invented replacement. */
  summary?: string;
  score?: number;
  narrative?: boolean;
  unitId?: string;
};
export type SelectedStoryContext = { candidate: StoryContextCandidate; text: string };

export function compareStoryTimes(a: string, b: string): number {
  return compareMemoryTime(a, b);
}

export function storyInputBudget(preset: PresetConfig | null, configuredLimit?: number): number {
  const limit = Number.isFinite(configuredLimit) && configuredLimit! > 0 ? configuredLimit! : 100000;
  const context = Number.isFinite(preset?.openai_max_context) && preset!.openai_max_context > 0
    ? Math.min(preset!.openai_max_context, limit) : limit;
  const output = Number.isFinite(preset?.openai_max_tokens) && preset!.openai_max_tokens > 0
    ? preset!.openai_max_tokens : 4096;
  // The app uses an estimator, not the provider's tokenizer. Leave additional headroom.
  return Math.max(0, Math.floor((context - output) * 0.85));
}

export function estimateStoryMessages(messages: LLMMessage[]): number {
  return 2 + messages.reduce((sum, message) => sum + 8 + (typeof message.content === "string"
    ? estimateTokens(message.content)
    : message.content.reduce((n, part) => n + (part.type === "text" ? estimateTokens(part.text) : 1536), 0)), 0);
}

/** IDs establish common provenance; identical words alone do not establish a shared memory. */
export function deduplicateStoryCandidates(candidates: StoryContextCandidate[]): StoryContextCandidate[] {
  const unique = new Map<string, StoryContextCandidate>();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.kind, candidate.id, candidate.text, candidate.summary ?? ""]);
    const previous = unique.get(key);
    if (previous) previous.owners = [...new Set([...previous.owners, ...candidate.owners])].sort();
    else unique.set(key, { ...candidate, owners: [...new Set(candidate.owners)].sort() });
  }
  return [...unique.values()];
}

function fairMemoryOrder(candidates: StoryContextCandidate[]): StoryContextCandidate[] {
  const queues = new Map<string, StoryContextCandidate[]>();
  for (const candidate of [...candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)
    || compareStoryTimes(b.timestamp, a.timestamp) || a.id.localeCompare(b.id))) {
    const owner = candidate.owners.join("\u0000");
    queues.set(owner, [...(queues.get(owner) ?? []), candidate]);
  }
  const result: StoryContextCandidate[] = [];
  // A participant with a huge archive cannot consume every other participant's recall quota.
  while ([...queues.values()].some(queue => queue.length)) {
    const heads = [...queues.values()].filter(queue => queue.length)
      .sort((a, b) => (b[0].score ?? 0) - (a[0].score ?? 0) || a[0].id.localeCompare(b[0].id));
    for (const queue of heads) result.push(queue.shift()!);
  }
  return result;
}

type StoryPackingOptions = {
  candidates: StoryContextCandidate[];
  inputBudget: number;
  limits: Record<StoryBudgetKind, number>;
  render: (selected: SelectedStoryContext[]) => LLMMessage[];
  detail?: ContextDetail;
};
type PackedStoryContext = { messages: LLMMessage[]; selected: SelectedStoryContext[]; estimatedTokens: number };

function* storyPackingSteps(options: StoryPackingOptions): Generator<void, PackedStoryContext> {
  const base = options.render([]);
  const baseTokens = estimateStoryMessages(base);
  if (baseTokens > options.inputBudget) {
    throw new Error(`角色设定、预设、世界书与本轮输入已超过上下文预算（估算 ${baseTokens} / ${options.inputBudget} tokens）。请缩减必需内容，或将预设上下文容量设为模型实际支持的数值。`);
  }
  const available = options.inputBudget - baseTokens;
  yield;
  const candidates = deduplicateStoryCandidates(options.candidates);
  const pools: Record<StoryBudgetKind, StoryContextCandidate[]> = {
    recent: candidates.filter(c => c.kind === "recent").sort((a, b) => compareStoryTimes(b.timestamp, a.timestamp) || a.id.localeCompare(b.id)),
    core: fairMemoryOrder(candidates.filter(c => c.kind === "core")),
    long: fairMemoryOrder(candidates.filter(c => c.kind === "long")),
  };
  const selected: SelectedStoryContext[] = [];
  const chosen = new Set<StoryContextCandidate>();
  const used = { recent: 0, core: 0, long: 0 };
  let total = 0;
  const costs = new Map<StoryContextCandidate, Map<string, number>>();
  const costOf = (candidate: StoryContextCandidate, text: string) => {
    let variants = costs.get(candidate);
    if (!variants) { variants = new Map(); costs.set(candidate, variants); }
    if (!variants.has(text)) variants.set(text, estimateTokens(text) + 32 + estimateTokens(candidate.owners.join("、")));
    return variants.get(text)!;
  };
  const take = function* (kind: StoryBudgetKind, allowance: number): Generator<void> {
    if (kind === "recent") {
      const room = Math.min(allowance - used[kind], available - total);
      if (room <= 0) return;
      const rows = selectRecentContext(pools.recent.filter(candidate => !chosen.has(candidate)), room, options.detail,
        (text, candidate) => costOf(candidate, text));
      for (const row of rows.reverse()) {
        const cost = costOf(row.candidate, row.text);
        selected.push(row); chosen.add(row.candidate); used.recent += cost; total += cost;
      }
      yield;
      return;
    }
    let visited = 0;
    for (const candidate of pools[kind]) {
      if (++visited % 128 === 0) yield;
      if (chosen.has(candidate)) continue;
      const room = Math.min(allowance - used[kind], available - total);
      const variants = [candidate.text, candidate.summary].filter((text): text is string => Boolean(text));
      const text = variants.find(value => costOf(candidate, value) <= room);
      if (!text) continue; // A large entry must not prevent smaller relevant entries from fitting.
      const cost = costOf(candidate, text);
      selected.push({ candidate, text }); chosen.add(candidate); used[kind] += cost; total += cost;
    }
  };
  yield* take("core", Math.min(options.limits.core, available * 0.15));
  yield* take("long", Math.min(options.limits.long, available * 0.25));
  yield* take("recent", Math.min(options.limits.recent, available - total));
  // Reuse spare space, while keeping each category's configured shared cap.
  for (const kind of ["core", "long", "recent"] as const) yield* take(kind, options.limits[kind]);
  yield;
  let messages = options.render(selected);
  // Count the actual assembled prompt, including wrappers, macros, preset and world books.
  while (estimateStoryMessages(messages) > options.inputBudget && selected.length) {
    yield;
    const removed = selected.pop()!;
    if (removed.candidate.unitId) {
      for (let i = selected.length - 1; i >= 0; i--) {
        if (selected[i].candidate.kind === removed.candidate.kind && selected[i].candidate.unitId === removed.candidate.unitId) selected.splice(i, 1);
      }
    }
    messages = options.render(selected);
  }
  return { messages, selected, estimatedTokens: estimateStoryMessages(messages) };
}

export function packStoryContext(options: StoryPackingOptions): PackedStoryContext {
  const steps = storyPackingSteps(options);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** Same selection algorithm, with cooperative checkpoints for the interactive generation path. */
export async function packStoryContextAsync(options: StoryPackingOptions, checkpoint: () => Promise<void>): Promise<PackedStoryContext> {
  const steps = storyPackingSteps(options);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    await checkpoint();
  }
}
