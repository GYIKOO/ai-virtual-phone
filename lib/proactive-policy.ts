/** Pure scheduling policy. No emotion/status values and no API calls. */
export const INITIATIVE_HOURS = [16, 12, 9, 6, 4] as const;
export const TIER_LABELS = ["很低", "较低", "适中", "较高", "很高"] as const;
export type ProactiveSource = "fixed" | "personality" | "followup";
export type ProactiveConfig = {
    version: 1;
    enabled: boolean;
    fixedEnabled: boolean;
    intervalMinutes: number;
    jitterPercent: number;
    personalityEnabled: boolean;
    initiativeTier: number;
    adjustment: number;
    followUpTier: number;
    groupFollowUpEnabled: boolean;
    groupFollowUpInstruction: string;
    instruction: string;
    assessment?: { reason: string; characterUpdatedAt: string; assessedAt: number };
};
export type ProactiveState = {
    revision: number;
    /** A settings change starts a new scheduling cycle, not a past interaction. */
    configuredAt?: number;
    /** Scheduler lifecycle, independent of the visible transcript. Not a fictional message. */
    cycleFloorAt?: number;
    handledAt?: number;
    handledMessageIds?: string[];
    dismissedAt?: number;
    fixedAt?: number;
    personalityAt?: number;
    followupAt?: number;
    followupCount: number;
    followupRules?: string;
    lastAttemptAt?: number;
    lastError?: string;
    anchor?: string;
    anchorAt?: number;
    clockVersion?: number;
    quietSetting?: string;
    settledAt?: number;
    remainingMs?: number;
    deferred?: Partial<Record<ProactiveSource, boolean>>;
    retryAt?: number;
    quietReleased?: Partial<Record<ProactiveSource, boolean>>;
};
const LEGACY_PROACTIVE_INSTRUCTION = "这是一次自主交流机会，不是用户发来的新消息。根据角色设定、已有关系、当前生活和对话情境，决定是否有想说的内容。关系不默认是恋爱或亲密关系；未收到回复本身不代表冷落或需要催促。可以分享、讨论、告知或延续有意义的话题，也可以保持沉默。群聊成员可以彼此交流，不必围绕用户或等待用户回复；本次只进行一小轮交流。";
export const DEFAULT_PROACTIVE_INSTRUCTION = [
    "延续角色此刻的生活。结合人设、已有经历与当前情境，想一想TA正在关注什么，是否有一件想与对方交流的事，以及现在是否适合开口。工作、兴趣、牵挂和身边的人事，都可以成为角色行动的来由。",
    "让已有的关系和共同经历决定交流的分寸、情绪与表达方式。角色有话想说时，就按自己的性格自然地联系；正在忙碌、专注于别的事情，或觉得对话已经告一段落时，也可以继续自己的生活。",
    "群聊是一段成员之间的共同生活：有话题的人发起交流，感兴趣的人接话，各自的立场与关系在交谈中自然体现。本次展开一小轮对话，留下后续发展的空间。",
].join("\n\n");
export const DEFAULT_GROUP_FOLLOWUP_INSTRUCTION = "结合当前时间、群内最近的交流与成员各自的近况，让有话想说的成员自然开口。仍有兴致的话题可以接着聊，也可以谈起此刻关注的新事情；交流已经告一段落时，可以保持安静。";
export function defaultProactiveConfig(): ProactiveConfig {
    return { version: 1, enabled: false, fixedEnabled: true, intervalMinutes: 480,
        jitterPercent: 20, personalityEnabled: false, initiativeTier: 2,
        adjustment: 0, followUpTier: 0, groupFollowUpEnabled: false,
        groupFollowUpInstruction: DEFAULT_GROUP_FOLLOWUP_INSTRUCTION, instruction: DEFAULT_PROACTIVE_INSTRUCTION };
}
const finite = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
export function normalizeProactiveConfig(value?: Partial<ProactiveConfig> | null): ProactiveConfig {
    const d = defaultProactiveConfig();
    return { ...d, enabled: value?.enabled === true, fixedEnabled: value?.fixedEnabled ?? d.fixedEnabled,
        personalityEnabled: value?.personalityEnabled === true,
        intervalMinutes: finite(value?.intervalMinutes, 480, 15, 10080),
        jitterPercent: finite(value?.jitterPercent, 20, 0, 50),
        initiativeTier: Math.round(finite(value?.initiativeTier, 2, 0, 4)),
        adjustment: [-40, -20, 0, 20, 40].includes(value?.adjustment ?? NaN) ? value!.adjustment! : 0,
        followUpTier: Math.round(finite(value?.followUpTier, 0, 0, 4)),
        groupFollowUpEnabled: value?.groupFollowUpEnabled === true,
        groupFollowUpInstruction: typeof value?.groupFollowUpInstruction === "string" ? value.groupFollowUpInstruction : d.groupFollowUpInstruction,
        instruction: typeof value?.instruction === "string" && value.instruction !== LEGACY_PROACTIVE_INSTRUCTION ? value.instruction : d.instruction,
        assessment: value?.assessment };
}
export function intervalMs(config: ProactiveConfig, source: ProactiveSource): number {
    if (source === "fixed") return config.intervalMinutes * 60000;
    if (source === "followup") return [0, 240, 120, 60, 30][config.followUpTier] * 60000;
    const hours = INITIATIVE_HOURS[config.initiativeTier] / (1.4 ** (config.adjustment / 40));
    // Bound the distribution's mean, never clamp individual draws to the protection floor.
    return Math.max(2, Math.min(20, hours)) * 3600000;
}
/** Bounded beta distribution: mean M, support (30min, 1.5M). */
export function samplePersonalityMs(config: ProactiveConfig, random = Math.random): number {
    const uniform = () => Math.max(1e-12, Math.min(1 - 1e-12, random()));
    const gamma = (shape: number): number => {
        const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
        for (;;) {
            const x = Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
            const root = 1 + c * x;
            if (root <= 0) continue;
            const v = root ** 3, u = uniform();
            if (Math.log(u) < x * x / 2 + d * (1 - v + Math.log(v))) return d * v;
        }
    };
    const mean = intervalMs(config, "personality"), lower = 1800000, upper = mean * 1.5;
    const a = gamma(4), b = gamma(4 * (upper - mean) / (mean - lower));
    return lower + (upper - lower) * a / (a + b);
}
export function nextProactiveAt(config: ProactiveConfig, source: ProactiveSource, now: number, random = Math.random): number {
    if (source === "personality") return now + samplePersonalityMs(config, random);
    const jitter = (Math.max(0, Math.min(1, random())) * 2 - 1) * config.jitterPercent / 100;
    return now + Math.max(60000, Math.round(intervalMs(config, source) * (1 + jitter)));
}
export function maxFollowUps(config: ProactiveConfig): number {
    return [0, 1, 1, 2, 3][config.followUpTier];
}
export function planProactive(config: ProactiveConfig, now: number, revision: number, isGroup = false, random = Math.random): ProactiveState {
    return { revision, followupCount: 0,
        ...(config.enabled && config.fixedEnabled ? { fixedAt: nextProactiveAt(config, "fixed", now, random) } : {}),
        ...(config.enabled && config.personalityEnabled && !isGroup ? { personalityAt: nextProactiveAt(config, "personality", now, random) } : {}) };
}
export function dueProactive(state: ProactiveState, now: number): ProactiveSource | null {
    if (state.retryAt && state.retryAt > now) return null;
    const due = (["fixed", "personality", "followup"] as const)
        .map(source => ({ source, at: state[`${source}At`] }))
        .filter((item): item is { source: ProactiveSource; at: number } => typeof item.at === "number" && Number.isFinite(item.at) && item.at <= now)
        .sort((a, b) => a.at - b.at);
    return due[0]?.source ?? null;
}
/** An opportunity consumes both clocks: never catch up a backlog or double-send. */
export function consumeProactive(config: ProactiveConfig, state: ProactiveState, now: number, isGroup: boolean): ProactiveState {
    return { ...planProactive(config, now, state.revision, isGroup), followupCount: state.followupCount, lastAttemptAt: now };
}
export function proactiveInstruction(config: ProactiveConfig, source: ProactiveSource, at = Date.now(), isGroup = false): string {
    const focus = source === "followup" ? `\n${isGroup ? config.groupFollowUpInstruction : "本次是上一轮交流的跟进机会。结合尚待确认、补充或继续讨论的具体内容，以及角色自己的动机决定是否再开口。发言后重新评估这件事是否还需要跟进；已经告一段落时可以保持沉默。"}` : "";
    return `${config.instruction}${focus}\n[系统调度事件：${source === "followup" ? "补充联系机会" : "自主交流机会"}；时间：${new Date(at).toISOString()}]\n输出协议：发言时沿用当前聊天格式；本轮保持沉默时返回唯一标记 <proactive-skip/>。`;
}
