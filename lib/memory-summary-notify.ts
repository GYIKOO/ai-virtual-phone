import { loadMemoryConfig } from "./memory-storage";

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Called after a complete offline turn is saved; coalesce same-session notifications. */
export function notifySavedMemoryRound(sessionId: string): void {
  if (typeof window === "undefined") return;
  const config = loadMemoryConfig();
  if (!config.autoSummarizeEnabled || config.summarizationRoundInterval === undefined) return;
  clearTimeout(timers.get(sessionId));
  timers.set(sessionId,setTimeout(async()=>{
    timers.delete(sessionId);
    try {
      const [{loadChatSessions},{loadCharacters},{maybeRunSummarization}] = await Promise.all([
        import("./chat-storage"),import("./character-storage"),import("./memory-summarizer")]);
      const session=loadChatSessions().find(row=>row.id===sessionId);
      if (!session) return;
      const ids=new Set(session.isGroup?session.participantIds:[session.contactId]);
      for (const character of loadCharacters().filter(row=>ids.has(row.id))) await maybeRunSummarization(character.id,character.name);
    } catch(error) { console.warn("[Memory] Saved-round summary check failed",error); }
  },2000));
}
