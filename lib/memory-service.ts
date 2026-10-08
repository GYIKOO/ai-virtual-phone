// lib/memory-service.ts
// High-level memory orchestration: retrieve long-term memories for prompt injection.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { loadMemoryEntriesByType } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity } from "./memory-embedding";
import { estimateTokens } from "./token-counter";
import { knownAt } from "./proactive-replay";
import { formatMemoryEntry, memoryEventRange } from "./memory-time";

/**
 * Retrieve relevant long-term memories for prompt injection.
 * Strategy:
 *   1. Total tokens <= longTermTokenBudget → return all
 *   2. Over budget + embedding API configured → vector-rank, fill until budget
 *   3. Over budget + no embedding → time-sorted (newest first), fill until budget
 * Embedding API is resolved from auxiliary binding (global, not per-character).
 */
export async function retrieveMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig,
    asOf?: number,
): Promise<MemoryEntry[]> {
    const longTermEntries = (await loadMemoryEntriesByType(characterId, "long_term")).filter(entry => knownAt(entry.createdAt, asOf, entry.updatedAt));
    if (longTermEntries.length === 0 || !currentContext.trim()) return [];

    const budget = config.longTermTokenBudget;
    const referenceAt = asOf ?? Date.now();

    // Calculate total tokens for all entries
    let totalTokens = 0;
    for (const entry of longTermEntries) {
        totalTokens += estimateTokens(formatMemoryEntry(entry, referenceAt)) + 4;
    }

    // Strategy 1: all fit within budget → return all
    if (totalTokens <= budget) {
        return longTermEntries;
    }

    // Strategy 2: vector recall enabled + embedding API configured → vector search, fill by relevance
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        const queryEmbedding = await generateEmbedding(currentContext, embeddingApiConfig);
        if (queryEmbedding) {
            const withEmbeddings = longTermEntries.filter(m => m.embedding && m.embedding.length > 0);
            if (withEmbeddings.length > 0) {
                const scored = withEmbeddings.map(entry => ({
                    entry,
                    score: cosineSimilarity(queryEmbedding, entry.embedding!),
                }));
                scored.sort((a, b) => b.score - a.score);
                return fillByBudget(scored.map(s => s.entry), budget, referenceAt);
            }
        }
    }

    // Strategy 3: no embedding support → newest first, fill by budget
    const sorted = [...longTermEntries].sort(
        (a, b) => (memoryEventRange(b)?.end ?? Date.parse(b.createdAt)) - (memoryEventRange(a)?.end ?? Date.parse(a.createdAt))
    );
    return fillByBudget(sorted, budget, referenceAt);
}

export async function retrieveCoreMemoriesForPrompt(
    characterId: string,
    config: MemoryConfig,
    asOf?: number,
): Promise<MemoryEntry[]> {
    const coreEntries = (await loadMemoryEntriesByType(characterId, "core")).filter(entry => knownAt(entry.createdAt, asOf, entry.updatedAt));
    if (coreEntries.length === 0) return [];

    const sorted = [...coreEntries].sort((a, b) => {
        const aActive = a.metadata?.active ? 1 : 0;
        const bActive = b.metadata?.active ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        const aDate = memoryEventRange(a)?.end ?? Date.parse(String(a.metadata?.eventDate ?? a.updatedAt ?? a.createdAt));
        const bDate = memoryEventRange(b)?.end ?? Date.parse(String(b.metadata?.eventDate ?? b.updatedAt ?? b.createdAt));
        return bDate - aDate;
    });

    return fillByBudget(sorted, config.coreMemoryTokenBudget, asOf ?? Date.now());
}

/** Pick entries in order until token budget is exhausted. */
function fillByBudget(entries: MemoryEntry[], budget: number, referenceAt: number): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    let used = 0;
    for (const entry of entries) {
        const tokens = estimateTokens(formatMemoryEntry(entry, referenceAt)) + 4;
        if (used + tokens > budget) break;
        result.push(entry);
        used += tokens;
    }
    return result;
}
