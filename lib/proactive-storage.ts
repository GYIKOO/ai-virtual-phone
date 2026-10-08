import { kvGet, kvSet, kvSetAsync, kvRefresh, registerKvMigration } from "./kv-db";
import { normalizeProactiveConfig, planProactive, type ProactiveConfig, type ProactiveState } from "./proactive-policy";

const KEY = "ai_phone_proactive_v1";
registerKvMigration(KEY);
export const PROACTIVE_UPDATED = "proactive-config-updated";
export async function refreshProactive(): Promise<void> { await kvRefresh(KEY); }
export async function flushProactive(): Promise<void> { await kvSetAsync(KEY, JSON.stringify(load())); }
export type ProactiveRecord = { config: ProactiveConfig; state: ProactiveState };
function load(): Record<string, ProactiveRecord> {
    try { const data = JSON.parse(kvGet(KEY) || "{}"); return data && typeof data === "object" && !Array.isArray(data) ? data : {}; } catch { return {}; }
}
export function loadProactive(sessionId: string): ProactiveRecord | undefined {
    const record = load()[sessionId];
    if (!record?.state || record.config?.version !== 1) return undefined;
    return { config: normalizeProactiveConfig(record.config), state: record.state };
}
export function saveProactiveConfig(sessionId: string, config: ProactiveConfig, isGroup: boolean): ProactiveRecord {
    const data = load();
    const normalized = normalizeProactiveConfig(config);
    if (isGroup) { normalized.personalityEnabled = false; normalized.followUpTier = 0; }
    const now = Date.now();
    const record = { config: normalized, state: { ...planProactive(normalized, now, (data[sessionId]?.state.revision ?? 0) + 1, isGroup), configuredAt: now } };
    data[sessionId] = record;
    kvSet(KEY, JSON.stringify(data));
    window.dispatchEvent(new CustomEvent(PROACTIVE_UPDATED, { detail: { sessionId } }));
    return record;
}
/** Compare-and-save prevents an in-flight result from replacing newer settings. */
export function saveProactiveState(sessionId: string, state: ProactiveState): boolean {
    const data = load();
    if (data[sessionId]?.state.revision !== state.revision) return false;
    data[sessionId].state = state;
    kvSet(KEY, JSON.stringify(data));
    return true;
}
export function removeProactive(sessionId: string): void {
    const data = load(); delete data[sessionId]; kvSet(KEY, JSON.stringify(data));
}

/** Deleting a delivered opportunity dismisses the whole round, including follow-ups. */
export function dismissDeletedProactive(sessionId: string, deletedIds: string[], isGroup: boolean, now = Date.now()): boolean {
    const record = loadProactive(sessionId);
    if (!record) return false;
    const ids = new Set(deletedIds);
    const relevant = record.state.handledMessageIds?.some(id => ids.has(id))
        || deletedIds.some(id => record.state.anchor?.startsWith(`${id}:`));
    if (!relevant) return false;
    const state: ProactiveState = { ...planProactive(record.config, now, record.state.revision + 1, isGroup),
        configuredAt: record.state.configuredAt, cycleFloorAt: now, dismissedAt: now, handledAt: now };
    const data = load();
    data[sessionId] = { config: record.config, state };
    kvSet(KEY, JSON.stringify(data));
    return true;
}
