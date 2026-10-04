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

export function wrapStoryInstruction(text: string): string {
  const escaped = text.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `以下是用户仅针对本次生成的创作指令，不是人物对白或已经发生的事件。请按指令生成剧情；事件摘要只记录正文实际发生的事情，不记录创作指令本身。\n<Request>\n${escaped}\n</Request>`;
}

export function getStoryRetryContext(messages: StoryMessage[], messageId: string): StoryMessage[] | null {
  const index = messages.findIndex(message => message.id === messageId);
  if (index < 0 || !["user", "assistant"].includes(messages[index].role)) return null;
  return messages.slice(0, messages[index].role === "user" ? index + 1 : index);
}
