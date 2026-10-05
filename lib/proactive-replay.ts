import type { ProactiveSource, ProactiveState } from "./proactive-policy";
/** Story time is distinct from the persisted generation time used by the next cycle. */
export type ProactiveTiming = { scheduledAt: string; generatedAt: string; backfilled: boolean };
export function replayTime(state: ProactiveState, source: ProactiveSource, now: number): number | undefined {
    const due = state[`${source}At`];
    if (state.deferred?.[source] || !Number.isFinite(due) || due! > now - 60000) return undefined;
    return due;
}
export function knownAt(createdAt: string, at?: number, updatedAt?: string): boolean {
    return at === undefined || (Date.parse(createdAt) <= at && (!updatedAt || Date.parse(updatedAt) <= at));
}
