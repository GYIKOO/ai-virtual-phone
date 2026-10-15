// Shared posting probabilities live in the existing Moments config/backup.
export type SocialPostConfig = {
    autoPostProbabilityByCharacter: Record<string, number>;
    xiaohongshuPostProbabilityByCharacter: Record<string, number>;
};
export type SocialPostApp = "moments" | "xiaohongshu";
export const DEFAULT_SOCIAL_POST_PROBABILITY = 0.5;

export function normalizeProbabilityMap(value: unknown): Record<string, number> {
    return Object.fromEntries(
        value && typeof value === "object" && !Array.isArray(value)
            ? Object.entries(value).filter(([, v]) => typeof v === "number" && Number.isFinite(v))
                .map(([id, v]) => [id, Math.max(0, Math.min(1, v as number))]) : [],
    );
}

export function isSocialPostLinked(characterId: string, config: SocialPostConfig): boolean {
    return !Object.hasOwn(config.xiaohongshuPostProbabilityByCharacter ?? {}, characterId);
}

export function getSocialPostProbability(characterId: string, app: SocialPostApp, config: SocialPostConfig): number {
    const value = app === "xiaohongshu" && !isSocialPostLinked(characterId, config)
        ? config.xiaohongshuPostProbabilityByCharacter[characterId]
        : config.autoPostProbabilityByCharacter?.[characterId];
    return typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, Math.min(1, value)) : DEFAULT_SOCIAL_POST_PROBABILITY;
}

export function setSocialPostProbability(characterId: string, app: SocialPostApp, value: number, config: SocialPostConfig): Partial<SocialPostConfig> {
    const key = app === "xiaohongshu" && !isSocialPostLinked(characterId, config)
        ? "xiaohongshuPostProbabilityByCharacter" : "autoPostProbabilityByCharacter";
    return { [key]: { ...config[key], [characterId]: Math.max(0, Math.min(1, value)) } };
}

export function setSocialPostLinked(characterId: string, app: SocialPostApp, linked: boolean, config: SocialPostConfig): SocialPostConfig {
    const value = getSocialPostProbability(characterId, app, config);
    const overrides = { ...config.xiaohongshuPostProbabilityByCharacter };
    const shared = { ...config.autoPostProbabilityByCharacter };
    if (linked) {
        shared[characterId] = value;
        delete overrides[characterId];
    } else {
        overrides[characterId] = value;
    }
    return { autoPostProbabilityByCharacter: shared, xiaohongshuPostProbabilityByCharacter: overrides };
}

// Apply only edited characters, so a settings draft does not overwrite another panel's changes.
export function mergeSocialPostDraft(original: SocialPostConfig, draft: SocialPostConfig, current: SocialPostConfig): SocialPostConfig {
    const result = { ...current };
    for (const key of ["autoPostProbabilityByCharacter", "xiaohongshuPostProbabilityByCharacter"] as const) {
        result[key] = { ...current[key] };
        for (const id of new Set([...Object.keys(original[key]), ...Object.keys(draft[key])])) {
            if (original[key][id] === draft[key][id]) continue;
            if (Object.hasOwn(draft[key], id)) result[key][id] = draft[key][id];
            else delete result[key][id];
        }
    }
    return result;
}

export type XiaohongshuActivityPlan = { post: boolean; comment: boolean };
export function rollXiaohongshuActivity(postProbability: number, commentProbability: number, random = Math.random): XiaohongshuActivityPlan {
    return { post: random() < postProbability, comment: random() < commentProbability };
}

export function buildXiaohongshuActivityScope(plan: XiaohongshuActivityPlan): string {
    const blocks = [plan.comment ? "#评论N（对候选笔记的评论及其延伸互动）" : "", plan.post ? "#发帖1（自己的帖子及其附带评论区）" : ""].filter(Boolean);
    return `<xiaohongshu_activity_scope>\n本轮参与范围：${plan.post ? "发帖" : "不发帖"}；${plan.comment ? "评论候选笔记" : "不评论候选笔记"}。\n沿用预设的内容要求与块内格式，本轮只输出以下任务块：${blocks.join("、")}。\n</xiaohongshu_activity_scope>`;
}
