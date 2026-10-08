import type { ProactiveSource, ProactiveState } from "./proactive-policy";
/** Story time is distinct from the persisted generation time used by the next cycle. */
export type ProactiveTiming = { scheduledAt: string; generatedAt: string; backfilled: boolean };
export type ProactiveAbsence = { leftAt: number; returnedAt: number };
// A failed/queued request must not keep replaying an old absence for days after return.
export const REPLAY_RECOVERY_WINDOW_MS = 60 * 60_000;
export function replayTime(state: ProactiveState, source: ProactiveSource, now: number, absence?: ProactiveAbsence): number | undefined {
    const due = state[`${source}At`];
    if (state.deferred?.[source] || !Number.isFinite(due) || due! > now - 60000) return undefined;
    // No evidence of an actual missed interval means send in the present.
    // Never clamp an old deadline into a new, fictional historical event.
    if (!absence || !Number.isFinite(absence.leftAt) || !Number.isFinite(absence.returnedAt)
        || absence.returnedAt > now || now - absence.returnedAt > REPLAY_RECOVERY_WINDOW_MS || absence.leftAt >= absence.returnedAt
        || due! < Math.max(absence.leftAt, state.configuredAt ?? 0) || due! > absence.returnedAt) return undefined;
    return due;
}
export function knownAt(createdAt: string, at?: number, updatedAt?: string): boolean {
    return at === undefined || (Date.parse(createdAt) <= at && (!updatedAt || Date.parse(updatedAt) <= at));
}
