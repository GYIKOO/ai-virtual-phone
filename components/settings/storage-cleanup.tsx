"use client";
import { useState } from "react";
import { scanStorageCleanup, cleanStorageCandidates, type CleanupReport } from "@/lib/storage-cleanup";
import { cleanOrphanChats } from "@/lib/orphan-chat-cleanup";
import { formatBytes } from "@/lib/data-management/backup";

export function StorageCleanup() {
    const [report, setReport] = useState<CleanupReport | null>(null);
    const [busy, setBusy] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [selectedChats, setSelectedChats] = useState<Set<string>>(new Set());
    const [confirm, setConfirm] = useState<"media" | "chats" | null>(null);
    const [notice, setNotice] = useState("");
    const [limit, setLimit] = useState(100);
    const run = async (action: "scan" | "media" | "chats" = "scan") => {
        setBusy(true); setNotice(""); setConfirm(null);
        try {
            if (action === "chats" && report) {
                const result = await cleanOrphanChats(report.orphanChats.filter(item => selectedChats.has(item.id)));
                setNotice(`已清理 ${result.count} 个孤立私聊，跳过 ${result.skipped} 个发生变化的会话。可再次扫描释放不再被引用的媒体；已删除记录只能从事先的备份恢复。`);
                setReport(null); setSelectedChats(new Set()); setSelected(new Set());
            } else if (action === "media" && report) {
                const result = await cleanStorageCandidates(report.media.filter(m => selected.has(m.id)));
                setNotice(`已删除 ${result.count} 个本地媒体文件，约 ${formatBytes(result.bytes)}；跳过 ${result.skipped} 个发生变化的项目。删除不可撤销，可从事先导出的完整备份恢复。`);
                setReport(null); setSelected(new Set());
            } else {
                setReport(await scanStorageCleanup()); setSelected(new Set()); setSelectedChats(new Set()); setLimit(100);
            }
        } catch (e) { setNotice(e instanceof Error ? e.message : "操作失败，请重新扫描。"); setReport(null); }
        finally { setBusy(false); }
    };
    return <section className="menu-group p-4 space-y-3">
        <div className="menu-label">残留数据扫描</div>
        <p className="menu-desc">仅检查当前设备、当前站点。可选择清理角色卡已不存在的私聊，以及保存超过24小时、未发现引用的图片与音频。群聊、有效角色的私聊、云端文件和用途不明的文件不自动删除。</p>
        <p className="menu-desc">清理前请导出完整备份，关闭其他 Float 标签页，并暂停生成、导入与编辑操作。扫描不改动数据，清理会再次复核引用。</p>
        <button className="ui-btn ui-btn-secondary" disabled={busy} onClick={() => void run()}>{busy ? "正在处理…" : "扫描残留数据"}</button>
        {notice && <p role="status" className="menu-desc">{notice}</p>}
        {report && <>
            <p className="menu-desc">已读取 {report.databases} 个数据库。可清理媒体 {report.media.length} 个，约 {formatBytes(report.media.reduce((sum, m) => sum + m.bytes, 0))}；保留或待确认 {report.protectedCount} 个。实际存储配额释放可能延迟。</p>
            {report.errors.length > 0 && <p role="alert">媒体引用扫描不完整，已禁用媒体清理：{report.errors.join("；")}</p>}
            {report.mediaWarnings.map(message => <p key={message} className="menu-desc">{message}</p>)}
            {report.chatErrors.length > 0 && <p role="alert">孤立私聊清理不可用：{report.chatErrors.join("；")}</p>}
            {report.orphanChats.length > 0 && <details><summary>孤立私聊（{report.orphanChats.length}个，默认不选）</summary>
                <p className="menu-desc">这些私聊绑定的角色卡已不存在。清理会删除所选会话的线上消息、线下记录和会话级任务，不通知角色，不删除其他应用的记忆或共享媒体。</p>
                <button className="ui-btn ui-btn-ghost" disabled={busy} onClick={() => { setConfirm(null); setSelectedChats(selectedChats.size === report.orphanChats.length ? new Set() : new Set(report.orphanChats.map(item => item.id))); }}>全选／取消全选孤立私聊</button>
                <div className="max-h-64 overflow-auto space-y-2">{report.orphanChats.map(item => <label key={item.id} className="flex items-start gap-2 menu-desc break-all">
                    <input type="checkbox" disabled={busy} checked={selectedChats.has(item.id)} onChange={event => { setConfirm(null); setSelectedChats(previous => { const next = new Set(previous); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; }); }} />
                    <span>{item.name} · 线上消息 {item.messageCount} 条 · 线下记录 {item.offlineCount} 条<br />角色ID：{item.characterId}<br />会话ID：{item.id}</span>
                </label>)}</div>
                <button className="ui-btn ui-btn-secondary" disabled={busy || selectedChats.size === 0 || report.chatErrors.length > 0} onClick={() => setConfirm("chats")}>清理所选 {selectedChats.size} 个私聊</button>
            </details>}
            {report.media.length > 0 && <details><summary>查看并选择媒体文件（默认不选）</summary>
                <button className="ui-btn ui-btn-ghost" disabled={busy} onClick={() => { setConfirm(null); setSelected(selected.size === report.media.length ? new Set() : new Set(report.media.map(m => m.id))); }}>{selected.size === report.media.length ? "取消全选" : "全选扫描结果"}</button>
                <div className="max-h-64 overflow-auto space-y-2">{report.media.slice(0, limit).map(m => <label key={m.id} className="flex items-start gap-2 menu-desc break-all">
                    <input type="checkbox" disabled={busy} checked={selected.has(m.id)} onChange={e => { setConfirm(null); setSelected(prev => { const next = new Set(prev); if (e.target.checked) next.add(m.id); else next.delete(m.id); return next; }); }} />
                    <span>{m.category === "audio" ? "音频" : "图片"} · {formatBytes(m.bytes)} · {new Date(m.createdAt).toLocaleDateString()}<br />{m.id}</span>
                </label>)}</div>
                {report.media.length > limit && <button className="ui-btn ui-btn-ghost" disabled={busy} onClick={() => setLimit(n => n + 100)}>再显示100项（全选覆盖全部扫描结果）</button>}
            </details>}
            {report.issues.length > 0 && <details><summary>角色关联待核实（{report.issues.length}处，仅报告）</summary>
                <p className="menu-desc">可能包含已删除角色的记录、绑定或特殊内部ID，并不代表数据可删除。相关媒体仍按现存引用保留。</p>
                <div className="max-h-64 overflow-auto">{report.issues.map(i => <p key={i.source} className="menu-desc break-all">{i.source}：{i.count}个关联</p>)}</div>
            </details>}
            <button className="ui-btn ui-btn-secondary" disabled={busy || selected.size === 0 || report.errors.length > 0} onClick={() => setConfirm("media")}>清理所选 {selected.size} 个媒体文件</button>
            {confirm && <div role="alert" className="space-y-2"><p className="menu-desc">确认已备份并暂停其他操作？{confirm === "chats" ? `将删除所选 ${selectedChats.size} 个私聊及其线上消息、线下记录与会话级任务。` : "只删除所选本地媒体，不删除对话。"}此操作不可撤销。</p>
                <button className="ui-btn ui-btn-danger" disabled={busy} onClick={() => void run(confirm)}>确认清理</button>
                <button className="ui-btn ui-btn-ghost" onClick={() => setConfirm(null)}>取消</button>
            </div>}
        </>}
    </section>;
}
