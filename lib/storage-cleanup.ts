"use client";

import { hydrateKvDb, isKvHydrated, kvEntries } from "./kv-db";
import { listMediaCacheSummaries, deleteMediaRef, MEDIA_STORE_PROTOCOL, type MediaCacheSummary } from "./media-cache-storage";

const GRACE = 24 * 60 * 60 * 1000;
const MEDIA_DB = "AiPhoneMediaCacheDB";
export type CleanupReport = {
    scannedAt: number;
    databases: number;
    media: MediaCacheSummary[];
    protectedCount: number;
    issues: { source: string; count: number }[];
    errors: string[];
};

/** Match IDs even inside JSON strings, URLs or HTML; inspect keys as well as values. */
export function collectMediaReferences(value: unknown, refs: Set<string>, seen = new WeakSet<object>()): void {
    if (typeof value === "string") {
        for (const match of value.matchAll(/mc_\d+_[a-z0-9]+/g)) refs.add(match[0]);
        // Embedded HTML/JSON can itself contain live media references. Unknown
        // encoded documents are not evidence of absence: fail closed instead.
        if (/data:(?:text\/|application\/(?:json|xml|javascript)|image\/svg\+xml)/i.test(value)) {
            refs.add("__opaque_document__");
        }
        return;
    }
    if (!value || typeof value !== "object" || value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value) || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Map) { for (const [k, v] of value) { collectMediaReferences(k, refs, seen); collectMediaReferences(v, refs, seen); } return; }
    if (value instanceof Set) { for (const v of value) collectMediaReferences(v, refs, seen); return; }
    for (const [k, v] of Object.entries(value)) { collectMediaReferences(k, refs, seen); collectMediaReferences(v, refs, seen); }
}
export function cleanupCandidates(media: MediaCacheSummary[], refs: Set<string>, now: number): MediaCacheSummary[] {
    return media.filter(m => /^mc_\d+_[a-z0-9]+$/.test(m.id) && ["image", "audio"].includes(m.category)
        && Number.isFinite(m.createdAt) && m.createdAt > 0 && now - m.createdAt >= GRACE && !refs.has(m.id));
}

function openExisting(name: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onupgradeneeded = () => request.transaction?.abort(); // Never create a missing DB.
        request.onerror = () => reject(new Error(`无法读取数据库 ${name}`));
        request.onblocked = () => reject(new Error(`数据库被占用 ${name}`));
        request.onsuccess = () => resolve(request.result);
    });
}
async function readStore(db: IDBDatabase, name: string, visit: (value: unknown, key: IDBValidKey) => void): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, "readonly");
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(new Error(`无法完整读取 ${db.name}/${name}`));
        const request = tx.objectStore(name).openCursor();
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            try { visit(cursor.value, cursor.primaryKey); cursor.continue(); }
            catch { tx.abort(); }
        };
    });
}

