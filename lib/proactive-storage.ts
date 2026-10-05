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
    const record = { config: normalized, state: planProactive(normalized, Date.now(), (data[sessionId]?.state.revision ?? 0) + 1, isGroup) };
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
