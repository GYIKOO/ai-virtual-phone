import { loadChatSessions, loadChatMessages, clearFollowUpSchedule, type ChatSession } from "./chat-storage";
import { buildChatPromptMessages, sendLLMRequest, stripOnlineThinkingTag, stripPresetTexts } from "./chat-engine";
import { buildGroupChatPromptMessages, parseGroupChatResponse } from "./group-chat-engine";
import { cancelBailoutPrefix, cancelFollowUpBailout } from "./push-bailout-client";
import { loadIdleReconnectRules } from "./idle-reconnect-storage";
import { isWithinPushQuietHours, loadPushQuietHours } from "./push-client";
import { anchorPlan, changeQuiet, releaseQuiet } from "./proactive-clock";
import { kvGet } from "./kv-db";
import { loadFollowUpConfig } from "./settings-storage";
import { followUpDelay } from "./proactive-followup";
import { replayTime } from "./proactive-replay";
import { loadProactive, saveProactiveState, refreshProactive, flushProactive, type ProactiveRecord } from "./proactive-storage";
import { dueProactive, maxFollowUps, nextProactiveAt, proactiveInstruction, type ProactiveSource } from "./proactive-policy";

let busy = false;
let nextGlobalAttempt = 0;
const active = new Map<string, AbortController>();
export function isNewProactiveGenerating(sessionId: string): boolean { return active.has(sessionId); }
const lastMessage = (sessionId: string) => loadChatMessages(sessionId).at(-1)?.id;
function synchronize(session: ChatSession, record: ProactiveRecord, now: number): ProactiveRecord {
    const latest = loadChatMessages(session.id).at(-1);
    const anchor = latest ? `${latest.id}:${latest.createdAt}` : "empty";
    const setting = loadPushQuietHours();
    let state = record.state;
    if (state.clockVersion !== 2 || state.anchor !== anchor) {
        const parsed = Date.parse(latest?.proactiveTiming?.generatedAt ?? latest?.createdAt ?? session.updatedAt);
        const at = Number.isFinite(parsed) ? Math.min(now, parsed) : now;
        state = anchorPlan(record.config, state.revision, !!session.isGroup, anchor, at, setting, now);
        if (latest?.role === "assistant") state.followupCount = record.state.followupCount;
    } else {
        state = releaseQuiet(changeQuiet(state, setting, now), now, setting);
    }
    if (JSON.stringify(state) !== JSON.stringify(record.state)) saveProactiveState(session.id, state);
    return { config: record.config, state };
}
function foregroundBusy(sessionId: string): boolean {
    try { const at = JSON.parse(kvGet(`chat-generating:${sessionId}`) || "null")?.startedAt; return typeof at === "number" && Date.now() - at < 5 * 60000; } catch { return false; }
}

/** Switching mechanisms cancels ambient legacy jobs, never explicit appointments. */
export function cancelLegacyAmbient(sessionId: string): void {
    clearFollowUpSchedule(sessionId);
    cancelFollowUpBailout(sessionId);
    for (const rule of loadIdleReconnectRules().filter(r => r.sessionId === sessionId)) {
        void cancelBailoutPrefix(`idle:${rule.id}:`);
    }
    active.get(sessionId)?.abort();
}
export function cancelNewProactive(sessionId: string): void { active.get(sessionId)?.abort(); }

