/** Editable defaults; only injected when explicitly enabled. */
export const DEFAULT_STORY_USER_AGENCY_PROMPT = "不要代替用户决定行动、对白或心理活动；将用户的选择留给用户。";
export const DEFAULT_STORY_VOICE_FORMAT_PROMPT = `# 剧情正文格式
- 「对白」：只包裹角色真正说出口的人声，每次说话分别包裹，不在括号内重复角色名。
- *心声*：包裹角色没有说出口的内心想法。
- 【场景】：单独一行，用于地点、时间或场景过场。
- ~强调~：只强调需要突出的短语。
- “……”：只用于非人声发出的声音，不作为角色对白。
旁白、动作以及用户的话不得写进「」；不要解释这些格式，也不要输出额外的语音清单。`;
