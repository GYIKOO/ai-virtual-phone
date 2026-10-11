import type { StoryMessage } from "./story-storage";

/** Stored director notes are only active until their corresponding reply exists. */
export function prepareStoryInstructionHistory(messages: StoryMessage[]) {
  let lastInput = messages.length - 1;
  while (lastInput >= 0 && messages[lastInput].role !== "user") lastInput--;
  const input = messages[lastInput];
  const pendingDirector = input?.kind === "director"
    && !messages.slice(lastInput + 1).some(message => message.role === "assistant");
  return {
    history: messages.filter(message => message.kind !== "director"),
    directorInstruction: pendingDirector ? input.rawContent : "",
  };
}

function escapeStoryInstruction(text: string): string {
  return text.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function wrapStoryInstruction(text: string): string {
  const escaped = escapeStoryInstruction(text);
  return `以下是用户仅针对本次生成的创作指令，不是人物对白或已经发生的事件。请按指令生成剧情；事件摘要只记录正文实际发生的事情，不记录创作指令本身。\n<Request>\n${escaped}\n</Request>`;
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
  return messages.slice(0, messages[index].role === "user" ? index + 1 : index);
}
