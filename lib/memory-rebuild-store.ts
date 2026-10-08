import { openMemoryRebuildDb, MEMORY_REBUILD_JOBS as JOBS, MEMORY_REBUILD_BATCHES as BATCHES, restoreMemoryWatermarks, adjustMemoryEventCounter } from "./memory-storage";
import { memorySnapshot, protectedMemory, type RebuildJob, type RebuildBatch } from "./memory-rebuild-policy";
import type { MemoryEntry } from "./memory-types";

const request = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
function finished(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error("记忆事务已中止，未完成替换。")); tx.onerror = () => reject(tx.error); });
}
export async function readRebuildJob(characterId: string): Promise<RebuildJob | undefined> {
    const db = await openMemoryRebuildDb();
    try { return await request(db.transaction(JOBS).objectStore(JOBS).get(characterId)); } finally { db.close(); }
}
export async function readRebuildBatches(jobId: string): Promise<RebuildBatch[]> {
    const db = await openMemoryRebuildDb();
    try {
        const batches = await request<RebuildBatch[]>(db.transaction(BATCHES).objectStore(BATCHES).index("by_job").getAll(jobId));
        return batches.sort((a, b) => a.index - b.index);
    } finally { db.close(); }
}
/** Caller owns the character Web Lock. Batch result and its checkpoint commit together. */
export async function writeRebuildJob(job: RebuildJob, batches: RebuildBatch[] = []): Promise<void> {
    const db = await openMemoryRebuildDb();
    try {
        const tx = db.transaction([JOBS, BATCHES], "readwrite");
        const done = finished(tx);
        tx.objectStore(JOBS).put(job);
        for (const batch of batches) tx.objectStore(BATCHES).put(batch);
        await done;
    } finally { db.close(); }
}
/** Repair a crash between the atomic memory swap and the legacy KV watermark update. */
export async function reconcileRebuildProgress(characterId: string): Promise<RebuildJob | undefined> {
    const job = await readRebuildJob(characterId);
    if (job?.progressPending) {
        await restoreMemoryWatermarks(characterId, job.progressPending.longTerm, job.progressPending.core);
        if (job.progressPending.counterAdjustment) await adjustMemoryEventCounter(characterId, job.progressPending.counterAdjustment);
        delete job.progressPending;
        await writeRebuildJob(job);
    }
    return job;
}
export async function swapRebuild(jobId: string, characterId: string, rollback: boolean, maxEntries: number, counterDelta?: number): Promise<void> {
    const db = await openMemoryRebuildDb();
    try {
        const tx = db.transaction([JOBS, BATCHES, "memories"], "readwrite");
        const done = finished(tx);
        let problem: Error | undefined;
        const fail = (message: string) => { problem = new Error(message); tx.abort(); };
        const jobReq = tx.objectStore(JOBS).get(characterId);
        jobReq.onsuccess = () => {
            const job = jobReq.result as RebuildJob | undefined;
            if (!job || job.id !== jobId || job.status !== (rollback ? "applied" : "ready")) { fail("任务状态已改变，请刷新后重试。"); return; }
            const rowsReq = tx.objectStore(BATCHES).index("by_job").getAll(job.id);
            rowsReq.onsuccess = () => {
                const batches = rowsReq.result as RebuildBatch[];
                if (batches.length !== job.totalBatches || batches.some(b => !b.result || b.result.characterId !== characterId)) { fail("重建结果不完整，未修改旧记忆。"); return; }
                const generated = batches.map(b => b.result!);
                const kept = job.baseline.filter(protectedMemory);
                const relevant = (e: MemoryEntry) => e.type === "long_term" || job.includeCore;
                const expected = rollback ? [...kept, ...generated] : job.baseline;
                const replacement = rollback ? job.baseline : [...kept, ...generated];
                const currentReq = tx.objectStore("memories").index("by_character").getAll(characterId);
                currentReq.onsuccess = () => {
                    const current = currentReq.result as MemoryEntry[];
                    if (memorySnapshot(current.filter(relevant)) !== memorySnapshot(expected)) { fail("该角色的记忆已新增、删除或修改。为保护这些变更，已停止替换；原库和重建结果均保留。"); return; }
                    const finalCount = current.filter(e => !relevant(e)).length + replacement.length;
                    if (!rollback && finalCount > maxEntries) { fail(`启用后共 ${finalCount} 条记忆，超过现有上限 ${maxEntries}；请调整上限或重新选择更大的分批量，未自动删除任何记忆。`); return; }
                    for (const entry of current.filter(relevant)) tx.objectStore("memories").delete(entry.id);
                    for (const entry of replacement) tx.objectStore("memories").put(entry);
                    job.status = rollback ? "rolled_back" : "applied";
                    if (!rollback && counterDelta !== undefined) job.appliedCounterDelta = counterDelta;
                    job.progressPending = rollback ? { ...job.beforeProgress } : {
                        longTerm: job.summarizedThrough ?? job.cutoff,
                        core: generated.filter(e => e.type === "long_term").map(e => e.createdAt).sort().at(-1) ?? job.beforeProgress.core,
                    };
                    if (job.appliedCounterDelta !== undefined) job.progressPending.counterAdjustment = {
                        id: `${job.id}:${rollback ? "rollback" : "apply"}`,
                        delta: rollback ? -job.appliedCounterDelta : job.appliedCounterDelta,
                    };
                    tx.objectStore(JOBS).put(job);
                };
            };
        };
        try { await done; } catch (error) { throw problem ?? error; }
    } finally { db.close(); }
    await reconcileRebuildProgress(characterId);
}
/** Deletes only this explicitly confirmed task's staging/rollback data, never active memories. */
export async function discardRebuild(characterId: string, expectedJobId: string): Promise<void> {
    const db = await openMemoryRebuildDb();
    try {
        const tx = db.transaction([JOBS, BATCHES], "readwrite");
        const done = finished(tx);
        const req = tx.objectStore(JOBS).get(characterId);
        req.onsuccess = () => {
            if (req.result?.id !== expectedJobId) { tx.abort(); return; }
            const keys = tx.objectStore(BATCHES).index("by_job").getAllKeys(expectedJobId);
            keys.onsuccess = () => { for (const key of keys.result) tx.objectStore(BATCHES).delete(key); tx.objectStore(JOBS).delete(characterId); };
        };
        await done;
    } finally { db.close(); }
}
