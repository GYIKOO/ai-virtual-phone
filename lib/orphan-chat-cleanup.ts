import { hydrateKvDb, isKvHydrated, kvGet } from "./kv-db";

export type OrphanChatSnapshot = {
    id: string; contactId: string; isGroup?: boolean; participantIds?: string[];
    groupName?: string; alias?: string; updatedAt?: string;
};
export type OrphanChatCandidate = {
    id: string; characterId: string; name: string; updatedAt: string;
    messageCount: number; offlineCount: number;
};

export function orphanChatCandidate(session: OrphanChatSnapshot, characterIds: Set<string>, messageCount: number, offlineCount: number): OrphanChatCandidate | null {
    if (typeof session?.id !== "string" || !session.id || typeof session.contactId !== "string" || !session.contactId || session.isGroup || session.groupName || session.participantIds?.length
        || ["self", "user", "system"].includes(session.contactId) || session.contactId.startsWith("group_")
        || characterIds.has(session.contactId)) return null;
    return { id: session.id, characterId: session.contactId, name: session.alias || "未绑定角色的私聊",
        updatedAt: session.updatedAt || "", messageCount, offlineCount };
}

function currentCharacterIds(): Set<string> {
    const cards = JSON.parse(kvGet("ai_phone_characters_v1") || "null");
    if (!Array.isArray(cards) || cards.some(card => !card || typeof card.id !== "string" || !card.id)) {
        throw new Error("角色列表读取不完整，未继续清理。");
    }
    return new Set(cards.map(card => card.id));
}

let cleaning = false;
/** Explicit selection only; reuse normal session deletion, never simulate unfriending. */
export async function cleanOrphanChats(selected: OrphanChatCandidate[]): Promise<{ count: number; skipped: number }> {
    if (cleaning) throw new Error("清理正在进行，请稍后再试。");
    cleaning = true;
    let count = 0;
    try {
        await hydrateKvDb();
        if (!isKvHydrated()) throw new Error("本地数据尚未完整载入，未删除任何对话。");
        const chat = await import("./chat-storage");
        const { chatDb } = await import("./chat-db");
        const { removeChatSessionCompletely } = await import("./chat-session-remove");
        await chat.hydrateChatStorage();
        if (!chat.isChatStorageHydrated()) throw new Error("聊天记录读取不完整，未删除任何对话。");
        for (const old of new Map(selected.map(item => [item.id, item])).values()) {
            const session = chat.loadChatSessions().find(item => item.id === old.id);
            if (!session) continue;
            const saved = await chatDb.sessions.get(old.id);
            if (!saved) continue;
            const savedMessageCount = await chatDb.messages.where("sessionId").equals(old.id).count();
            const rawOffline = kvGet(`ai_phone_chat_offline_turns:${old.id}`);
            const offline = rawOffline ? JSON.parse(rawOffline) : [];
            if (!Array.isArray(offline)) throw new Error("线下记录读取不完整。");
            // Recheck both disk and the live cache after all awaits. Newly restored
            // cards, rebound sessions or changed histories are never deleted.
            const live = chat.loadChatSessions().find(item => item.id === old.id);
            const ids = currentCharacterIds();
            const candidate = live && orphanChatCandidate(live, ids, chat.loadChatMessages(old.id).length, offline.length);
            if (!candidate || !orphanChatCandidate(saved, ids, 0, 0) || saved.contactId !== old.characterId
                || (saved.updatedAt || "") !== old.updatedAt || savedMessageCount !== old.messageCount
                || candidate.characterId !== old.characterId || candidate.updatedAt !== old.updatedAt
                || candidate.messageCount !== old.messageCount || candidate.offlineCount !== old.offlineCount) continue;
            removeChatSessionCompletely(old.id);
            // Queued IDB writes must be visible before reporting completion.
            if (await chatDb.sessions.get(old.id) || await chatDb.messages.where("sessionId").equals(old.id).count()) {
                throw new Error("对话清理未完整保存，请重新扫描。");
            }
            count++;
        }
        return { count, skipped: new Set(selected.map(item => item.id)).size - count };
    } catch (error) {
        throw new Error(`清理已停止，已完成 ${count} 个会话。${error instanceof Error ? error.message : "读取或保存失败。"}`);
    } finally { cleaning = false; }
}
