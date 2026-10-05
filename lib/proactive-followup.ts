import type { FollowUpConfig } from "./settings-storage";
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
