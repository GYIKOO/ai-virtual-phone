// lib/token-counter.ts
// Lightweight token estimation — zero external dependencies.
// CJK characters ~ 1.5 char/token, Latin ~ 4 char/token, +4 overhead per message.

export function estimateTokens(text: string): number {
    if (!text) return 0;
    // Same UTF-16 ranges as the previous regexp, without allocating one match
    // per character whenever a long narrative is costed during memory packing.
    let cjkCount = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if ((code >= 0x2E80 && code <= 0x9FFF)
            || (code >= 0xAC00 && code <= 0xD7AF)
            || (code >= 0xF900 && code <= 0xFAFF)
            || (code >= 0xFE30 && code <= 0xFE4F)) cjkCount++;
    }
    const latinCount = text.length - cjkCount;
    return Math.ceil(cjkCount / 1.5 + latinCount / 4);
}

export function estimateMessagesTokens(messages: { role: string; content: string }[]): number {
    let total = 0;
    for (const msg of messages) {
        total += estimateTokens(msg.content) + 4; // per-message overhead
    }
    return total + 2; // conversation overhead
}

export function remainingTokenBudget(
    maxContext: number,
    currentTokens: number,
    reserveForGeneration: number = 500
): number {
    return Math.max(0, maxContext - currentTokens - reserveForGeneration);
}
