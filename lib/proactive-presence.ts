import type { ProactiveAbsence } from "./proactive-replay";

// Device-local, deliberately not in synced/backup KV. Driven by the existing
// follow-up lifecycle and polling loop; no additional background timer.
const KEY = "float_proactive_presence_v1";
const LEASE = 30_000;
type Tab = { seenAt: number; hidden: boolean };
type Presence = { tabs: Record<string, Tab>; lastSeen: number; leftAt?: number; absence?: ProactiveAbsence };
const tabId = Math.random().toString(36).slice(2);
let lastWrite = 0;
let wasVisible = false;

function read(): Presence | undefined {
    try {
        const value = JSON.parse(localStorage.getItem(KEY) || "null");
        if (!value || !Number.isFinite(value.lastSeen) || !value.tabs || typeof value.tabs !== "object") return undefined;
        if (Object.values(value.tabs).some((tab: any) => !tab || !Number.isFinite(tab.seenAt) || typeof tab.hidden !== "boolean")) return undefined;
        return value;
    } catch { return undefined; }
}

/** A missed pagehide (OS kill) is conservatively bounded by the last heartbeat + lease. */
export function updateProactivePresence(visible: boolean, now = Date.now(), force = false): void {
    if (!force && visible === wasVisible && now >= lastWrite && now - lastWrite < 10_000) return;
    try {
        const data = read() ?? { tabs: {}, lastSeen: now };
        const otherVisible = Object.entries(data.tabs).some(([id, tab]) => id !== tabId && !tab.hidden && tab.seenAt <= now && now - tab.seenAt < LEASE);
        if (visible) {
            const previous = data.tabs[tabId];
            // A stalled foreground JS thread is not evidence that the user left.
            const resumed = !wasVisible || !previous;
            if (resumed && !otherVisible) {
                const leftAt = data.leftAt !== undefined && data.leftAt >= data.lastSeen
                    ? data.leftAt : data.lastSeen + LEASE;
                data.absence = leftAt < now ? { leftAt, returnedAt: now } : undefined;
            }
            data.lastSeen = now;
            data.leftAt = undefined;
        } else if (wasVisible && !otherVisible) {
            data.leftAt = now;
            data.absence = undefined;
        }
        // Bound storage even across many closed tabs.
        for (const [id, tab] of Object.entries(data.tabs)) if (now - tab.seenAt > LEASE) delete data.tabs[id];
        data.tabs[tabId] = { seenAt: now, hidden: !visible };
        localStorage.setItem(KEY, JSON.stringify(data));
        wasVisible = visible;
        lastWrite = now;
    } catch { /* Storage unavailable: replay stays disabled, normal sending still works. */ }
}

export function getProactiveAbsence(): ProactiveAbsence | undefined {
    return read()?.absence;
}
