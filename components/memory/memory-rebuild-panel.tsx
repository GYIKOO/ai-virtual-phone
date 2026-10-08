"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, RotateCcw } from "lucide-react";
import { BottomSheet, ConfirmDialog } from "@/components/ui/modal";
import { loadMemoryConfig } from "@/lib/memory-storage";
import { readRebuildBatches, readRebuildJob } from "@/lib/memory-rebuild-store";
import type { RebuildJob, RebuildBatch } from "@/lib/memory-rebuild-policy";
import { MEMORY_REBUILD_UPDATED, applyMemoryRebuild, createMemoryRebuild, discardMemoryRebuild, isMemoryRebuildRunning,
    pauseMemoryRebuild, previewMemoryRebuild, rollbackMemoryRebuild, runMemoryRebuild, type RebuildPreview } from "@/lib/memory-rebuild";

const LABELS: Record<RebuildJob["status"], string> = { paused: "已暂停 / 待开始", running: "处理中 / 中断后可继续", failed: "已停止，等待重试", ready: "已完成，等待确认启用", applied: "已启用，保留回退副本", rolled_back: "已回退到旧记忆" };
type Confirm = "start" | "apply" | "discard" | "rollback";
export function MemoryRebuildPanel({ characterId, characterName, onChanged }: { characterId: string; characterName: string; onChanged: () => void }) {
    const [open, setOpen] = useState(false);
    const [job, setJob] = useState<RebuildJob>();
    const [batchSize, setBatchSize] = useState(() => loadMemoryConfig().summarizationEventInterval);
    const [inputTokens, setInputTokens] = useState(8000);
    const [includeCore, setIncludeCore] = useState(false);
    const [preview, setPreview] = useState<RebuildPreview>();
    const [samples, setSamples] = useState<RebuildBatch[]>([]);
    const [confirm, setConfirm] = useState<Confirm>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [pausing, setPausing] = useState(false);
    const refresh = useCallback(async () => {
        try { setJob(await readRebuildJob(characterId)); } catch (err) { setError(String(err)); }
    }, [characterId]);
    useEffect(() => {
        void refresh();
        window.addEventListener(MEMORY_REBUILD_UPDATED, refresh);
        window.addEventListener("focus", refresh);
        const timer = window.setInterval(refresh, 3000);
        return () => { clearInterval(timer); window.removeEventListener(MEMORY_REBUILD_UPDATED, refresh); window.removeEventListener("focus", refresh); };
    }, [refresh]);
    useEffect(() => { if (job?.status !== "running") setPausing(false); }, [job?.status]);
    const act = async (work: () => Promise<void>) => {
        setBusy(true); setError("");
        try { await work(); await refresh(); onChanged(); }
        catch (err) { setError(err instanceof Error ? err.message : String(err)); }
        finally { setBusy(false); }
    };
    const resume = () => {
        setError(""); setPausing(false);
        void runMemoryRebuild(characterId).catch(err => setError(String(err))).finally(refresh);
    };
    const options = { batchSize, inputTokens, includeCore };
    const messages: Record<Confirm, string> = {
        start: `将仅为「${characterName}」分批重读历史，预计 ${preview?.batchCount ?? 0} 次长期总结调用${includeCore ? "，另有核心总结调用" : ""}${job?.embeddingApi ? "和向量调用" : "；若已配置向量 API，还会生成向量"}，可能产生费用。不会删除聊天记录，也不影响其他角色。旧记忆继续使用，完成后还需你确认启用。`,
        apply: `确认启用「${characterName}」的新记忆？将替换该角色的旧自动长期总结${job?.includeCore ? "和旧自动核心总结" : "，核心记忆保持原样"}。手动新增、编辑过的记忆保留。旧版保留一份回退副本；若启用后又有记忆变更，安全回退会被拦截，以保护新数据。`,
        discard: job?.status === "applied" ? `删除「${characterName}」的重建任务和旧版回退副本？删除后无法通过此入口回退。当前已启用的记忆、聊天和其他角色不变。`
            : `取消并清理「${characterName}」的重建任务？已生成的暂存结果和进度将被删除，无法继续此任务。正在使用的记忆和聊天记录不变。`,
        rollback: `将「${characterName}」恢复为本次重建前的记忆版本。只有启用后尚无记忆新增、删除或编辑时才能执行，聊天记录不变。`,
    };
    const confirmAction = () => {
        const action = confirm;
        setConfirm(undefined);
        void act(async () => {
            if (action === "start" && preview) { await createMemoryRebuild(characterId, options, preview.hash); setPreview(undefined); resume(); }
            if (action === "apply" && job) { await applyMemoryRebuild(characterId, job.id); setSamples([]); }
            if (action === "rollback" && job) { await rollbackMemoryRebuild(characterId, job.id); setSamples([]); }
            if (action === "discard" && job) { await discardMemoryRebuild(characterId, job.id); setSamples([]); setPreview(undefined); }
        });
    };
    return <>
        <div className="menu-group mt-3">
            <div className="menu-item">
                <RotateCcw size={18} className="shrink-0 opacity-60" />
                <div className="menu-label-group">
                    <span className="menu-label">重建该角色的长期记忆</span>
                    <span className="menu-desc">{job ? LABELS[job.status] : "重新整理历史 · 分批处理 · 可暂停续跑"}</span>
                </div>
                <div className="menu-right"><button type="button" className="ui-btn ui-btn-outline py-1 px-3 ts-12" onClick={() => { setOpen(true); setError(""); }}>管理</button></div>
            </div>
        </div>
        {open && <BottomSheet title={`${characterName} · 记忆重建`} onClose={() => setOpen(false)}>
            <div className="flex flex-col gap-4 text-left">
                <p className="menu-desc">只处理当前角色。原有「接着上次总结」仍保留；重建不是追加总结，不会删除原始聊天。</p>
                {error && <p role="alert" className="ts-12 text-red-600 whitespace-pre-wrap">{error}</p>}
                {!job ? <>
                    <label className="menu-label flex flex-col gap-2">每批最多处理的记录数
                        <input className="ui-input w-full" type="number" min={1} max={1000} value={batchSize} onChange={e => { setBatchSize(Number(e.target.value)); setPreview(undefined); }} />
                        <span className="menu-desc">默认沿用当前自动总结间隔；仅调整本次重建，不改变日常设置。</span>
                    </label>
                    <label className="menu-label flex flex-col gap-2">每次请求输入预算（估算 tokens）
                        <input className="ui-input w-full" type="number" min={1024} max={64000} step={1024} value={inputTokens} onChange={e => { setInputTokens(Number(e.target.value)); setPreview(undefined); }} />
                        <span className="menu-desc">超长记录会进一步拆分。须为模型输出预留空间；估算不等于模型精确计数。</span>
                    </label>
                    <label className="menu-label flex items-center gap-2"><input type="checkbox" checked={includeCore} onChange={e => { setIncludeCore(e.target.checked); setPreview(undefined); }} />同时基于新长期记忆重建核心记忆</label>
                    <p className="menu-desc">按当前记忆来源设置读取全部可用历史。剧情、线下沿用已有摘要；已删除记录无法恢复，独立剧情仍遵守原有隔离规则。</p>
                    <button className="ui-btn ui-btn-outline" disabled={busy} onClick={() => void act(async () => { setPreview(await previewMemoryRebuild(characterId, options)); })}>预览重建范围（不调用 API）</button>
                    {preview && <div className="menu-group p-3 flex flex-col gap-2">
                        <p className="menu-label">{preview.sourceCount} 条来源记录 → {preview.batchCount} 批长期总结</p>
                        <p className="menu-desc break-all">UTC：{preview.first} 至 {preview.last}</p>
                        <p className="menu-desc">来源：{preview.sources.join("、")} · 模型：{preview.model}</p>
                        <p className="menu-desc">保留 {preview.protectedCount} 条手动新增或编辑的记忆。{includeCore ? "核心总结将在长期总结完成后另外分批。" : "核心记忆不会随本次重建更新。"}</p>
                        <button className="ui-btn ui-btn-primary" disabled={busy} onClick={() => setConfirm("start")}>开始重建…</button>
                    </div>}
                </> : <>
                    <p className="menu-label">{LABELS[job.status]}</p>
                    <progress className="w-full" aria-label="重建进度" value={job.completed} max={job.totalBatches} />
                    <p className="menu-desc">已保存 {job.completed} / {job.totalBatches} 批 · {job.sourceCount} 条来源记录{job.includeCore && !job.corePlanned ? " · 核心批次稍后计算" : ""}</p>
                    <p className="menu-desc break-all">本次历史截止 UTC {job.cutoff} · {job.api.defaultModel}</p>
                    {job.error && <p role="alert" className="ts-12 text-red-600 whitespace-pre-wrap">{job.error}</p>}
                    {!["applied", "rolled_back"].includes(job.status) && <p className="menu-desc">旧记忆仍在使用。此角色的自动／手动总结暂缓，聊天照常保存；取消或启用后恢复。关闭页面后可能中断，再次进入点击继续即可。未保存的在途请求可能需要重新调用。</p>}
                    <div className="flex flex-wrap gap-2">
                        {["paused", "failed", "running"].includes(job.status) && !isMemoryRebuildRunning(characterId) && <button className="ui-btn ui-btn-primary" disabled={busy} onClick={resume}>继续 / 重试</button>}
                        {job.status === "running" && <button className="ui-btn ui-btn-outline" disabled={pausing} onClick={() => { setPausing(true); pauseMemoryRebuild(characterId); }}>{pausing ? "等待本批保存…" : "本批结束后暂停"}</button>}
                        {job.status === "ready" && <button className="ui-btn ui-btn-primary" disabled={busy} onClick={() => setConfirm("apply")}>确认启用…</button>}
                        {job.status === "applied" && <button className="ui-btn ui-btn-outline" disabled={busy} onClick={() => setConfirm("rollback")}>回退旧版…</button>}
                        <button className="ui-btn ui-btn-outline" disabled={busy} onClick={() => void act(async () => { setSamples((await readRebuildBatches(job.id)).filter(b => b.result).slice(-10)); })}>查看最近 10 批结果</button>
                        <button className="ui-btn ui-btn-ghost" disabled={busy || isMemoryRebuildRunning(characterId)} onClick={() => setConfirm("discard")}>{job.status === "applied" ? "删除回退副本…" : "取消 / 清理任务…"}</button>
                    </div>
                    {samples.map(batch => <details key={batch.id} className="menu-group p-3"><summary className="menu-label">第 {batch.index + 1} 批 · {batch.type === "core" ? "核心" : "长期"}</summary><p className="menu-desc break-all">{String(batch.result?.metadata?.timeSpan)}</p><p className="ts-12 whitespace-pre-wrap mt-2">{batch.result?.content}</p></details>)}
                </>}
            </div>
        </BottomSheet>}
        {confirm && <ConfirmDialog title={`${confirm === "start" ? "开始重建" : confirm === "apply" ? "启用新记忆" : confirm === "rollback" ? "回退旧记忆" : "清理重建数据"}「${characterName}」？`}
            message={messages[confirm]} icon={AlertCircle} variant="danger" confirmLabel={confirm === "start" ? "确认开始重建" : "确认"}
            onConfirm={confirmAction} onCancel={() => setConfirm(undefined)} />}
    </>;
}
