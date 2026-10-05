import { loadChatSessions, saveChatSessions } from "./chat-storage";
import { defaultProactiveConfig } from "./proactive-policy";
import { loadProactive, saveProactiveConfig } from "./proactive-storage";
import { cancelProactiveForSession } from "./follow-up-service";

/** One switch controls both the session gate and the new scheduler. */
export function setSessionProactiveEnabled(sessionId: string, enabled: boolean): void {
    const sessions = loadChatSessions();
    const session = sessions.find(item => item.id === sessionId);
    if (!session) throw new Error("会话已不存在，请重新打开面板");
    saveChatSessions(sessions.map(item => item.id === sessionId ? { ...item, proactiveDisabled: !enabled } : item));
    if (!enabled) cancelProactiveForSession(sessionId);
    const config = loadProactive(sessionId)?.config ?? defaultProactiveConfig();
    saveProactiveConfig(sessionId, { ...config, enabled }, !!session.isGroup);
}
