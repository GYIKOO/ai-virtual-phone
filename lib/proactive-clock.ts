import { planProactive, type ProactiveConfig, type ProactiveState, type ProactiveSource } from "./proactive-policy";

const MINUTE = 60000;
export function quietBounds(setting: string): [number, number] | null {
    const m = setting.match(/^(\d{1,2}):(\d{2})\s*[-~—]\s*(\d{1,2}):(\d{2})$/);
    if (!m || +m[1] > 23 || +m[3] > 23 || +m[2] > 59 || +m[4] > 59) return null;
    const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
    return a === b ? null : [a, b];
}
function localBoundary(at: number, minute: number, nextDay = false): number {
    const d = new Date(at);
    if (nextDay) d.setDate(d.getDate() + 1);
    d.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
    return d.getTime();
}
export function quietEnd(at: number, setting: string): number | null {
    const bounds = quietBounds(setting);
    if (!bounds) return null;
    const [a, b] = bounds, d = new Date(at), m = d.getHours() * 60 + d.getMinutes();
    const within = a < b ? m >= a && m < b : m >= a || m < b;
    return within ? localBoundary(at, b, a > b && m >= a) : null;
}
function segment(at: number, setting: string): { end: number; speed: number } {
    const bounds = quietBounds(setting);
    if (!bounds) return { end: Infinity, speed: 1 };
    const end = quietEnd(at, setting);
    if (end !== null) return { end: Math.max(at + MINUTE, end), speed: .5 };
    let start = localBoundary(at, bounds[0]);
    if (start <= at) start = localBoundary(at, bounds[0], true);
    return { end: Math.max(at + MINUTE, start), speed: 1 };
}
export function effectiveElapsed(start: number, end: number, setting: string): number {
    let total = 0;
    while (start < end) {
        const s = segment(start, setting), until = Math.min(end, s.end);
        total += (until - start) * s.speed;
        start = until;
    }
    return total;
}
export function effectiveDue(at: number, remaining: number, setting: string): number {
    remaining = Math.max(0, remaining);
    for (;;) {
        const s = segment(at, setting), capacity = (s.end - at) * s.speed;
        if (remaining <= capacity) return at + remaining / s.speed;
        remaining -= capacity; at = s.end;
    }
}
function spreadAfter(at: number, setting: string, random: () => number): number {
    const b = quietBounds(setting);
    const spread = b ? Math.min(45, ((b[0] - b[1] + 1440) % 1440) / 2) : 45;
    return at + Math.max(.001, random()) * spread * MINUTE;
}
export function releaseQuiet(state: ProactiveState, now: number, setting: string, random = Math.random): ProactiveState {
    const next = { ...state, deferred: { ...state.deferred }, quietReleased: { ...state.quietReleased } };
    for (const source of ["fixed", "personality", "followup"] as ProactiveSource[]) {
        const key = `${source}At` as const, due = next[key];
        if (due === undefined) continue;
        const end = quietEnd(due, setting) ?? (due <= now ? quietEnd(now, setting) : null);
        if (end !== null) {
            next.deferred![source] = true;
            // Late recovery of a quiet task uses actual recovery time, never backfills.
            const base = Math.max(end, now);
            next[key] = spreadAfter(quietEnd(base, setting) ?? base, setting, random);
            next.quietReleased![source] = now >= end;
        } else if (next.deferred![source] && due <= now && !next.quietReleased![source]) {
            if (now - due > 120000) next[key] = spreadAfter(quietEnd(now, setting) ?? now, setting, random);
            next.quietReleased![source] = true;
        }
    }
    return next;
}
export function anchorPlan(config: ProactiveConfig, revision: number, group: boolean, anchor: string, at: number, setting: string, now: number, random = Math.random): ProactiveState {
    const state = planProactive(config, at, revision, group, random);
    const budget = state.personalityAt === undefined ? undefined : state.personalityAt - at;
    return releaseQuiet({ ...state, anchor, anchorAt: at, clockVersion: 2, quietSetting: setting,
        settledAt: at, remainingMs: budget,
        personalityAt: budget === undefined ? undefined : effectiveDue(at, budget, setting) }, now, setting, random);
}
/** Keep the draw; settle elapsed time using the OLD setting before changing clocks. */
export function changeQuiet(state: ProactiveState, setting: string, now: number): ProactiveState {
    if (state.quietSetting === setting) return state;
    const remaining = state.remainingMs === undefined ? undefined : Math.max(0, state.remainingMs - effectiveElapsed(state.settledAt ?? now, now, state.quietSetting ?? ""));
    return releaseQuiet({ ...state, quietSetting: setting, settledAt: now, remainingMs: remaining,
        personalityAt: remaining === undefined ? undefined : effectiveDue(now, remaining, setting) }, now, setting);
}
