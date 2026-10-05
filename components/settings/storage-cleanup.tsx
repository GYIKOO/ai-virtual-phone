"use client";
import { useState } from "react";
import { scanStorageCleanup, cleanStorageCandidates, type CleanupReport } from "@/lib/storage-cleanup";
import { formatBytes } from "@/lib/data-management/backup";

export function StorageCleanup() {
    const [report, setReport] = useState<CleanupReport | null>(null);
    const [busy, setBusy] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [confirm, setConfirm] = useState(false);
    const [notice, setNotice] = useState("");
    const [limit, setLimit] = useState(100);
    const run = async (remove = false) => {
        setBusy(true); setNotice(""); setConfirm(false);
        try {
            if (remove && report) {
                const result = await cleanStorageCandidates(report.media.filter(m => selected.has(m.id)));
                setNotice(`已删除 ${result.count} 个本地媒体文件，约 ${formatBytes(result.bytes)}；跳过 ${result.skipped} 个发生变化的项目。删除不可撤销，可从事先导出的完整备份恢复。`);
                setReport(null); setSelected(new Set());
            } else {
                setReport(await scanStorageCleanup()); setSelected(new Set()); setLimit(100);
            }
        } catch (e) { setNotice(e instanceof Error ? e.message : "操作失败，请重新扫描。"); setReport(null); }
        finally { setBusy(false); }
    };
    return <section className="menu-group p-4 space-y-3">
        <div className="menu-label">残留数据扫描</div>
        <p className="menu-desc">仅检查当前设备、当前站点。跨应用扫描本地引用；只清理保存超过24小时、未发现引用的图片与音频。旧记录、云端文件、主题素材和用途不明的文件不自动删除。</p>
        <p className="menu-desc">清理前请导出完整备份，关闭其他 Float 标签页，并暂停生成、导入与编辑操作。扫描不改动数据，清理会再次复核引用。</p>
        <button className="ui-btn ui-btn-secondary" disabled={busy} onClick={() => void run()}>{busy ? "正在处理…" : "扫描残留数据"}</button>
        {notice && <p role="status" className="menu-desc">{notice}</p>}
        {report && <>
            <p className="menu-desc">已读取 {report.databases} 个数据库。可清理媒体 {report.media.length} 个，约 {formatBytes(report.media.reduce((sum, m) => sum + m.bytes, 0))}；保留或待确认 {report.protectedCount} 个。实际存储配额释放可能延迟。</p>
            {report.errors.length > 0 && <p role="alert">扫描不完整，已禁用清理：{report.errors.join("；")}</p>}
            {report.media.length > 0 && <details><summary>查看并选择媒体文件（默认不选）</summary>
                <button className="ui-btn ui-btn-ghost" disabled={busy} onClick={() => { setConfirm(false); setSelected(selected.size === report.media.length ? new Set() : new Set(report.media.map(m => m.id))); }}>{selected.size === report.media.length ? "取消全选" : "全选扫描结果"}</button>
                <div className="max-h-64 overflow-auto space-y-2">{report.media.slice(0, limit).map(m => <label key={m.id} className="flex items-start gap-2 menu-desc break-all">
                    <input type="checkbox" disabled={busy} checked={selected.has(m.id)} onChange={e => { setConfirm(false); setSelected(prev => { const next = new Set(prev); if (e.target.checked) next.add(m.id); else next.delete(m.id); return next; }); }} />
                    <span>{m.category === "audio" ? "音频" : "图片"} · {formatBytes(m.bytes)} · {new Date(m.createdAt).toLocaleDateString()}<br />{m.id}</span>
                </label>)}</div>
                {report.media.length > limit && <button className="ui-btn ui-btn-ghost" disabled={busy} onClick={() => setLimit(n => n + 100)}>再显示100项（全选覆盖全部扫描结果）</button>}
            </details>}
            {report.issues.length > 0 && <details><summary>角色关联待核实（{report.issues.length}处，仅报告）</summary>
                <p className="menu-desc">可能包含已删除角色的记录、绑定或特殊内部ID，并不代表数据可删除。相关媒体仍按现存引用保留。</p>
                <div className="max-h-64 overflow-auto">{report.issues.map(i => <p key={i.source} className="menu-desc break-all">{i.source}：{i.count}个关联</p>)}</div>
            </details>}
            <button className="ui-btn ui-btn-secondary" disabled={busy || selected.size === 0 || report.errors.length > 0} onClick={() => setConfirm(true)}>清理所选 {selected.size} 项</button>
            {confirm && <div role="alert" className="space-y-2"><p className="menu-desc">确认已备份并暂停其他操作？只删除所选本地媒体，不删除对话。此操作不可撤销。</p>
                <button className="ui-btn ui-btn-danger" disabled={busy} onClick={() => void run(true)}>确认清理</button>
                <button className="ui-btn ui-btn-ghost" onClick={() => setConfirm(false)}>取消</button>
            </div>}
        </>}
    </section>;
}