export async function scanStorageCleanup(): Promise<CleanupReport> {
    const report: CleanupReport = { scannedAt: Date.now(), databases: 0, media: [], protectedCount: 0, issues: [], errors: [] };
    await hydrateKvDb();
    if (!isKvHydrated()) throw new Error("本地数据尚未完整载入，已停止扫描。");
    if (!indexedDB.databases) throw new Error("当前浏览器无法枚举全部数据库，暂不支持安全残留清理。");
    const refs = new Set<string>();
    const characterIds = new Set<string>();
    const links: { source: string; id: string }[] = [];
    const readLinks = (value: unknown, source: string, depth = 0): void => {
        if (depth > 40 || !value || typeof value !== "object" || value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return;
        for (const [key, child] of Object.entries(value)) {
            if (key === "characterId" && typeof child === "string") links.push({ source, id: child });
            else if (key === "contactId" && typeof child === "string" && !(value as { isGroup?: boolean }).isGroup) links.push({ source, id: child });
            else readLinks(child, source, depth + 1);
        }
    };
    const visit = (value: unknown, source: string) => {
        collectMediaReferences(value, refs);
        if (typeof value === "string") { try { readLinks(JSON.parse(value), source); } catch { /* plain text */ } }
        else readLinks(value, source);
    };
    for (const { key, value } of kvEntries()) {
        visit(value, `设置数据 / ${key}`);
        collectMediaReferences(key, refs);
        if (key === "ai_phone_characters_v1") {
            const cards = JSON.parse(value);
            if (!Array.isArray(cards)) throw new Error("角色数据格式异常，已停止扫描。");
            for (const card of cards) if (typeof card?.id === "string") characterIds.add(card.id);
        }
    }
    // Include persistent and session storage, including draft/plugin references.
    for (const storage of [localStorage, sessionStorage]) for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key) { collectMediaReferences(key, refs); visit(storage.getItem(key), `浏览器数据 / ${key}`); }
    }
    const names = (await indexedDB.databases()).map(x => x.name).filter((x): x is string => !!x);
    for (const name of names) {
        let db: IDBDatabase | undefined;
        try {
            db = await openExisting(name);
            for (const store of Array.from(db.objectStoreNames)) {
                await readStore(db, store, (value, key) => {
                    if (name === MEDIA_DB && store === "entries") {
                        // A blob's own ID isn't a reference. Encoded documents may
                        // embed references that this first version cannot inspect.
                        const entry = value as { mimeType?: string; mediaCategory?: string };
                        if (entry.mediaCategory === "file" || /svg|text|json|xml|javascript/i.test(entry.mimeType ?? "")) refs.add("__opaque_document__");
                        return;
                    }
                    collectMediaReferences(key, refs); visit(value, `${name} / ${store}`);
                });
                await new Promise(resolve => setTimeout(resolve, 0));
            }
            report.databases++;
        } catch (error) { report.errors.push(error instanceof Error ? error.message : `读取失败：${name}`); }
        finally { db?.close(); }
    }
    // Re-read in-memory KV after the asynchronous scan: covers writes still being flushed.
    for (const row of kvEntries()) collectMediaReferences(row, refs);
    if (refs.has("__opaque_document__")) report.errors.push("发现内嵌文本文件，无法完整确认其媒体引用；保留所有媒体。");
    const summaries = names.includes(MEDIA_DB) ? await listMediaCacheSummaries() : [];
    report.media = report.errors.length ? [] : cleanupCandidates(summaries, refs, report.scannedAt);
    report.protectedCount = summaries.length - report.media.length;
    const grouped = new Map<string, Set<string>>();
    for (const link of links) if (!characterIds.has(link.id)) {
        const ids = grouped.get(link.source) ?? new Set<string>(); ids.add(link.id); grouped.set(link.source, ids);
    }
    report.issues = [...grouped].map(([source, ids]) => ({ source, count: ids.size }));
    return report;
}

let cleaning = false;
/** Delete only the user's selected scan candidates, and only if a fresh full scan agrees. */
export async function cleanStorageCandidates(selected: MediaCacheSummary[]): Promise<{ count: number; bytes: number; skipped: number }> {
    if (cleaning) throw new Error("清理正在进行，请勿重复操作。");
    cleaning = true;
    try {
        const fresh = await scanStorageCleanup();
        if (fresh.errors.length) throw new Error("复核读取不完整，未删除任何文件。");
        const wanted = new Map(selected.map(m => [m.id, m]));
        let count = 0, bytes = 0;
        for (const item of fresh.media) {
            const old = wanted.get(item.id);
            if (!old || old.bytes !== item.bytes || old.createdAt !== item.createdAt || old.category !== item.category) continue;
            const live = new Set<string>();
            for (const row of kvEntries()) collectMediaReferences(row, live);
            if (live.has(item.id) || live.has("__opaque_document__")) continue;
            try { await deleteMediaRef(MEDIA_STORE_PROTOCOL + item.id); }
            catch { throw new Error(`清理中断：已删除 ${count} 个文件（约 ${bytes} 字节），其余未继续处理。请重新扫描；已删除内容只能从事先的备份恢复。`); }
            count++; bytes += item.bytes;
        }
        return { count, bytes, skipped: wanted.size - count };
    } finally { cleaning = false; }
}
