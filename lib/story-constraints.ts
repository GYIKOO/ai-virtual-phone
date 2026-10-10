import type { StoryCharacterSettings } from "./story-storage";

/** Editable defaults; only injected when explicitly enabled. */
export const DEFAULT_STORY_USER_AGENCY_PROMPT = "不要代替用户决定行动、对白或心理活动；将用户的选择留给用户。";
export const DEFAULT_STORY_MODERATE_USER_CONTROL_PROMPT = "本轮剧情采用适当代写用户，代写范围以本项要求为准，具体情节遵循用户输入与导演指令。结合用户人设、已表达的意图和当前情境，可以补充用户自然的动作、简短对白与即时心理反应，让互动连贯展开。重要决定、关系转折和影响后续走向的选择留给用户，在适合回应的位置交还叙事。";
export const DEFAULT_STORY_STRONG_USER_CONTROL_PROMPT = "本轮剧情采用充分代写用户，代写范围以本项要求为准，具体情节遵循用户输入与导演指令。将用户作为故事中的完整人物，与其他角色一同塑造。依据用户人设、人物关系和已有经历，主动描写用户的对白、行动、心理活动与选择，展开多轮互动并推动事件发展。可以由用户发起行动、作出决定或带来转折，使各方意图与行动共同驱动故事，连贯写完当前叙事段落。";

export type StoryUserControlMode = NonNullable<StoryCharacterSettings["userControlMode"]>;
export const DEFAULT_STORY_USER_CONTROL_ENDING_PROMPT = "抢话收尾要求：无论本轮代写用户的程度如何，剧情正文都不得以用户的行动或对白结束。最后一个叙事落点应是其他角色的言行，或用户可以回应的场景变化，留出明确、自然的接话空间，将下一步回应交还用户。";
export const STORY_USER_CONTROL_OPTIONS = [
  { value: "preset", label: "由预设决定", detail: "不追加抢话要求，沿用绑定预设。" },
  { value: "none", label: "不抢话", detail: "用户的言行、心理与选择由用户自己书写。" },
  { value: "moderate", label: "适当抢话", detail: "补充自然的言行反应，关键选择留给用户。" },
  { value: "strong", label: "强抢话", detail: "完整代写用户的言行、心理与选择，连贯推进故事。" },
] as const;

/** Keep old disabled/unset settings neutral; explicit new choices take priority. */
export function resolveStoryUserControlMode(settings?: StoryCharacterSettings): StoryUserControlMode {
  const mode = settings?.userControlMode;
  if (STORY_USER_CONTROL_OPTIONS.some((option) => option.value === mode)) return mode!;
  return settings?.preventUserControl ? "none" : "preset";
}

export function resolveStoryUserControlPrompt(settings?: StoryCharacterSettings): string {
  switch (resolveStoryUserControlMode(settings)) {
    case "none": return settings?.userAgencyPrompt ?? DEFAULT_STORY_USER_AGENCY_PROMPT;
    case "moderate": return settings?.moderateUserControlPrompt ?? DEFAULT_STORY_MODERATE_USER_CONTROL_PROMPT;
    case "strong": return settings?.strongUserControlPrompt ?? DEFAULT_STORY_STRONG_USER_CONTROL_PROMPT;
    default: return "";
  }
}

/** Shared by both takeover modes, including sessions with custom mode prompts. */
export function resolveStoryUserControlEndingPrompt(settings?: StoryCharacterSettings): string {
  const mode = resolveStoryUserControlMode(settings);
  if (mode !== "moderate" && mode !== "strong") return "";
  return settings?.userControlEndingPrompt ?? DEFAULT_STORY_USER_CONTROL_ENDING_PROMPT;
}

export const DEFAULT_STORY_VOICE_FORMAT_PROMPT = `# 剧情正文格式
- 「对白」：只包裹角色真正说出口的人声，每次说话分别包裹，不在括号内重复角色名。
- *心声*：包裹角色没有说出口的内心想法。
- 【场景】：单独一行，用于地点、时间或场景过场。
- ~强调~：只强调需要突出的短语。
- “……”：只用于非人声发出的声音，不作为角色对白。
旁白、动作以及用户的话不得写进「」；不要解释这些格式，也不要输出额外的语音清单。`;
