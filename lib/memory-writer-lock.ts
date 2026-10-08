import { reconcileRebuildProgress } from "./memory-rebuild-store";
import { blocksMemorySummary } from "./memory-rebuild-policy";

const localLocks = new Set<string>();
export async function withMemoryWriterLock<T>(characterId: string, work: () => Promise<T>, requireCrossTab = false): Promise<T> {
    if (typeof navigator !== "undefined" && navigator.locks) {
        return navigator.locks.request(`float-memory-writer:${characterId}`, { ifAvailable: true }, lock => {
            if (!lock) throw new Error("该角色已有记忆操作正在运行，请稍后重试。");
            return work();
        });
    }
    if (requireCrossTab) throw new Error("当前环境不支持安全的跨标签页锁，暂不能重建记忆。请使用支持 Web Locks 的 HTTPS 浏览器或新版 APK。");
    if (localLocks.has(characterId)) throw new Error("该角色已有记忆操作正在运行。");
    localLocks.add(characterId);
    try { return await work(); } finally { localLocks.delete(characterId); }
}
export async function assertNoMemoryRebuild(characterId: string): Promise<void> {
    if (blocksMemorySummary(await reconcileRebuildProgress(characterId))) throw new Error("该角色有未完成的记忆重建，请先继续、启用或取消重建。旧记忆仍可用，聊天不受影响。");
}
