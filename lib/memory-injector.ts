// lib/memory-injector.ts
// Formats long-term memory entries into injectable prompt text.

import type { MemoryEntry } from "./memory-types";
import { formatMemoryEntry } from "./memory-time";
import { resolvePromptTimeAware } from "./prompt-time";

/**
 * Format long-term memories for prompt injection.
 * The service layer already handles token-budget filtering,
 * so this just formats the selected entries.
 */
export function formatLongTermMemories(memories: MemoryEntry[], referenceAt = Date.now()): string {
    if (memories.length === 0) return "";

    const timeAware = resolvePromptTimeAware();
    const lines: string[] = [];
    for (const entry of memories) {
        lines.push(timeAware ? formatMemoryEntry(entry, referenceAt) : `- ${entry.content}`);
    }
    return lines.join("\n");
}

export function formatCoreMemories(memories: MemoryEntry[], referenceAt = Date.now()): string {
    return formatLongTermMemories(memories, referenceAt);
}
