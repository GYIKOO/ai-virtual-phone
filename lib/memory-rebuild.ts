import { loadCharacters } from "./character-storage";
import { loadNativeTimeline, filterTimelineByAllowedSources } from "./short-term-assembler";
import { loadMemoryConfig, loadMemoryEntries, getLastSummarizedTimestamp, getLastCoreSummarizedTimestamp } from "./memory-storage";
import { DEFAULT_SUMMARIZATION_PROMPT, DEFAULT_CORE_MEMORY_PROMPT, type MemoryEntry } from "./memory-types";
import { loadApiConfigs, resolveAuxiliaryApiConfig } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";
import { generateEmbedding, resolveEmbeddingModel } from "./memory-embedding";
import { formatMemoryEntry } from "./memory-time";
import { blocksMemorySummary, planRebuildBatches, protectedMemory, rebuildPrompt, type RebuildJob, type RebuildBatch, type RebuildSource } from "./memory-rebuild-policy";
import { readRebuildJob, readRebuildBatches, writeRebuildJob, swapRebuild, discardRebuild, reconcileRebuildProgress } from "./memory-rebuild-store";
import { withMemoryWriterLock } from "./memory-writer-lock";

export const MEMORY_REBUILD_UPDATED = "memory-rebuild-updated";
const running = new Set<string>();
const paused = new Set<string>();
export function isMemoryRebuildRunning(characterId: string): boolean { return running.has(characterId); }
const notify = () => { if (typeof window !== "undefined") window.dispatchEvent(new Event(MEMORY_REBUILD_UPDATED)); };
const apiIdentity = (api: NonNullable<ReturnType<typeof resolveAuxiliaryApiConfig>>) => ({ id: api.id, provider: api.provider, baseUrl: api.baseUrl, defaultModel: api.defaultModel });
function getPinnedApi(identity: RebuildJob["api"]) {
    const api = loadApiConfigs().find(a => a.id === identity.id);
    if (!api || JSON.stringify(apiIdentity(api)) !== JSON.stringify(identity)) throw new Error("此任务使用的 API 配置或模型已改变。请恢复原配置后继续；密钥可以更新，已保存批次不会丢失。");
    return api;
}
function sourcesFor(characterId: string, allowed: RebuildJob["allowedSources"], cutoff?: string): RebuildSource[] {
    return filterTimelineByAllowedSources(loadNativeTimeline(characterId, {
        timeAware: true, promptTimestampOptions: { timeZone: "UTC", includeTimeZone: true },
    }), allowed).map(e => ({
        key: JSON.stringify([e.sourceApp, e.sourceDetail, e.sessionId, e.id]),
        // Native timeline also includes legacy map/custom-app source names, as does the existing summarizer.
        timestamp: new Date(e.timestamp).toISOString(), content: e.content, sourceApp: e.sourceApp as MemoryEntry["sourceApp"], sessionId: e.sessionId,
    })).filter(e => !cutoff || e.timestamp <= cutoff).sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.key.localeCompare(b.key));
}
async function fingerprint(value: unknown): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
export type RebuildOptions = { batchSize: number; inputTokens: number; includeCore: boolean };
export type RebuildPreview = { characterName: string; sourceCount: number; batchCount: number; first: string; last: string; protectedCount: number; model: string; sources: string[]; hash: string; sourceHash: string };
export async function previewMemoryRebuild(characterId: string, options: RebuildOptions): Promise<RebuildPreview> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("找不到该角色，未开始重建。");
    const config = loadMemoryConfig();
    const sources = sourcesFor(characterId, config.shortTermAllowedSources);
    if (!sources.length) throw new Error("该角色没有符合当前来源设置的可用历史记录。");
    const api = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!api) throw new Error("请先绑定记忆总结 API。");
    const plan = planRebuildBatches(sources, options.batchSize, options.inputTokens, config.summarizationPrompt?.trim() || DEFAULT_SUMMARIZATION_PROMPT, character.name);
    const existing = await loadMemoryEntries(characterId);
    const baseline = existing.filter(e => e.type === "long_term" || options.includeCore);
    const retainedCount = existing.filter(e => protectedMemory(e) || (!options.includeCore && e.type === "core")).length;
    // Core batch count depends on generated text; reserve at least its count-based minimum.
    const minimumCoreCount = options.includeCore ? Math.ceil(plan.length / config.coreSummarizationInterval) : 0;
    if (plan.length + retainedCount + minimumCoreCount > config.maxLongTermEntries) throw new Error(`预计至少生成 ${plan.length} 条长期记忆，加上保留记忆及核心记忆后超过现有数量上限。请增大每批记录数或调整记忆上限。`);
    const sourceHash = await fingerprint(sources);
    const hash = await fingerprint({ sourceHash, options, api: apiIdentity(api), prompt: config.summarizationPrompt,
        corePrompt: config.coreMemoryPrompt, coreInterval: config.coreSummarizationInterval, vector: config.vectorRecallEnabled,
        embedding: config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId")?.id : null, name: character.name });
    return { characterName: character.name, sourceCount: sources.length, batchCount: plan.length, first: sources[0].timestamp,
        last: sources.at(-1)!.timestamp, protectedCount: baseline.filter(protectedMemory).length, model: api.defaultModel,
        sources: [...new Set(sources.map(s => s.sourceApp))], hash, sourceHash };
}
/** Called only after the character-scoped warning has been confirmed. No API calls yet. */
export async function createMemoryRebuild(characterId: string, options: RebuildOptions, confirmedHash: string): Promise<void> {
    await withMemoryWriterLock(characterId, async () => {
        if (await readRebuildJob(characterId)) throw new Error("已有重建任务或回退副本，请先继续任务或确认清理副本。");
        const preview = await previewMemoryRebuild(characterId, options);
        if (preview.hash !== confirmedHash) throw new Error("预览后历史记录、模型或总结设置已改变，请重新预览并确认。");
        const config = loadMemoryConfig();
        const sources = sourcesFor(characterId, config.shortTermAllowedSources);
        if (await fingerprint(sources) !== preview.sourceHash) throw new Error("历史记录正在变化，请稍后重新确认。");
        const api = resolveAuxiliaryApiConfig("memorySummaryApiConfigId")!;
        const embedding = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
        const id = crypto.randomUUID();
        const prompt = config.summarizationPrompt?.trim() || DEFAULT_SUMMARIZATION_PROMPT;
        const chunks = planRebuildBatches(sources, options.batchSize, options.inputTokens, prompt, preview.characterName);
        const job: RebuildJob = { version: 1, id, characterId, characterName: preview.characterName, status: "paused",
            createdAt: new Date().toISOString(), cutoff: preview.last, ...options, coreBatchSize: config.coreSummarizationInterval,
            sourceCount: sources.length, sourceHash: preview.sourceHash, allowedSources: config.shortTermAllowedSources,
            prompt, corePrompt: config.coreMemoryPrompt?.trim() || DEFAULT_CORE_MEMORY_PROMPT, api: apiIdentity(api),
            ...(embedding && resolveEmbeddingModel(embedding) ? { embeddingApi: apiIdentity(embedding) } : {}),
            baseline: (await loadMemoryEntries(characterId)).filter(e => e.type === "long_term" || options.includeCore),
            beforeProgress: { longTerm: getLastSummarizedTimestamp(characterId), core: getLastCoreSummarizedTimestamp(characterId) },
            longBatches: chunks.length, totalBatches: chunks.length, completed: 0, corePlanned: !options.includeCore };
        await writeRebuildJob(job, chunks.map((sources, index) => ({ id: `${id}:${index}`, jobId: id, index, type: "long_term", sources })));
    }, true);
    notify();
}
export function pauseMemoryRebuild(characterId: string): void {
    paused.add(characterId);
    // Also reaches the owner when the task runs in another tab.
    if (typeof BroadcastChannel !== "undefined") { const channel = new BroadcastChannel("float-memory-rebuild"); channel.postMessage({ pause: characterId }); channel.close(); }
    notify();
}
export async function runMemoryRebuild(characterId: string): Promise<void> {
    await withMemoryWriterLock(characterId, async () => {
        let job = await reconcileRebuildProgress(characterId);
        if (!job || !blocksMemorySummary(job) || job.status === "ready") return;
        if (!loadCharacters().some(c => c.id === characterId)) throw new Error("角色已不存在，已保留任务，未继续调用 API。");
        getPinnedApi(job.api);
        if (job.embeddingApi) getPinnedApi(job.embeddingApi);
        let batches = await readRebuildBatches(job.id);
        if (batches.length !== job.totalBatches || job.version !== 1) throw new Error("任务数据不完整或格式不兼容，不能继续。");
        running.add(characterId); paused.delete(characterId);
        const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("float-memory-rebuild") : undefined;
        if (channel) channel.onmessage = event => { if (event.data?.pause === characterId) paused.add(characterId); };
        try {
            job.status = "running"; job.error = undefined;
            await writeRebuildJob(job); notify();
            while (!paused.has(characterId)) {
                if (job.completed === job.totalBatches) {
                    if (job.includeCore && !job.corePlanned) {
                        const sources = batches.filter(b => b.type === "long_term").map(b => ({
                            key: b.result!.id, timestamp: String(b.result!.metadata!.eventStartAt), endTimestamp: String(b.result!.metadata!.eventEndAt),
                            content: formatMemoryEntry(b.result!, Date.parse(job!.createdAt)), sourceApp: b.result!.sourceApp,
                        }));
                        const chunks = planRebuildBatches(sources, job.coreBatchSize, job.inputTokens, job.corePrompt, job.characterName);
                        const core: RebuildBatch[] = chunks.map((sources, i) => ({ id: `${job!.id}:${job!.longBatches + i}`, jobId: job!.id, index: job!.longBatches + i, type: "core", sources }));
                        job.corePlanned = true; job.totalBatches += core.length; batches.push(...core);
                        await writeRebuildJob(job, core); notify();
                        continue;
                    }
                    job.status = "ready"; await writeRebuildJob(job); break;
                }
                const batch = batches[job.completed];
                if (!batch.result) {
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 180_000);
                    let response;
                    try {
                        response = await simpleLLMCall(getPinnedApi(job.api), [{ role: "user", content: rebuildPrompt(batch.type === "core" ? job.corePrompt : job.prompt, job.characterName, batch.sources) }],
                            { temperature: .3, signal: controller.signal, label: `记忆重建·${job.characterName}·${batch.index + 1}` });
                    } finally { clearTimeout(timeout); }
                    if (!response.content?.trim() || response.wasTruncated) throw new Error(response.wasTruncated ? "本批总结被截断，未推进进度。请检查模型输出设置后重试。" : response.error || "本批未返回有效总结，请重试。");
                    const times = batch.sources.map(s => s.timestamp).sort();
                    let start = times[0], end = times.at(-1)!;
                    if (batch.type === "core") {
                        const origins = batch.sources.map(s => batches.find(b => b.result?.id === s.key)?.result).filter((e): e is MemoryEntry => !!e);
                        start = origins.map(e => String(e.metadata!.eventStartAt)).sort()[0];
                        end = origins.map(e => String(e.metadata!.eventEndAt)).sort().at(-1)!;
                    }
                    const now = new Date().toISOString();
                    batch.result = { id: `mem_rebuild_${job.id}_${batch.index}`, characterId, type: batch.type,
                        sourceApp: batch.sources[0].sourceApp, content: response.content.trim(), importance: batch.type === "core" ? .95 : .8,
                        createdAt: now, updatedAt: now,
                        metadata: { origin: "history_rebuild", rebuildJobId: job.id, eventStartAt: start, eventEndAt: end, timeSpan: `${start} ~ ${end}`,
                            sourceKeys: [...new Set(batch.sources.map(s => s.key))],
                            sourceSessionIds: [...new Set(batch.sources.flatMap(s => s.sessionId ? [s.sessionId] : []))] } };
                    // Persist paid text before optional embedding. Retrying embeddings never regenerates it.
                    await writeRebuildJob(job, [batch]);
                }
                if (job.embeddingApi && batch.type === "long_term" && !batch.embeddingDone) {
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    try {
                        const embedding = await Promise.race([generateEmbedding(batch.result.content, getPinnedApi(job.embeddingApi)),
                            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("向量生成超时；文字已保存，继续时只重试向量。")), 60_000); })]);
                        if (!embedding) throw new Error("向量生成失败；文字已保存，继续时只重试向量。");
                        batch.result.embedding = embedding; batch.embeddingDone = true;
                    } finally { clearTimeout(timer); }
                }
                job.completed++;
                await writeRebuildJob(job, [batch]); notify();
            }
            if (job.status === "running") { job.status = "paused"; await writeRebuildJob(job); }
        } catch (error) {
            // In-memory progress may be ahead of a failed transaction: recover
            // the last DURABLE checkpoint before writing the error status.
            const durable = await readRebuildJob(characterId);
            if (durable?.id === job.id) {
                durable.status = "failed"; durable.error = error instanceof Error ? error.message : String(error);
                await writeRebuildJob(durable);
            }
        } finally { channel?.close(); running.delete(characterId); paused.delete(characterId); notify(); }
    }, true);
}
export async function applyMemoryRebuild(characterId: string, expectedJobId: string): Promise<void> {
    await withMemoryWriterLock(characterId, async () => {
        const job = await readRebuildJob(characterId);
        if (!job || job.id !== expectedJobId || job.status !== "ready") throw new Error("任务已变化，请刷新。");
        if (!loadCharacters().some(c => c.id === characterId)) throw new Error("角色已不存在，未启用记忆。");
        if (await fingerprint(sourcesFor(characterId, job.allowedSources, job.cutoff)) !== job.sourceHash) throw new Error("任务范围内的历史记录已被编辑、删除或补入，已停止启用。旧记忆和重建结果仍保留，请核对后重新建立任务。");
        await swapRebuild(expectedJobId, characterId, false, loadMemoryConfig().maxLongTermEntries);
    }, true);
    notify();
}
export async function rollbackMemoryRebuild(characterId: string, expectedJobId: string): Promise<void> {
    await withMemoryWriterLock(characterId, async () => {
        await reconcileRebuildProgress(characterId);
        await swapRebuild(expectedJobId, characterId, true, Infinity);
    }, true);
    notify();
}
export async function discardMemoryRebuild(characterId: string, expectedJobId: string): Promise<void> {
    await withMemoryWriterLock(characterId, async () => {
        await reconcileRebuildProgress(characterId);
        await discardRebuild(characterId, expectedJobId);
    }, true);
    notify();
}
