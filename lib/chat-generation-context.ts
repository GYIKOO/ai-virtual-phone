/** Background triggers must not inherit the user's manual empty-send continuation. */
export function isAutomaticChatGeneration(options?: {
    automatic?: boolean;
    appTags?: string[];
    followUpCount?: number;
    ephemeralSystemNote?: string;
}): boolean {
    return options?.automatic === true || (options?.followUpCount ?? 0) > 0
        || Boolean(options?.ephemeralSystemNote?.trim())
        || (options?.appTags ?? []).some(tag => [
            "proactive", "followup", "idle_wake", "timed_wake", "user_timed_wake", "period_care",
        ].includes(tag));
}
