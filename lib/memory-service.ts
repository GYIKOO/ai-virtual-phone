import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { loadMemoryEntries } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity, keywordSearch } from "./memory-embedding";
import { estimateTokens } from "./token-counter";
import { knownAt } from "./proactive-replay";
import { formatMemoryEntry, memoryEventRange } from "./memory-time";
import { throwIfStoryAborted } from "./story-preparation";

const eventTime = (entry: MemoryEntry) => memoryEventRange(entry)?.end ?? Date.parse(entry.createdAt);

/** Shared retrieval policy; one request may share its query vector across participants. */
export function createStoryMemoryRanker(query: string, config: MemoryConfig, signal?: AbortSignal, asOf?: number) {
    let vector: Promise<number[] | null> | undefined;
    const reads = new Map<string, Promise<MemoryEntry[]>>();
    return async (characterId: string, type: "long_term" | "core") => {
        throwIfStoryAborted(signal);
        if (!reads.has(characterId)) reads.set(characterId, loadMemoryEntries(characterId));
        const entries = (await reads.get(characterId)!).filter(entry => entry.type === type && knownAt(entry.createdAt, asOf, entry.updatedAt));
        throwIfStoryAborted(signal);
        if (type === "core") return entries.sort((a,b) => Number(!!b.metadata?.active) - Number(!!a.metadata?.active)
            || eventTime(b)-eventTime(a) || a.id.localeCompare(b.id)).map((entry,index)=>({entry,score:1/(index+1)}));
        // Continuous recent summaries bridge scene changes independently of semantic matches.
        const continuous = [...entries].sort((a,b)=>eventTime(b)-eventTime(a)||a.id.localeCompare(b.id)).slice(0,3);
        const continuousIds = new Set(continuous.map(entry=>entry.id));
        const older = entries.filter(entry=>!continuousIds.has(entry.id));
        const keywordScores = new Map(keywordSearch(query, older, older.length).map(hit => [hit.entry.id, hit.score]));
        let queryVector: number[] | null = null;
        if (older.length && query.trim() && config.vectorRecallEnabled && older.some(entry => entry.embedding?.length)) {
            const api = resolveAuxiliaryApiConfig("embeddingApiConfigId");
            if (api && resolveEmbeddingModel(api)) {
                vector ??= generateEmbedding(query, api, {signal,timeoutMs:10000}).catch(() => {
                    throwIfStoryAborted(signal); return null;
                });
                queryVector = await vector;
                throwIfStoryAborted(signal);
            }
        }
        const recalled = older.map(entry => {
            const keyword = keywordScores.get(entry.id) ?? 0;
            const compatible = queryVector && entry.embedding?.length === queryVector.length;
            const semantic = compatible ? Math.max(0, cosineSimilarity(queryVector!,entry.embedding!)) : 0;
            return {entry,score:Math.max(keyword,semantic),relevant:keyword>0||semantic>=.25};
        }).filter(hit=>hit.relevant).sort((a,b)=>b.score-a.score||eventTime(b.entry)-eventTime(a.entry)||a.entry.id.localeCompare(b.entry.id)).slice(0,12);
        return [...continuous.map((entry,index)=>({entry,score:2+(3-index)/10})),...recalled];
    };
}

export async function retrieveMemoriesForPrompt(characterId: string, currentContext: string, config: MemoryConfig, asOf?: number): Promise<MemoryEntry[]> {
    const ranked = await createStoryMemoryRanker(currentContext, config, undefined, asOf)(characterId,"long_term");
    return fillByBudget(ranked.map(hit=>hit.entry),config.longTermTokenBudget,asOf??Date.now());
}

export async function retrieveCoreMemoriesForPrompt(characterId: string, config: MemoryConfig, asOf?: number): Promise<MemoryEntry[]> {
    const ranked = await createStoryMemoryRanker("",config,undefined,asOf)(characterId,"core");
    return fillByBudget(ranked.map(hit=>hit.entry),config.coreMemoryTokenBudget,asOf??Date.now());
}

function fillByBudget(entries: MemoryEntry[], budget: number, referenceAt: number): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    let used = 0;
    for (const entry of entries) {
        const tokens = estimateTokens(formatMemoryEntry(entry,referenceAt))+4;
        if (used+tokens>budget) continue;
        result.push(entry); used+=tokens;
    }
    return result.sort((a,b)=>eventTime(a)-eventTime(b)||a.id.localeCompare(b.id));
}
