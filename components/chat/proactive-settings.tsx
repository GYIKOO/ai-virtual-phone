"use client";

import { useState } from "react";
import type { ChatSession } from "@/lib/chat-storage";
import { Toggle } from "@/components/ui/form";
import { defaultProactiveConfig, DEFAULT_PROACTIVE_INSTRUCTION, type ProactiveConfig } from "@/lib/proactive-policy";
import { loadProactive, saveProactiveConfig } from "@/lib/proactive-storage";
import { assessProactive } from "@/lib/proactive-assessment";
import { loadCharacters } from "@/lib/character-storage";

export function ProactiveSettings({ session, allowed, managed = false }: { session: ChatSession; allowed: boolean; managed?: boolean }) {
    const [config, setConfig] = useState(() => loadProactive(session.id)?.config ?? defaultProactiveConfig());
    const [draft, setDraft] = useState(config.instruction);
    const [assessing, setAssessing] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const update = (patch: Partial<ProactiveConfig>) => {
        const latest = loadProactive(session.id)?.config ?? config;
        const saved = saveProactiveConfig(session.id, { ...latest, ...patch }, !!session.isGroup);
        setConfig(saved.config);
    };
    const stale = config.assessment && loadCharacters().find(c => c.id === session.contactId)?.updatedAt !== config.assessment.characterUpdatedAt;
    const assess = async () => {
        setAssessing(true); setError(""); setNotice("");
        const revision = loadProactive(session.id)?.state.revision;
        try {
            const result = await assessProactive(session.contactId);
            if (loadProactive(session.id)?.state.revision !== revision) {
                setError("评估期间设置已更改，本次结果未覆盖设置；可以重新评估。"); return;
            }
            update({ initiativeTier: result.initiativeTier, followUpTier: result.followUpTier,
                assessment: { reason: result.reason, assessedAt: result.assessedAt, characterUpdatedAt: result.characterUpdatedAt } });
        } catch (e) { setError(e instanceof Error ? e.message : "评估失败，原设置未修改"); }
        finally { setAssessing(false); }
    };
    return <div className={managed ? undefined : "menu-group"} style={{ padding: managed ? 0 : 16 }}>
        {!managed && <div className="flex items-center justify-between gap-3">
            <div><div className="menu-label">新版主动消息（测试）</div>
                <div className="menu-desc">启用后替代本会话的焦虑追发和冷场重连，保留明确的定时约定。</div></div>
            <Toggle checked={config.enabled} onChange={enabled => update({ enabled })} />
        </div>}
        {!allowed && <p className="menu-desc mt-2">会话总开关已关闭：不会触发主动消息。</p>}
        {(config.enabled || managed) && <div className="mt-4 space-y-4">
            {!managed && <p className="menu-desc">当前为本地测试版：页面运行时调度；关闭页面后的云端主动生成尚未接入。关闭新版开关会停止新版调度，不恢复旧焦虑追发。</p>}
            <div className="proactive-setting-heading flex justify-between gap-3"><span>定时联系</span><Toggle checked={config.fixedEnabled} onChange={fixedEnabled => update({ fixedEnabled })} /></div>
            {config.fixedEnabled && <label className="flex items-center justify-between gap-3">基础间隔（分钟）
                <input key={config.intervalMinutes} aria-label="主动消息基础间隔（分钟）" className="ui-input w-28" type="number" min={15} max={10080} defaultValue={config.intervalMinutes} onBlur={e => update({ intervalMinutes: Number(e.target.value) })} />
            </label>}
            <label className="flex items-center justify-between gap-3">随机波动 ±{config.jitterPercent}%
                <input aria-label="主动消息随机波动" type="range" min={0} max={50} step={5} value={config.jitterPercent} onChange={e => update({ jitterPercent: Number(e.target.value) })} />
            </label>
            {!session.isGroup && <>
                <div className="proactive-setting-heading flex justify-between gap-3"><span>符合人设的主动联系</span><Toggle checked={config.personalityEnabled} onChange={personalityEnabled => update({ personalityEnabled })} /></div>
                <p className="menu-desc">可与定时联系同时开启。两者共享冷却，避免连续触发；积极性不等同于好感或亲密程度。</p>
                <button type="button" className="ui-btn ui-btn-secondary" disabled={assessing} onClick={assess}>{assessing ? "正在评估…" : config.assessment ? "重新评估人设（调用一次 API）" : "评估人设（调用一次 API）"}</button>
                <p className="menu-desc">{config.assessment ? stale ? "角色卡已更新，可以重新评估。" : "已根据人设调整交流节奏。" : "未评估时使用适中的交流节奏。"}</p>
                {config.personalityEnabled && <>
                    <label className="flex justify-between gap-3">联系频率偏好
                        <select className="ui-input w-28" value={config.adjustment} onChange={e => update({ adjustment: Number(e.target.value) })}>
                            {([[-40, "更少联系"], [-20, "稍少联系"], [0, "按人设"], [20, "稍多联系"], [40, "更多联系"]] as const).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                    </label>
                </>}
                <p className="menu-desc">追发倾向随人设评估在后台更新，并结合本轮跟进意愿决定是否继续交流。等待范围和次数上限在「追发规则」统一设置。</p>
            </>}
            {session.isGroup && <p className="menu-desc">群成员可自行交流，无需等待你回复；每次生成一小轮对话，不循环触发。</p>}
            <details><summary>主动交流提示词（可修改）</summary>
                <textarea aria-label="主动交流提示词" className="ui-textarea mt-2 w-full" rows={8} value={draft} onChange={e => setDraft(e.target.value)} />
                <button type="button" className="ui-btn ui-btn-ghost mt-2 mr-2" onClick={() => { setDraft(DEFAULT_PROACTIVE_INSTRUCTION); setNotice("已载入新版默认文案，保存后生效"); }}>载入默认文案</button>
                <button type="button" className="ui-btn ui-btn-secondary mt-2" onClick={() => { update({ instruction: draft }); setNotice("提示词已保存"); }}>保存提示词</button>
            </details>
            <p className="menu-desc">新消息保存后重新计算交流时间。免打扰期间不主动发送，人设联系按半速计时；修改免打扰保留已抽取的时长。</p>
            {loadProactive(session.id)?.state.lastError && <p role="status" className="menu-desc">{loadProactive(session.id)?.state.lastError}</p>}
            {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
        </div>}
    </div>;
}
