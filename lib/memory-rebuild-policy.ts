import type { MemoryEntry } from "./memory-types";
import type { ApiConfig } from "./settings-types";
import { estimateTokens } from "./token-counter";

export type RebuildSource = { key: string; timestamp: string; endTimestamp?: string; content: string; sourceApp: MemoryEntry["sourceApp"]; sessionId?: string };
export type RebuildBatch = { id: string; jobId: string; index: number; type: "long_term" | "core"; sources: RebuildSource[]; result?: MemoryEntry; embeddingDone?: boolean };
export type RebuildJob = {
    characterId: string; characterName: string; id: string; version: 1;
    status: "paused" | "running" | "failed" | "ready" | "applied" | "rolled_back";
    createdAt: string; cutoff: string; batchSize: number; inputTokens: number; includeCore: boolean; coreBatchSize: number;
    // Optional for compatibility with tasks created before tail deferral was introduced.
    summarizedThrough?: string; deferredCount?: number; autoSummaryInterval?: number; appliedCounterDelta?: number;
    sourceCount: number; sourceHash: string; allowedSources: import("./memory-types").MemoryConfig["shortTermAllowedSources"];
    prompt: string; corePrompt: string; api: Pick<ApiConfig, "id" | "provider" | "baseUrl" | "defaultModel">;
    embeddingApi?: Pick<ApiConfig, "id" | "provider" | "baseUrl" | "defaultModel">;
    baseline: MemoryEntry[]; beforeProgress: { longTerm: string | null; core: string | null };
    longBatches: number; totalBatches: number; completed: number; corePlanned: boolean;
    error?: string; warning?: string;
    progressPending?: { longTerm: string | null; core: string | null; counterAdjustment?: { id: string; delta: number } };
};
/** Choose whole records BEFORE token splitting; a technical chunk is not a new event. */
export function selectRebuildSources(sources: RebuildSource[], batchSize: number, autoInterval: number): { selected: RebuildSource[]; deferred: RebuildSource[] } {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000 || !Number.isInteger(autoInterval) || autoInterval < 1) throw new Error("重建批量或自动总结阈值无效。");
    const remainder = sources.length % batchSize;
    let count = remainder > 0 && remainder < autoInterval ? sources.length - remainder : sources.length;
    // The existing incremental reader uses timestamp > watermark. Never split
    // a same-timestamp group across that boundary, or its tail would be skipped.
    while (count > 0 && count < sources.length && sources[count - 1].timestamp === sources[count].timestamp) count--;
    return { selected: sources.slice(0, count), deferred: sources.slice(count) };
}
export function protectedMemory(entry: MemoryEntry): boolean {
    return entry.metadata?.origin === "user_manual" || entry.metadata?.origin === "user_edited" || entry.metadata?.editedByUser === true || entry.id.includes("_manual_");
}
export function memorySnapshot(entries: MemoryEntry[]): string {
    return JSON.stringify([...entries].sort((a, b) => a.id.localeCompare(b.id)));
}
export function rebuildPrompt(template: string, name: string, sources: RebuildSource[]): string {
    const times = sources.map(s => s.timestamp).sort();
    const ends = sources.map(s => s.endTimestamp ?? s.timestamp).sort();
    const events = sources.map(s => `- [来源记录时间 UTC：${s.timestamp}${s.endTimestamp ? ` ～ ${s.endTimestamp}` : ""}] ${s.content}`).join("\n");
    const values: Record<string, string> = { char: name, earliest: times[0] ?? "未知", latest: ends.at(-1) ?? "未知", events, longtermmemories: events };
    return template.replace(/\{\{(char|earliest|latest|events|longTermMemories)\}\}/gi, (_match, key: string) => values[key.toLowerCase()]);
}
/** Count is a maximum; the complete rendered prompt also has a bounded input budget. */
export function planRebuildBatches(sources: RebuildSource[], size: number, maxTokens: number, template: string, name: string): RebuildSource[][] {
    if (!Number.isInteger(size) || size < 1 || size > 1000 || !Number.isInteger(maxTokens) || maxTokens < 1024 || maxTokens > 64000) throw new Error("每批记录数须为 1–1000，输入预算须为 1024–64000 tokens。");
    if (estimateTokens(rebuildPrompt(template, name, [])) + 8 >= maxTokens) throw new Error("总结提示词本身已超过输入预算，请提高预算或缩短提示词。");
    const fits = (items: RebuildSource[]) => estimateTokens(rebuildPrompt(template, name, items)) + 8 <= maxTokens;
    const pieces: RebuildSource[] = [];
    for (const source of sources) {
        if (!Number.isFinite(Date.parse(source.timestamp))) throw new Error("历史记录含无效时间，已停止规划，避免为记忆编造日期。");
        let text = source.content;
        // Split unusually long records, preserving source identity and time, never truncate.
        while (!fits([{ ...source, content: text }])) {
            const chars = Array.from(text);
            let lo = 0, hi = chars.length;
            while (lo < hi) {
                const mid = Math.ceil((lo + hi) / 2);
                if (fits([{ ...source, content: chars.slice(0, mid).join("") }])) lo = mid; else hi = mid - 1;
            }
            if (!lo) throw new Error("单条记录的时间标记已超过输入预算。");
            let part = chars.slice(0, lo).join("");
            const paragraph = part.lastIndexOf("\n");
            if (paragraph > part.length / 2) part = part.slice(0, paragraph + 1);
            pieces.push({ ...source, content: part });
            text = text.slice(part.length);
        }
        if (text || !source.content) pieces.push({ ...source, content: text });
    }
    const batches: RebuildSource[][] = [];
    let batch: RebuildSource[] = [];
    for (const source of pieces) {
        if (batch.length && (batch.length >= size || !fits([...batch, source]))) { batches.push(batch); batch = []; }
        batch.push(source);
    }
    if (batch.length) batches.push(batch);
    return batches;
}
export function blocksMemorySummary(job: RebuildJob | undefined): boolean {
    return !!job && job.status !== "applied" && job.status !== "rolled_back";
}
