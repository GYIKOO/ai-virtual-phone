import type { FollowUpConfig } from "./settings-storage";
import type { ChatMessage } from "./chat-storage";

/** Read each speaker's latest explicitly emitted intent in this round, never inherited state. */
export function groupFollowUpValue(messages: ChatMessage[], field: string, eligibleIds: string[]): number | undefined {
    const latest = new Map<string, number | undefined>();
    for (const message of messages) {
        if (message.role !== "assistant" || message.isRetracted || !message.senderCharacterId || !eligibleIds.includes(message.senderCharacterId)) continue;
        const value = message.freshStateValues?.find(v => v.name === field)?.value;
        // Metadata is only attached to one bubble of a response batch.
        if (message.freshStateValues !== undefined) latest.set(message.senderCharacterId, value);
    }
    const values = [...latest.values()].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return values.length ? Math.max(...values) : undefined;
}

/** One group opportunity, independent of group size and private-chat personality tiers. */
export function groupFollowUpDelay(value: number | undefined, count: number, rules: FollowUpConfig, random = Math.random): number | null {
    if (count >= rules.maxConsecutive) return null;
    return followUpDelay(4, value, 0, { ...rules, maxConsecutive: 1 }, random);
}
/** Independent of affection, anxiety and ambient contact frequency. Returns seconds. */
export function followUpDelay(tier: number, value: number | undefined, count: number, rules: FollowUpConfig, random = Math.random): number | null {
    const cap = Math.min(rules.maxConsecutive, [0, 1, 1, 2, 3][tier] ?? 0);
    if (count >= cap || value === undefined || !Number.isFinite(value)) return null;
    const threshold = Math.min(100, rules.anxietyThreshold + [0, 20, 10, 5, 0][tier]);
    if (value < threshold || value <= 0) return null;
    const strength = threshold === 100 ? 1 : Math.min(1, (value - threshold) / (100 - threshold));
    const low = Math.min(rules.anxietyMinDelay, rules.anxietyMaxDelay);
    const high = Math.max(rules.anxietyMinDelay, rules.anxietyMaxDelay);
    const delay = high - (high - low) * strength ** [1, 2, 1.5, 1, .7][tier];
    return Math.max(low, Math.min(high, delay * (.9 + .2 * random())));
}
