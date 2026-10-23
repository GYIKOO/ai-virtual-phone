import type { StoryMessage } from "./story-storage";

/** Director notes last for three successful narrative replies, including the first. */
export function prepareStoryInstructionHistory(messages: StoryMessage[]) {
  let latestTurnInput: StoryMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.kind === "director" || (!message.kind && (message.role === "user" || message.role === "assistant"))) {
      latestTurnInput = message;
      break;
    }
  }
  const active: StoryMessage[] = [];
  let replies = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "assistant" && !message.kind && ++replies >= 3) break;
    if (message.kind === "director") active.unshift(message);
  }
  return {
    history: messages.filter(message => !message.kind),
    directorInstruction: active.map(message => message.rawContent).join("\n\n"),
    currentDirectorInstruction: latestTurnInput?.kind === "director" ? latestTurnInput.rawContent : "",
  };
}

function escapeStoryInstruction(text: string): string {
  return text.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function wrapStoryInstruction(text: string): string {
  const escaped = escapeStoryInstruction(text);
  return `以下是场外导演指令，按时间先后排列。以已有剧情的最新进展为起点，安排本轮新增的叙事内容。持续的写作要求用于当前生成，一次性情节安排结合已有进展执行；后续修订以较新的要求为准。这些是创作要求，不是人物对白或已经发生的事件；事件摘要只记录正文实际发生的事情。\n<Request>\n${escaped}\n</Request>`;
}

/** Retry notes describe an editorial revision, not necessarily new story material. */
export function wrapStoryRetryInstruction(text: string): string {
  const escaped = escapeStoryInstruction(text);
  return `以下是用户仅针对本次重写的编辑反馈，可能包含事实纠正、对旧稿的评价、表达调整或新的剧情方向。
请结合语义分别处理：事实纠正作为新版剧情的事实前提；旧稿问题用于调整相应内容与写法；剧情方向用于安排事件发展。
纠错在作者层面完成，正文自然呈现修订后的故事。角色的认知与经历以修正后的设定和剧情为依据；仅当反馈明确要求角色知情或把某事写入情节时，才将反馈本身转化为角色的对白、心理或剧情事件。
事件摘要只记录新版正文实际发生的事情。
<Request>
${escaped}
</Request>`;
}

export function getStoryRetryContext(messages: StoryMessage[], messageId: string): StoryMessage[] | null {
  const index = messages.findIndex(message => message.id === messageId);
  if (index < 0 || !["user", "assistant"].includes(messages[index].role)) return null;
  const context = messages.slice(0, messages[index].role === "user" ? index + 1 : index);
  const trailing = messages.slice(index + 1);
  // Retrying the latest prose must keep subsequent editorial work, including an
  // AI-authored confirmed brief. Older-turn retries still rewind the narrative.
  const hasLaterNarrative = trailing.some(message => !message.kind && (message.role === "user" || message.role === "assistant"));
  if (!hasLaterNarrative) {
    context.push(...trailing.filter(message => message.kind === "director" || message.kind === "discussion"
      || message.kind === "discussion-brief" || message.kind === "discussion-end"));
  }
  return context;
}