export function schedulePersonalityFollowUp(sessionId: string, count?: number): void {
    const session = loadChatSessions().find(s => s.id === sessionId);
    const record = loadProactive(sessionId);
    if (!session || !record) return;
    const { config, state } = synchronize(session, record, Date.now());
    if (!config.enabled || session.proactiveDisabled || session.isGroup) return;
    const used = count ?? state.followupCount;
    const rules = loadFollowUpConfig();
    const history = loadChatMessages(sessionId);
    const latest = history.at(-1);
    if (!latest || latest.role !== "assistant") return;
    // Only this reply's explicitly emitted value counts, never an inherited old status.
    const batch = latest.responseBatchId ? history.filter(m => m.responseBatchId === latest.responseBatchId && m.role === "assistant") : [latest];
    const value = batch.flatMap(m => m.freshStateValues ?? []).find(v => v.name === rules.followUpFieldName)?.value;
    const delay = followUpDelay(config.followUpTier, value, used, rules);
    if (delay === null) {
        saveProactiveState(sessionId, { ...state, followupCount: used, followupAt: undefined });
        return;
    }
    // A persisted deadline is not repeatedly randomized by UI renders or polling.
    if (state.followupAt && state.followupRules === JSON.stringify(rules)) return;
    saveProactiveState(sessionId, releaseQuiet({ ...state, followupCount: used, followupRules: JSON.stringify(rules),
        followupAt: (state.anchorAt ?? Date.now()) + delay * 1000 }, Date.now(), loadPushQuietHours()));
}
export function resetProactiveOnUserMessage(sessionId: string): void {
    active.get(sessionId)?.abort();
    const session = loadChatSessions().find(s => s.id === sessionId);
    const record = loadProactive(sessionId);
    if (!session || !record) return;
    // The caller may run before saving the new user message. Polling reconciles it
    // after persistence; never manufacture a new interaction timestamp here.
    const { state } = synchronize(session, record, Date.now());
    saveProactiveState(sessionId, { ...state, followupCount: 0, followupAt: undefined });
}

/** Single global lane, plus Web Locks across tabs. No network calls unless a task is due. */
export function pollNewProactive(now: number, legacyBusy: (sessionId: string) => boolean): void {
    if (busy) return;
    for (const s of loadChatSessions()) {
        const r = loadProactive(s.id);
        if (r?.config.enabled) {
            const current = synchronize(s, r, now);
            if (current.state.followupAt && current.state.followupRules !== JSON.stringify(loadFollowUpConfig())) schedulePersonalityFollowUp(s.id);
        }
    }
    if (now < nextGlobalAttempt || isWithinPushQuietHours(now)) return;
    const session = loadChatSessions().filter(s => !s.proactiveDisabled && !s.isBlacklisted)
        .find(s => {
            const r = loadProactive(s.id);
            return r?.config.enabled && dueProactive(r.state, now) && !legacyBusy(s.id) && !foregroundBusy(s.id);
        });
    if (!session) return;
    busy = true;
    const run = async () => {
        await refreshProactive();
        const fresh = loadProactive(session.id);
        const current = fresh && synchronize(session, fresh, Date.now());
        const source = current?.config.enabled && dueProactive(current.state, Date.now());
        if (current && source && !isWithinPushQuietHours(Date.now()) && !legacyBusy(session.id) && !foregroundBusy(session.id)) await fire(session, current, source);
    };
    const promise = typeof navigator !== "undefined" && navigator.locks
        ? navigator.locks.request("float-proactive-generation", { ifAvailable: true }, lock => lock ? run() : undefined)
        : run();
    void promise.catch(error => console.error("[Proactive]", error)).finally(() => {
        busy = false;
        nextGlobalAttempt = Date.now() + 60000;
    });
}

