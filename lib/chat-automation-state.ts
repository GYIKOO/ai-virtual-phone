import { kvGet } from "./kv-db";

const manualRuns = new Map<string, string>();
const LOCK_TTL = 5 * 60000;

export function hasChatGenerationLease(sessionId: string, offline = false): boolean {
    try {
        const key = `${offline ? "chat-offline-generating:" : "chat-generating:"}${sessionId}`;
        const startedAt = JSON.parse(kvGet(key) || "null")?.startedAt;
        return typeof startedAt === "number" && Number.isFinite(startedAt)
            && Date.now() - startedAt < LOCK_TTL;
    } catch { return false; }
}

/** Persistent scene selection remains authoritative even after leaving the room. */
export function getChatSceneState(sessionId: string) {
    return {
        offline: kvGet(`chat-offline-mode:${sessionId}`) === "1",
        theater: kvGet(`chat-theater-mode:${sessionId}`) === "1",
        foregroundGenerating: manualRuns.has(`online:${sessionId}`) || hasChatGenerationLease(sessionId),
        offlineGenerating: manualRuns.has(`offline:${sessionId}`) || hasChatGenerationLease(sessionId, true),
    };
}

export function isChatSceneBlockingAutomation(sessionId: string): boolean {
    const state = getChatSceneState(sessionId);
    return state.offline || state.theater || state.foregroundGenerating || state.offlineGenerating;
}

/** In-tab runs remain busy even if a long request exceeds the persisted crash-recovery TTL. */
export function startManualChatRun(sessionId: string, runId: string, offline = false): void {
    manualRuns.set(`${offline ? "offline" : "online"}:${sessionId}`, runId);
}
export function finishManualChatRun(sessionId: string, runId: string, offline = false): void {
    const key = `${offline ? "offline" : "online"}:${sessionId}`;
    if (manualRuns.get(key) === runId) manualRuns.delete(key);
}
