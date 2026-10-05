"use client";

import { useEffect, useState } from "react";
import { PageShell } from "@/components/ui/page-shell";
import { loadCharacters } from "@/lib/character-storage";
import { loadChatContacts, loadChatSessions, createOrGetSession, type ChatSession } from "@/lib/chat-storage";
import { loadProactive, PROACTIVE_UPDATED } from "@/lib/proactive-storage";
import { setSessionProactiveEnabled } from "@/lib/proactive-controls";
import { ProactiveSettings } from "./proactive-settings";
import styles from "./proactive-manager.module.css";
import { loadPushQuietHours, savePushQuietHours } from "@/lib/push-client";
import { quietBounds } from "@/lib/proactive-clock";

export function ProactiveManager({ onBack, onLegacy }: { onBack: () => void; onLegacy: () => void }) {
    const [, refresh] = useState(0);
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<"all" | "single" | "group">("all");
    const [expanded, setExpanded] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [quiet, setQuiet] = useState(loadPushQuietHours);
    useEffect(() => {
        const update = () => refresh(n => n + 1);
        window.addEventListener(PROACTIVE_UPDATED, update);
        window.addEventListener("focus", update);
        return () => { window.removeEventListener(PROACTIVE_UPDATED, update); window.removeEventListener("focus", update); };
    }, []);
    const characters = loadCharacters();
    const sessions = loadChatSessions();
    const rows: { key: string; session?: ChatSession; characterId: string; group: boolean; name: string }[] = sessions.map(session => ({
        key: session.id, session, characterId: session.contactId, group: !!session.isGroup,
        name: session.isGroup ? session.groupName || "未命名群聊" : session.alias || characters.find(c => c.id === session.contactId)?.name || "未知角色",
    }));
    // Friends without messages/sessions must also be configurable, without opening a chat first.
    for (const contact of loadChatContacts()) {
        if (rows.some(row => !row.group && row.characterId === contact.characterId)) continue;
        const character = characters.find(c => c.id === contact.characterId);
        if (character) rows.push({ key: `contact:${character.id}`, characterId: character.id, group: false, name: character.name });
    }
    const visible = rows.filter(row => (filter === "all" || (filter === "group") === row.group)
        && row.name.toLowerCase().includes(query.trim().toLowerCase()));
    const change = (row: typeof rows[number], enabled: boolean) => {
        try {
            setError("");
            const session = row.session ?? createOrGetSession(row.characterId);
            setSessionProactiveEnabled(session.id, enabled);
            refresh(n => n + 1);
        } catch (e) { setError(e instanceof Error ? e.message : "设置失败"); }
    };
    return <PageShell title="主动消息" onBack={onBack} className="absolute inset-0 z-[100]">
        <div className={`page-menu profile-settings-menu ${styles.panel}`}>
            <p className="menu-desc">选择谁可以主动联系你，按角色或群聊调整交流节奏。</p>
            <section className="menu-group"><button className="menu-item" onClick={onLegacy}>
                <div className="menu-label-group text-left"><div className="menu-label">追发规则</div>
                <div className="menu-desc">跟进门槛、等待范围与连续追发上限</div></div><span aria-hidden="true">›</span>
            </button></section>
            <section className="menu-group p-4 space-y-2">
                <div className="menu-label">免打扰时间</div>
                <p className="menu-desc">与推送设置共用。期间主动联系与追发暂停，人设联系按半速计时；打开应用不会解除免打扰。</p>
                <input className="ui-input" aria-label="主动消息免打扰时间" placeholder="23:00-08:00；留空关闭" value={quiet} onChange={e => setQuiet(e.target.value)} />
                <button type="button" className="ui-btn ui-btn-secondary" onClick={() => {
                    if (quiet.trim() && !quietBounds(quiet.trim())) { setError("请输入不同的起止时间，例如23:00-08:00。"); return; }
                    savePushQuietHours(quiet); setError("");
                }}>保存免打扰</button>
            </section>
            <div className={styles.toolbar}>
            <input className="ui-input w-full" aria-label="搜索角色或群聊" placeholder="搜索角色或群聊" value={query} onChange={e => setQuery(e.target.value)} />
            <div className={styles.tabs} role="group" aria-label="会话类型">
                {([['all', '全部'], ['single', '角色'], ['group', '群聊']] as const).map(([value, label]) =>
                    <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
            </div>
            </div>
            {error && <p role="alert">{error}</p>}
            {visible.length === 0 && <p className="menu-desc">没有匹配的角色或群聊。添加好友或创建群聊后会在这里出现。</p>}
            {visible.map(row => {
                const record = row.session ? loadProactive(row.session.id) : undefined;
                const enabled = !!row.session && !row.session.proactiveDisabled && (record ? record.config.enabled : true);
                const label = !row.session ? "尚未配置" : record ? enabled ? "新版 · 已开启" : "已关闭" : enabled ? "旧机制 · 允许主动消息" : "已关闭 · 尚未切换新版";
                return <section key={row.key} className="menu-group">
                    <div className="menu-item">
                        <button type="button" className="menu-label-group text-left" aria-expanded={expanded === row.key} onClick={() => setExpanded(expanded === row.key ? null : row.key)}>
                            <div className="menu-label break-words">{row.name}</div>
                            <div className="menu-desc">{row.group ? "群聊" : "角色"} · {label}</div>
                        </button>
                        <button type="button" role="switch" aria-checked={enabled} aria-label={`${row.name}主动消息开关`}
                            className="ui-toggle shrink-0" data-ui="toggle" data-checked={enabled ? "" : undefined} onClick={() => change(row, !enabled)}>
                            <span className="ui-toggle-knob" />
                        </button>
                        <button type="button" className="ui-btn ui-btn-ghost" onClick={() => setExpanded(expanded === row.key ? null : row.key)}>{expanded === row.key ? "收起" : "配置"}</button>
                    </div>
                    {expanded === row.key && <div className={styles.expanded}>{record && row.session
                        ? <ProactiveSettings key={`${row.session.id}:${record.config.enabled}`} session={row.session} allowed={!row.session.proactiveDisabled} managed />
                        : <div className="mt-3 space-y-2"><p className="menu-desc">{row.session ? "此会话尚未迁移。原焦虑追发／冷场规则仍可能生效；关闭右侧开关可停止主动消息。" : "启用后会创建聊天会话并使用新版规则。"}</p>
                            <button type="button" className="ui-btn ui-btn-secondary" onClick={() => change(row, true)}>启用新版并配置</button></div>}</div>}
                </section>;
            })}
            <details className={styles.compatibility}><summary className="menu-desc">测试说明与旧版设置</summary>
                <p className="menu-desc mt-2">新版暂时仅在页面运行时调度。切换新版会替代该会话的焦虑追发与冷场规则；关闭后不会恢复旧机制。</p>
                <p className="menu-desc mt-2">追发规则入口同时提供旧机制字段的兼容设置。</p>
            </details>
        </div>
    </PageShell>;
}
