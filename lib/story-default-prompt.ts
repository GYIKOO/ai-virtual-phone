import type { PresetConfig } from "./settings-types";

const LEGACY_MODE = "【模式】你当前处于剧情模式。这不是即时通讯聊天，而是连续推进的长文本互动场景。";
const LEGACY_CONTEXT = "【上下文】assistant 是你在剧情模式中之前说过或叙述过的内容，user 是 {{user}} 在剧情模式中的输入；<charDescription>、<worldInfoBefore>、<worldInfoAfter> 中是你的人设与背景；<memoryCore>、<memoryLongTerm> 和 <shortTermMemory> 是你可以调用的记忆与近期事件。";
const LEGACY_STYLE = "- 语言风格必须符合 {{char}} 的人设和当前情境";
const MODE = "【模式】你负责创作连续发展的互动故事。依据人物资料、世界设定与已有经历，组织场景、叙述、人物对白和行动，推动情节发展。{{char}} 是故事中的角色，{{user}} 是用户操控的故事人物；对 {{user}} 的代写范围按当前抢话设置与用户预设执行。";
const CONTEXT = "【上下文】assistant 是先前生成的剧情文本，user 是用户提交的剧情输入或创作要求；<charDescription> 是角色资料，<personaDescription> 是用户人物资料，<worldInfoBefore>、<worldInfoAfter> 是世界设定；<memoryCore>、<memoryLongTerm> 和 <shortTermMemory> 提供人物经历与近期事件。各人物的知识与反应依据其自身经历和当前情境展开。";
const STYLE = "- 各人物的对白、行动和心理符合各自的人设与情境；叙述文风、人称和视角遵循当前预设与剧情设置";

/** Editable factory entry, not an unconditional engine instruction. */
export const DEFAULT_STORY_OUTPUT_PROMPT = [
    "<story_output_format>",
    "【时间】{{timeContext}}",
    "当前正在进行的日程：{{当前日程}}",
    MODE,
    CONTEXT,
    "【写作要求】",
    "- 回复必须输出两个 XML 字段：<content> 和 <summary>",
    "- <content> 中写剧情正文，不要拆成多条微信短消息",
    "- <summary> 中写本轮剧情摘要，用于 recent_story 和记忆提取",
    "- 允许动作描写、环境描写、神态描写、情绪变化和心理活动",
    "- 允许人物对白和叙述混排，但整体必须保持自然流畅",
    "- 回复要承接上一轮剧情，推动场景继续向前发展",
    STYLE,
    "",
    "【严格禁止】",
    "- 禁止输出 [好感度:X]、[占有欲:X]、[焦虑值:X] 等状态值标签",
    "- 禁止输出 [内心]...[/内心] 标签",
    "- 禁止输出红包、转账、表情包、拍一拍、名片、语音通话、视频通话等聊天协议指令",
    "- 禁止把回复写成微信聊天那种一行一条的即时消息格式",
    "- 禁止输出任何解释性前缀，例如“以下是剧情回复”",
    "- 禁止在 <content> / <summary> 头部或任何位置输出时间戳或时间标签（如 `[2026-05-22 14:30]`、`(14:30)` 等）。系统会自动给每条消息附加时间，你再输出会重复显示；正文里需要的叙事性时间描写（「那天黄昏」等）不算。",
    "",
    "【格式】",
    "- 仅输出 XML 本体，不要附加额外说明",
    "- <content> 保留正常段落结构",
    "- <summary> 保持简洁，概括关键事件、关系变化、情绪推进",
    "- 允许用户通过正则对你的输出再做进一步样式转换，因此不要主动删除你自己输出中的结构化文本",
    "",
    "【模板】",
    "<content>",
    "这里写剧情正文",
    "</content>",
    "<summary>",
    "这里写剧情摘要",
    "</summary>",
    "</story_output_format>",
].join("\n");

// Exact whole-entry matching: never edit a user's custom wording or reset a preset.
const LEGACY_STORY_OUTPUT_PROMPT = DEFAULT_STORY_OUTPUT_PROMPT
    .replace(MODE, LEGACY_MODE).replace(CONTEXT, LEGACY_CONTEXT).replace(STYLE, LEGACY_STYLE);

export function migrateBuiltinStoryNarration(preset: PresetConfig): PresetConfig {
    if (!preset.builtIn || !preset.prompts.some(prompt => prompt.identifier === "story_output_format"
        && prompt.content === LEGACY_STORY_OUTPUT_PROMPT)) return preset;
    return {
        ...preset,
        prompts: preset.prompts.map(prompt => prompt.identifier === "story_output_format"
            && prompt.content === LEGACY_STORY_OUTPUT_PROMPT
            ? { ...prompt, content: DEFAULT_STORY_OUTPUT_PROMPT } : prompt),
    };
}
