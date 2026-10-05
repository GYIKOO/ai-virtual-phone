import { loadCharacters } from "./character-storage";
import { loadApiConfigs, loadBindingConfig, resolveBinding, resolveUserIdentity } from "./settings-storage";
import { sendLLMRequest } from "./chat-engine";

/** Only explicitly requested by the settings UI; never runs in the scheduler. */
export async function assessProactive(characterId: string): Promise<{ initiativeTier: number; followUpTier: number; reason: string; characterUpdatedAt: string; assessedAt: number }> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("找不到角色");
    const slot = resolveBinding(loadBindingConfig(), characterId, "chat");
    const api = loadApiConfigs().find(c => c.id === slot.apiConfigId);
    if (!api) throw new Error("请先为该角色配置聊天 API");
    const identity = resolveUserIdentity(characterId);
    const raw = await sendLLMRequest(api, null, [
        { role: "system", content: "评估角色日常主动联系和未获回复时补充联系的倾向，两者分别取0至4整数。主动程度0很低/1较低/2适中/3较高/4很高；追发0不追发/1偶尔一次/2一次/3最多两次/4最多三次。依据给出的人设和明确关系；未说明的关系保持未知，不默认恋爱、亲密、讨好或以用户为中心。职业不是机械评分规则；好感、外向、占有欲不等同追发。资料不足时使用主动2、追发0，并说明不确定性。这是参数评估，不是角色扮演；只返回JSON：{\"initiativeTier\":2,\"followUpTier\":0,\"reason\":\"简短依据\"}。" },
        { role: "user", content: JSON.stringify({ name: character.name, persona: character.persona, personality: character.personality, user: identity ? { name: identity.name } : undefined }) },
    ], [], undefined, { appId: "proactive_assessment", skipOutputRegex: true });
    const json = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const result = JSON.parse(json);
    for (const key of ["initiativeTier", "followUpTier"]) {
        if (!Number.isInteger(result[key]) || result[key] < 0 || result[key] > 4) throw new Error("评估结果格式不正确，未修改原设置");
    }
    if (typeof result.reason !== "string") throw new Error("评估未返回依据，未修改原设置");
    return { initiativeTier: result.initiativeTier, followUpTier: result.followUpTier, reason: result.reason.slice(0, 1000), characterUpdatedAt: character.updatedAt, assessedAt: Date.now() };
}
