import { loadChatSessions, loadChatMessages, clearFollowUpSchedule, createResponseRoundId, type ChatSession } from "./chat-storage";
import { buildChatPromptMessages, sendLLMRequest, stripOnlineThinkingTag, stripPresetTexts } from "./chat-engine";
import { buildGroupChatPromptMessages, parseGroupChatResponse } from "./group-chat-engine";
import { cancelBailoutPrefix, cancelFollowUpBailout } from "./push-bailout-client";
import { loadIdleReconnectRules } from "./idle-reconnect-storage";
import { isWithinPushQuietHours, loadPushQuietHours } from "./push-client";
import { anchorPlan, changeQuiet, releaseQuiet } from "./proactive-clock";
import { loadFollowUpConfig } from "./settings-storage";
import { followUpDelay, groupFollowUpDelay, groupFollowUpValue } from "./proactive-followup";
import { replayTime } from "./proactive-replay";
import { getProactiveAbsence } from "./proactive-presence";
import { loadProactive, saveProactiveState, refreshProactive, flushProactive, type ProactiveRecord } from "./proactive-storage";
import { dueProactive, maxFollowUps, nextProactiveAt, proactiveInstruction, type ProactiveSource } from "./proactive-policy";
import { prepareProactiveSituation } from "./proactive-context";
import { isChatSceneBlockingAutomation } from "./chat-automation-state";
import { isGroupMuted } from "./group-admin";
import { loadCharacters } from "./character-storage";

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
        // Unversioned legacy plans have no reliable start: migrate from now.
        const removedAnchor = !!state.anchor && !loadChatMessages(session.id).some(m => `${m.id}:${m.createdAt}` === state.anchor);
        const floor = Math.max(state.configuredAt ?? (state.clockVersion !== 2 ? now : 0), state.cycleFloorAt ?? 0, removedAnchor ? now : 0);
        const at = Math.min(now, Math.max(floor, Number.isFinite(parsed) ? parsed : now));
        state = { ...anchorPlan(record.config, state.revision, !!session.isGroup, anchor, at, setting, now), configuredAt: record.state.configuredAt ?? floor,
            cycleFloorAt: floor, dismissedAt: removedAnchor ? now : state.dismissedAt };
        if (latest?.role === "assistant" && !removedAnchor) state.followupCount = record.state.followupCount;
    } else {
        state = releaseQuiet(changeQuiet(state, setting, now), now, setting);
    }
    if (JSON.stringify(state) !== JSON.stringify(record.state)) saveProactiveState(session.id, state);
    return { config: record.config, state };
}
function foregroundBusy(sessionId: string): boolean {
    return isChatSceneBlockingAutomation(sessionId);
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
    if (!config.enabled || session.proactiveDisabled || session.isBlacklisted) return;
    if (session.isGroup && !config.groupFollowUpEnabled) return;
    const used = count ?? state.followupCount;
    const rules = loadFollowUpConfig();
    const history = loadChatMessages(sessionId);
    const latest = history.at(-1);
    if (!latest || latest.role !== "assistant") return;
    if (Date.parse(latest.proactiveTiming?.generatedAt ?? latest.createdAt) <= (state.dismissedAt ?? 0)) return;
    if (Date.parse(latest.proactiveTiming?.generatedAt ?? latest.createdAt) < (state.configuredAt ?? 0)) return;
    // Only this reply's explicitly emitted value counts, never an inherited old status.
    const batch = session.isGroup && latest.responseRoundId
        ? history.filter(m => m.responseRoundId === latest.responseRoundId)
        : latest.responseBatchId ? history.filter(m => m.responseBatchId === latest.responseBatchId && m.role === "assistant") : [latest];
    const eligibleIds = (session.participantIds ?? []).filter(id => !isGroupMuted(session, id) && loadCharacters().some(c => c.id === id));
    const value = session.isGroup ? groupFollowUpValue(batch, rules.followUpFieldName, eligibleIds)
        : batch.flatMap(m => m.freshStateValues ?? []).find(v => v.name === rules.followUpFieldName)?.value;
    const delay = session.isGroup ? groupFollowUpDelay(value, used, rules) : followUpDelay(config.followUpTier, value, used, rules);
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
    const anchor = lastMessage(session.id);
    // Delayed group follow-ups re-evaluate the present, not an old conversation scene.
    // Ambient contact retains its existing absence-bounded replay behavior.
    const candidateReplayAt = session.isGroup && source === "followup" ? undefined
        : replayTime(record.state, source, Date.now(), getProactiveAbsence());
    const situation = prepareProactiveSituation(session, loadChatMessages(session.id), candidateReplayAt, Date.now());
    const historicalAt = situation.historicalAt;
    const state = { ...record.state, lastAttemptAt: Date.now(), retryAt: Date.now() + 30 * 60000, lastError: undefined };
    const responseRoundId = session.isGroup ? createResponseRoundId() : undefined;
    const roster = JSON.stringify(session.participantIds ?? []);
    const historyKey = () => JSON.stringify(loadChatMessages(session.id).filter(m => !responseRoundId || m.responseRoundId !== responseRoundId));
    const originalHistoryKey = historyKey();
    // Persist a retry lease, not a fictional new conversation, before calling the API.
    if (!saveProactiveState(session.id, state)) return;
    await flushProactive();
    active.set(session.id, controller);
    window.dispatchEvent(new CustomEvent("followup-started", { detail: { sessionId: session.id } }));
    const valid = () => !controller.signal.aborted && loadProactive(session.id)?.state.revision === state.revision
        && (historicalAt === undefined || replayTime(record.state, source, Date.now(), getProactiveAbsence()) === historicalAt)
        && !isWithinPushQuietHours(Date.now())
        && !foregroundBusy(session.id)
        && loadChatSessions().some(s => s.id === session.id && !s.proactiveDisabled && !s.isBlacklisted
            && (!session.isGroup || (JSON.stringify(s.participantIds ?? []) === roster && historyKey() === originalHistoryKey)));
    try {
        const history = loadChatMessages(session.id);
        const originalMessageIds = new Set(history.map(m => m.id));
        const tags = [session.isGroup ? "group_chat" : "chat", "text", "proactive"];
        const prompt = session.isGroup
            ? await buildGroupChatPromptMessages(session, history, { appTags: tags, disableTools: true, historicalAt })
            : await buildChatPromptMessages(session, history, { appTags: tags, toolsAllowed: false, historicalAt });
        if (!valid() || lastMessage(session.id) !== anchor) return;
        prompt.llmMessages.push({ role: "system", content: `${situation.context}\n\n${proactiveInstruction(config, source, historicalAt ?? Date.now(), !!session.isGroup)}` });
        if (historicalAt !== undefined) prompt.llmMessages.push({ role: "system", content: "本轮场景时间以调度事件给出的时间为准。沿用当前聊天的文字分条格式表达；此轮只生成文字交流，保持沉默时返回 <proactive-skip/>。" });
        let raw = await sendLLMRequest(prompt.config, prompt.preset, prompt.llmMessages, prompt.regexes, undefined,
            { appId: session.isGroup ? "group_chat" : "chat", appTags: tags, signal: controller.signal, debugSessionId: session.id });
        if (!valid() || lastMessage(session.id) !== anchor) return;
        if (prepareProactiveSituation(session, loadChatMessages(session.id), candidateReplayAt, Date.now()).fingerprint !== situation.fingerprint) return;
        if (prompt.preset?.online_thinking_enabled) {
            raw = stripOnlineThinkingTag(raw, prompt.preset.online_thinking_tag?.trim() || "thinking");
        }
        raw = stripPresetTexts(raw, prompt.preset);
        const finishOpportunity = async (visible: boolean) => {
            const current = loadProactive(session.id);
            if (current?.state.revision !== state.revision) return;
            const now = Date.now();
            const latest = loadChatMessages(session.id).at(-1);
            const next = anchorPlan(config, state.revision, !!session.isGroup, latest ? `${latest.id}:${latest.createdAt}` : "empty", now, loadPushQuietHours(), now);
            saveProactiveState(session.id, { ...next, configuredAt: current.state.configuredAt, cycleFloorAt: now, handledAt: now,
                handledMessageIds: visible ? loadChatMessages(session.id).filter(m => !originalMessageIds.has(m.id)).map(m => m.id) : current.state.handledMessageIds,
                followupCount: !visible && source === "followup" ? Math.max(current.state.followupCount, session.isGroup ? loadFollowUpConfig().maxConsecutive : maxFollowUps(config))
                    : session.isGroup && source !== "followup" ? 0 : current.state.followupCount });
            await flushProactive();
        };
        if (!raw.trim()) throw new Error("主动消息返回空内容，未完成本轮机会。");
        if (/^<proactive-skip\s*\/>$/i.test(raw.trim())) { await finishOpportunity(false); return; }
        const results = "nameToId" in prompt ? parseGroupChatResponse(raw, prompt.nameToId)
            : [{ characterId: session.contactId, characterName: prompt.character.name, responseText: raw }];
        const { parseAndSaveResponse } = await import("./follow-up-service");
        const generatedAt = new Date().toISOString();
        let visible = false;
        const savedSpeakers = new Set<string>();
        for (const result of results) {
            if (!valid()) break;
            const canPersist = () => valid() && (!session.isGroup || loadChatSessions().some(s => s.id === session.id
                && s.participantIds?.includes(result.characterId) && !isGroupMuted(s, result.characterId)
                && loadCharacters().some(c => c.id === result.characterId)));
            if (!canPersist()) continue;
            const saved = await parseAndSaveResponse(result.responseText, session.id, 0, undefined, history,
                { canPersist, ...(session.isGroup ? { senderCharacterId: result.characterId, senderName: result.characterName, responseRoundId } : {}),
                    ...(historicalAt !== undefined ? { createdAt: new Date(historicalAt).toISOString(), historicalReplay: true,
                        proactiveTiming: { scheduledAt: new Date(historicalAt).toISOString(), generatedAt, backfilled: true } } : {}) });
            visible ||= saved.hasVisible;
            if (saved.hasVisible) savedSpeakers.add(result.characterId);
        }
        if (visible && valid()) {
            await finishOpportunity(true);
            schedulePersonalityFollowUp(session.id, source === "followup" ? record.state.followupCount + 1 : session.isGroup ? 0 : record.state.followupCount);
            // Preserve memory accounting, without inventing a user message for this event.
            const { incrementEventCounter } = await import("./memory-storage");
            const { maybeRunSummarization } = await import("./memory-summarizer");
            for (const id of savedSpeakers) {
                const character = loadCharacters().find(c => c.id === id);
                if (character) { incrementEventCounter(id); void maybeRunSummarization(id, character.name).catch(console.warn); }
            }
        } else if (!visible && valid()) await finishOpportunity(false);
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
