// lib/memory-summarizer.ts
// Auto-summarization engine: summarizes short-term events into long-term memories.
// Trigger: every N events (configurable). Short-term events are NOT deleted after summarization.

import type { MemoryEntry } from "./memory-types";
import { DEFAULT_SUMMARIZATION_PROMPT } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntries,
    saveMemoryEntries,
    deleteMemoryEntries,
    getEventCounter,
    resetEventCounter,
    getLastSummarizedTimestamp,
    setLastSummarizedTimestamp,
    incrementCoreMemoryCounter,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { loadNativeTimeline, formatTimelineForSummarization, filterTimelineByAllowedSources } from "./short-term-assembler";
import { generateEmbedding, resolveEmbeddingModel } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";
import { maybeRunCoreMemoryPipeline } from "./core-memory-builder";
import { assertNoMemoryRebuild, withMemoryWriterLock } from "./memory-writer-lock";
import { groupMemoryRounds } from "./memory-rounds";
import { protectedMemory, planRebuildBatches, rebuildPrompt, selectRebuildSources } from "./memory-rebuild-policy";

/** Per-character lock to prevent concurrent summarization. */
const summarizingSet = new Set<string>();

/**
 * Check if summarization should run based on event counter, then execute.
 * Trigger: counter >= summarizationEventInterval.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function maybeRunSummarization(
    characterId: string,
    characterName: string
): Promise<void> {
    const config = loadMemoryConfig();
    if (!config.autoSummarizeEnabled) return;

    const last = getLastSummarizedTimestamp(characterId);
    const rounds = config.summarizationRoundInterval;
    const counter = rounds === undefined ? getEventCounter(characterId) : groupMemoryRounds(filterTimelineByAllowedSources(
        loadNativeTimeline(characterId),config.shortTermAllowedSources)).filter(entry=>!last||Date.parse(entry.timestamp)>Date.parse(last)).length;
    if (counter < (rounds ?? config.summarizationEventInterval)) return;

    if (summarizingSet.has(characterId)) return;
    summarizingSet.add(characterId);
    try {
        await runSummarizationPipeline(characterId, characterName, {automatic:true});
    } finally {
        summarizingSet.delete(characterId);
    }
}

/**
 * Run the full summarization pipeline.
 * Reads events since last summarization, summarizes them, saves as long-term memory.
 * Does NOT delete short-term events — they are only trimmed by token budget elsewhere.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function runSummarizationPipeline(
    characterId: string,
    characterName: string,
    options?: {
        force?: boolean;
        automatic?: boolean;
        /** 手动指定总结起点（覆盖进度水位线）；force 为真时忽略 */
        sinceTimestamp?: string;
    }
): Promise<{ success: boolean; error?: string }> {
    try {
        const result = await withMemoryWriterLock(characterId, async () => {
            await assertNoMemoryRebuild(characterId);
            return runSummarizationUnlocked(characterId, characterName, options);
        });
        if (result.success) await maybeRunCoreMemoryPipeline(characterId, characterName);
        return result;
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
}

async function runSummarizationUnlocked(characterId: string, characterName: string, options?: { force?: boolean; sinceTimestamp?: string; automatic?: boolean }): Promise<{ success: boolean; error?: string }> {
    const config = loadMemoryConfig();

    // Resolve API from auxiliary binding
    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }

    // Read native app data (chat messages, moments) directly — no separate event log
    const afterTimestamp = options?.force
        ? undefined
        : options?.sinceTimestamp ?? (getLastSummarizedTimestamp(characterId) ?? undefined);
    // 记忆来源开关同样作用于长期总结：被关掉的来源不进总结素材。
    // 进度水位线取「过滤后」最后一条的时间，因此关掉的来源不会把水位线推过头，
    // 但已被水位线越过的内容重新打开后也不会回补——这一点在设置里已注明。
    const readSources = () => filterTimelineByAllowedSources(
        loadNativeTimeline(characterId, config.summarizationRoundInterval === undefined && afterTimestamp ? { afterTimestamp } : undefined),
        config.shortTermAllowedSources,
    );
    const native = readSources();
    let allEntries = config.summarizationRoundInterval === undefined ? native
        : groupMemoryRounds(native).filter(entry=>!afterTimestamp||Date.parse(entry.timestamp)>Date.parse(afterTimestamp));
    if (options?.automatic && config.summarizationRoundInterval !== undefined) {
        const interval=config.summarizationRoundInterval;
        const selected=new Set(selectRebuildSources(allEntries.map(entry=>({...entry,key:entry.id,sourceApp:entry.sourceApp as MemoryEntry["sourceApp"]})),interval,interval).selected.map(entry=>entry.key));
        allEntries=allEntries.filter(entry=>selected.has(entry.id));
    }

    if (allEntries.length < (config.summarizationRoundInterval === undefined ? 4 : 1)) {
        if (!options?.force) resetEventCounter(characterId);
        return { success: false, error: allEntries.length === 0 ? "没有可总结的事件" : "事件不足 4 条" };
    }

    const formatted = formatTimelineForSummarization(allEntries, {timeAware:true});
    if (!formatted) return { success: false, error: "格式化事件数据失败" };

    const latest = formatted.latest;
    const promptTemplate = config.summarizationPrompt?.trim() || DEFAULT_SUMMARIZATION_PROMPT;
    const sourceById = new Map(allEntries.map(entry=>[entry.id,entry]));
    const batches = planRebuildBatches(allEntries.map(entry=>({
        key:entry.id, timestamp:new Date(entry.startTimestamp||entry.timestamp).toISOString(), endTimestamp:new Date(entry.timestamp).toISOString(),
        content:entry.content,sourceApp:entry.sourceApp as MemoryEntry["sourceApp"],sessionId:entry.sessionId||entry.dialogueSessionId,
    })),config.summarizationRoundInterval??config.summarizationEventInterval,8000,promptTemplate,characterName);
    const generated: MemoryEntry[] = [];
    for (const batch of batches) {
        const result = await simpleLLMCall(apiConfig,[{role:"user",content:rebuildPrompt(promptTemplate,characterName,batch)}],
            {temperature:.3,label:"记忆总结·"+characterName});
        if (!result.content?.trim() || result.wasTruncated) return {success:false,error:result.wasTruncated
            ? "本批总结被截断，未保存本次总结或推进进度，请调整模型输出设置后重试。" : result.error||"总结未返回有效内容"};
        const summary=result.content.trim();
        let embedding: number[] | undefined;
        const embeddingApi=config.vectorRecallEnabled?resolveAuxiliaryApiConfig("embeddingApiConfigId"):null;
        if (embeddingApi && resolveEmbeddingModel(embeddingApi)) {
            try { embedding=(await generateEmbedding(summary,embeddingApi,{timeoutMs:10000}))??undefined; } catch { /* keyword recall remains available */ }
        }
        const origins=batch.map(source=>sourceById.get(source.key)!);
        const start=batch.map(source=>source.timestamp).sort()[0];
        const end=batch.map(source=>source.endTimestamp||source.timestamp).sort().at(-1)!;
        const sourceCounts=new Map<string,number>();
        for (const entry of origins) sourceCounts.set(entry.sourceApp,(sourceCounts.get(entry.sourceApp)||0)+1);
        const dominant=[...sourceCounts].sort((a,b)=>b[1]-a[1])[0]?.[0]||"chat";
        const now=new Date().toISOString();
        generated.push({
            id:"mem_lt_"+Date.now()+"_"+Math.random().toString(36).slice(2,8),characterId,
            sourceApp:dominant as MemoryEntry["sourceApp"],type:"long_term",content:summary,embedding,importance:.8,
            createdAt:now,updatedAt:now,
            sourceMessageIds:[...new Set(origins.flatMap(entry=>entry.sourceEntryIds||[entry.id]))],
            metadata:{summarizedEvents:new Set(batch.map(source=>source.key)).size,eventStartAt:start,eventEndAt:end,
                timeSpan:start+" ~ "+end,sourceSessionIds:[...new Set(batch.flatMap(source=>source.sessionId?[source.sessionId]:[]))]},
        });
    }
    // Editing or deleting source history while a model is working must not commit stale memories.
    const currentNative = readSources();
    const current = new Map((config.summarizationRoundInterval === undefined ? currentNative : groupMemoryRounds(currentNative))
        .map(entry => [entry.id, entry]));
    const snapshot = (entry: typeof allEntries[number] | undefined) => entry && JSON.stringify([
        entry.id, entry.timestamp, entry.startTimestamp, entry.content, entry.sourceEntryIds,
    ]);
    if (allEntries.some(entry => snapshot(entry) !== snapshot(current.get(entry.id)))) {
        return {success:false,error:"总结期间原始记录已变化，本次结果未保存，进度保持不变。请重新总结。"};
    }
    // All generated text is committed together; failed/truncated batches cannot advance the watermark.
    await saveMemoryEntries(generated);

    // Update last summarized timestamp + reset counter
    setLastSummarizedTimestamp(characterId, latest);
    resetEventCounter(characterId);

    // Enforce long-term limit
    const allLongTerm = (await loadMemoryEntries(characterId)).filter(entry=>entry.type==="long_term" && !protectedMemory(entry));
    if (allLongTerm.length > config.maxLongTermEntries) {
        const excess = allLongTerm.slice(0, allLongTerm.length - config.maxLongTermEntries);
        await deleteMemoryEntries(excess.map(e => e.id));
    }

    for (const _entry of generated) incrementCoreMemoryCounter(characterId);

    console.log(`[MemorySummarizer] Summarized ${allEntries.length} entries → ${generated.length} long-term memories`);
    return { success: true };
}
