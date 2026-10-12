import type { PresetConfig } from "./settings-types";

const LEGACY_MOMENTS_OPTIONAL_ACTIONS = "<optional_actions>\n你也可以在回复中附带给{{user}}发私信，或是在群聊中发言，以下是具体规范：\n#发消息/私信:\n【格式】\n[消息]消息内容[/消息]\n\n【示例】（像真人发微信：拆成多条短消息，每条都用一对 [消息][/消息] 单独包裹）\n[消息]刚才看到你发的朋友圈了，你在杭州？[/消息]\n[消息]怎么不提前跟我说一声。[/消息]\n[消息]晚上想吃什么，我查查附近。[/消息]\n\n【要求】\n- 一条消息只说一件事；超过一两句就拆成多条，每条独立包裹，禁止把一大段话塞进同一个 [消息] 块\n- 只在有合理理由时才发，不要刻意\n\n\n#发送群聊消息:\n【格式】\n[群消息 \"群聊名称\"]消息内容[/群消息]\n\n【示例】\n[群消息 \"好友群\"]大家晚上有空吗？[/群消息]\n\n【要求】\n- 群聊名称必须是你所在的群聊名\n- 只在有合理理由时才发，不要刻意\n\n\n这是可选动作，只在情境自然时使用。\n</optional_actions>";

export const DEFAULT_MOMENTS_OPTIONAL_ACTIONS = LEGACY_MOMENTS_OPTIONAL_ACTIONS
    .replace("你也可以在回复中附带给{{user}}发私信，或是在群聊中发言，以下是具体规范：",
        "朋友圈发布、评论、私聊和群聊是各自独立的表达选择，本轮可以只在朋友圈完成互动。需要转到聊天时，使用以下格式：")
    .replace("- 只在有合理理由时才发，不要刻意",
        "- 私聊的动机来自这条动态与{{user}}的直接关联，或双方已有的亲近关系与角色一贯的生活分享习惯。结合话题是否值得单独说、双方平时的相处分寸，决定是否私聊。")
    .replace("[消息]刚才看到你发的朋友圈了，你在杭州？[/消息]\n[消息]怎么不提前跟我说一声。[/消息]\n[消息]晚上想吃什么，我查查附近。[/消息]",
        "[消息]你之前问的那本书，我刚读完了。[/消息]\n[消息]结尾那一段，想单独和你聊聊。[/消息]");

/** Migrate only an untouched built-in entry, preserving switches, order and custom presets. */
export function migrateBuiltinMomentsActions(preset: PresetConfig): PresetConfig {
    if (!preset.builtIn || !preset.prompts.some(p => p.identifier === "moments_optional_actions"
        && p.content === LEGACY_MOMENTS_OPTIONAL_ACTIONS)) return preset;
    return { ...preset, prompts: preset.prompts.map(p => p.identifier === "moments_optional_actions"
        && p.content === LEGACY_MOMENTS_OPTIONAL_ACTIONS ? { ...p, content: DEFAULT_MOMENTS_OPTIONAL_ACTIONS } : p) };
}

