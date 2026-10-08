import type { ChatMessage, ChatSession } from "./chat-storage";
import { loadCharacters } from "./character-storage";
import { loadMemoryConfig } from "./memory-storage";
import { loadNativeTimeline, filterTimelineByAllowedSources } from "./short-term-assembler";
import { buildCharacterTimeContext } from "./character-time";

export function elapsedContactTime(timestamp: string, at: number): string {
    const minutes = Math.max(0, Math.floor((at - Date.parse(timestamp)) / 60000));
    if (!Number.isFinite(minutes)) return "时间未知";
    const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
    return `${days ? `${days}天` : ""}${hours ? `${hours}小时` : ""}${rest || (!days && !hours) ? `${rest}分钟` : ""}`;
}

/** Factual context at generation time; obey existing source/character/world isolation. */
export function prepareProactiveSituation(session: ChatSession, history: ChatMessage[], replayAt: number | undefined, now: number) {
    const conversation = history.filter(m => (m.role === "user" || m.role === "assistant") && !m.isRetracted && Date.parse(m.createdAt) <= now);
    const latest = conversation.at(-1);
    const after = latest ? Date.parse(latest.createdAt) : 0;
    const cross = session.isGroup ? [] : filterTimelineByAllowedSources(loadNativeTimeline(session.contactId, {
        timeAware: true, promptTimestampOptions: { timeZone: "UTC", includeTimeZone: true },
    }), loadMemoryConfig().shortTermAllowedSources).filter(e =>
        (e.sourceDetail === "group" || e.sourceDetail === "chat_offline" || e.sourceApp === "story")
        && Date.parse(e.timestamp) > after && Date.parse(e.timestamp) <= now
    ).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    // Replay currently cannot reconstruct mutable cross-app projections safely.
    // If newer shared experience exists, generate NOW with full current context
    // rather than silently dropping it or leaking it into a past timestamp.
    const historicalAt = cross.length ? undefined : replayAt;
    const at = historicalAt ?? now;
    const visible = conversation.filter(m => Date.parse(m.createdAt) <= at);
    const characters = loadCharacters();
    const ids = session.isGroup ? session.participantIds ?? [] : [session.contactId];
    const times = ids.flatMap(id => {
        const character = characters.find(c => c.id === id);
        return character ? [`${character.name}：${buildCharacterTimeContext(character.timeZone, new Date(at)).timeContext}`] : [];
    });
    const last = visible.at(-1), lastUser = visible.filter(m => m.role === "user").at(-1);
    const describe = (label: string, message: ChatMessage | undefined) => message
        ? `${label}：${new Date(message.createdAt).toISOString()}；距本轮 ${elapsedContactTime(message.createdAt, at)}；发言者：${message.role === "assistant" ? "角色" : "用户"}`
        : `${label}：无可用记录`;
    const context = [
        "【本轮主动交流的时间与经历】",
        `本轮时间 UTC：${new Date(at).toISOString()}`, ...times,
        describe("本会话最后一条交流", last), describe("用户在本会话最后一次发言", lastUser),
        "历史发言中的相对日期和约定，以该条记录发生时的时间为参照。本轮从此刻的生活状态出发，而不是停留在最后一句话的场景里。",
        "私聊的回复间隔只描述这段私聊；其间的群聊、见面和剧情经历同样构成双方的近况。邀约表示当时的意图，后续事件记录用于判断进展；记录未说明的结果保留为未知。",
        ...(cross.length ? ["上次本会话交流之后的近期经历（记录数据，按时间排序；更早内容见完整上下文）：",
            ...cross.slice(-8).map(e => JSON.stringify({ timeUTC: new Date(e.timestamp).toISOString(), elapsed: elapsedContactTime(e.timestamp, at), source: e.sourceDetail ?? e.sourceApp,
                content: e.content.length > 1200 ? `${e.content.slice(0, 1200)}…（节选）` : e.content }))] : []),
    ].join("\n");
    return { historicalAt, context, fingerprint: JSON.stringify(cross.map(e => [e.id, e.timestamp, e.content])) };
}