async function fire(session: ChatSession, record: ProactiveRecord, source: ProactiveSource): Promise<void> {
    const controller = new AbortController();
    const { config } = record;
    const historicalAt = replayTime(record.state, source, Date.now());
    const state = { ...record.state, lastAttemptAt: Date.now(), retryAt: Date.now() + 30 * 60000, lastError: undefined };
    // Persist a retry lease, not a fictional new conversation, before calling the API.
    if (!saveProactiveState(session.id, state)) return;
    await flushProactive();
    active.set(session.id, controller);
    const anchor = lastMessage(session.id);
    window.dispatchEvent(new CustomEvent("followup-started", { detail: { sessionId: session.id } }));
    const valid = () => !controller.signal.aborted && loadProactive(session.id)?.state.revision === state.revision
        && !isWithinPushQuietHours(Date.now())
        && loadChatSessions().some(s => s.id === session.id && !s.proactiveDisabled && !s.isBlacklisted);
    try {
        const history = loadChatMessages(session.id);
        const tags = [session.isGroup ? "group_chat" : "chat", "text", "proactive"];
        const prompt = session.isGroup
            ? await buildGroupChatPromptMessages(session, history, { appTags: tags, disableTools: true, historicalAt })
            : await buildChatPromptMessages(session, history, { appTags: tags, toolsAllowed: false, historicalAt });
        if (!valid() || lastMessage(session.id) !== anchor) return;
        prompt.llmMessages.push({ role: "system", content: proactiveInstruction(config, source, historicalAt ?? Date.now()) });
        if (historicalAt !== undefined) prompt.llmMessages.push({ role: "system", content: "本轮场景时间以调度事件给出的时间为准。沿用当前聊天的文字分条格式表达；此轮只生成文字交流，保持沉默时返回 <proactive-skip/>。" });
        let raw = await sendLLMRequest(prompt.config, prompt.preset, prompt.llmMessages, prompt.regexes, undefined,
            { appId: session.isGroup ? "group_chat" : "chat", appTags: tags, signal: controller.signal, debugSessionId: session.id });
        if (!valid() || lastMessage(session.id) !== anchor) return;
        if (prompt.preset?.online_thinking_enabled) {
            raw = stripOnlineThinkingTag(raw, prompt.preset.online_thinking_tag?.trim() || "thinking");
        }
        raw = stripPresetTexts(raw, prompt.preset);
        const finishSilent = () => {
            const current = loadProactive(session.id);
            if (current?.state.revision !== state.revision) return;
            saveProactiveState(session.id, { ...current.state, [`${source}At`]: undefined, retryAt: undefined,
                ...(source === "followup" ? { followupCount: Math.max(current.state.followupCount, maxFollowUps(config)) } : {}) });
        };
        if (!raw.trim() || /^<proactive-skip\s*\/>$/i.test(raw.trim())) { finishSilent(); return; }
        const results = "nameToId" in prompt ? parseGroupChatResponse(raw, prompt.nameToId)
            : [{ characterId: session.contactId, characterName: prompt.character.name, responseText: raw }];
        const { parseAndSaveResponse } = await import("./follow-up-service");
        const generatedAt = new Date().toISOString();
        let visible = false;
        for (const result of results) {
            if (!valid()) break;
            const saved = await parseAndSaveResponse(result.responseText, session.id, 0, undefined, history,
                { ...(session.isGroup ? { senderCharacterId: result.characterId, senderName: result.characterName } : {}),
                    ...(historicalAt !== undefined ? { createdAt: new Date(historicalAt).toISOString(), historicalReplay: true,
                        proactiveTiming: { scheduledAt: new Date(historicalAt).toISOString(), generatedAt, backfilled: true } } : {}) });
            visible ||= saved.hasVisible;
        }
        if (visible && valid()) {
            const current = loadProactive(session.id);
            if (current) synchronize(session, current, Date.now());
            schedulePersonalityFollowUp(session.id, source === "followup" ? record.state.followupCount + 1 : record.state.followupCount);
            // Preserve memory accounting, without inventing a user message for this event.
            const { incrementEventCounter } = await import("./memory-storage");
            const { maybeRunSummarization } = await import("./memory-summarizer");
            const { loadCharacters } = await import("./character-storage");
            for (const id of new Set(results.map(r => r.characterId))) {
                const character = loadCharacters().find(c => c.id === id);
                if (character) { incrementEventCounter(id); void maybeRunSummarization(id, character.name).catch(console.warn); }
            }
        } else if (!visible && valid()) finishSilent();
    } catch (error) {
        if (!controller.signal.aborted) {
            console.error("[Proactive] Generation failed", error);
            const current = loadProactive(session.id);
            if (current?.state.revision === state.revision) saveProactiveState(session.id, { ...current.state, lastError: "本轮生成失败，保留原消息计时；30分钟后可重试。" });
        }
    } finally {
        active.delete(session.id);
        window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId: session.id } }));
    }
}
