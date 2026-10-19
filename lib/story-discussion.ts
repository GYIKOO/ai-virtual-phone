import type { StoryMessage } from "./story-storage";
import { estimateTokens } from "./token-counter";
import { fullContextUnitIds, compareMemoryTime, type ContextDetail } from "./memory-context-policy";

export const STORY_DISCUSSION_TOKEN_LIMIT = 4000;
export type StoryDiscussion = { id: string; messages: StoryMessage[]; anchor: StoryMessage; brief?: StoryMessage; closed: boolean };

export function isStoryDiscussion(message: StoryMessage): boolean {
  return message.kind === "discussion" || message.kind === "discussion-brief" || message.kind === "discussion-end";
}

export function storyDiscussions(messages: StoryMessage[]): StoryDiscussion[] {
  const groups = new Map<string, StoryMessage[]>();
  for (const message of messages) {
    if (!isStoryDiscussion(message) || !message.discussionId) continue;
    const group = groups.get(message.discussionId) || [];
    group.push(message); groups.set(message.discussionId, group);
  }
  return [...groups].map(([id, rows]) => ({ id, messages: rows, anchor: rows.at(-1)!,
    brief: [...rows].reverse().find(row => row.kind !== "discussion-end")?.kind === "discussion-brief"
      ? [...rows].reverse().find(row => row.kind === "discussion-brief") : undefined,
    closed: rows.at(-1)?.kind === "discussion-end" || rows.at(-1)?.kind === "discussion-brief" }))
    .sort((a,b)=>compareMemoryTime(a.anchor.createdAt,b.anchor.createdAt));
}

export function discussionTranscript(messages: StoryMessage[]): string {
  return messages.filter(message => message.kind !== "discussion-end")
    .map(message => `${message.kind === "discussion-brief" ? "已确认的后续要求" : message.role === "user" ? "用户" : "AI"}：${message.rawContent}`).join("\n\n");
}

/** Newest complete exchanges first; the caller must first apply the prose full-text window. */
export function limitDiscussionTranscripts(groups: StoryDiscussion[], limit = STORY_DISCUSSION_TOKEN_LIMIT): Map<string, string> {
  const result = new Map<string, string>();
  let remaining = limit;
  for (const group of [...groups].reverse()) {
    if (group.brief) continue;
    const rounds: StoryMessage[][] = [];
    for (const message of group.messages.filter(row => row.kind === "discussion" || row.kind === "discussion-brief")) {
      if (message.role === "user" || !rounds.length) rounds.push([message]);
      else rounds.at(-1)!.push(message);
    }
    const retained: StoryMessage[][] = [];
    let reachedLimit = false;
    for (const round of rounds.reverse()) {
      const cost = estimateTokens(discussionTranscript(round)) + 16;
      if (cost > remaining) { reachedLimit = true; break; }
      retained.unshift(round); remaining -= cost;
    }
    if (retained.length) result.set(group.id, discussionTranscript(retained.flat()));
    if (reachedLimit) break;
  }
  return result;
}

export function discussionReference(text: string, confirmed: boolean): string {
  return `${confirmed ? "已确认的近期创作要求" : "近期创作讨论（包含备选想法，按用户确认情况采用）"}；以下是作者层面的交流，不是已经发生的剧情或角色记忆。\n${text}`;
}

export function discussionSourceSignature(messages: StoryMessage[]): string {
  return JSON.stringify(messages.map(row=>[row.id,row.role,row.kind,row.discussionId,row.rawContent,row.createdAt]));
}

/** Conservative local-page warning. Cross-page recent events may narrow this window further. */
export function discussionExitMayOmitText(messages: StoryMessage[], detail?: ContextDetail): boolean {
  const groups = storyDiscussions(messages);
  const prose = messages.filter(row=>!row.kind && row.role !== "system");
  const units = prose.map((row,index)=>({ id: row.id, unitId: row.role === "user" && prose[index+1]?.role === "assistant" ? prose[index+1].id : row.id,
    timestamp: row.createdAt, text: row.rawContent, narrative: true }));
  const full = fullContextUnitIds([...units,...groups.map(group=>({ id: `discussion:${group.id}`,timestamp:group.anchor.createdAt,text:"",narrative:true }))],detail);
  const eligible = groups.filter(group=>!group.brief && full.has(`discussion:${group.id}`));
  const kept = limitDiscussionTranscripts(eligible);
  return eligible.some(group=>discussionTranscript(group.messages) !== (kept.get(group.id)||""));
}

export const STORY_DISCUSSION_PROMPT = "当前进入剧情讨论。请以写作助手身份与用户交流，结合人物资料、已有剧情和写作要求，分析文本问题、讨论人物塑造与后续情节。以自然语言直接回复用户；本轮是作者层面的讨论，不生成剧情正文、事件摘要或执行动作。对原因的分析以可核对的文本和规则为依据，将推测与已知问题区分。";
export const STORY_DISCUSSION_BRIEF_PROMPT = "请根据这段讨论及目前已经推进的剧情，整理一份接下来可以直接采用的创作要求。清楚写明需要纠正的具体问题、应遵循的规则，以及双方已经确定的情节方向与桥段；保留关键细节和适用条件。备选方案和未定事项明确标为未定，已经完成的计划按当前进展处理。直接输出供用户审阅、修改的要求正文。";
