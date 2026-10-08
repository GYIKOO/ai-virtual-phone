import type { MemoryEntry } from "./memory-types";

export type MemoryEventRange = { start: number; end: number };
function instant(value: unknown): number | undefined {
    // Date-only and unzoned values cannot support precise elapsed-time claims.
    if (typeof value !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return undefined;
    const at = Date.parse(value);
    return Number.isFinite(at) ? at : undefined;
}
export function memoryEventRange(entry: MemoryEntry): MemoryEventRange | undefined {
    const meta = entry.metadata;
    let start = instant(meta?.eventStartAt);
    let end = instant(meta?.eventEndAt);
    if (start === undefined || end === undefined) {
        // Legacy core spans describe summary creation dates, not event dates.
        const span = entry.type === "long_term" && typeof meta?.timeSpan === "string" ? meta.timeSpan.split(" ~ ") : [];
        start = instant(span[0]); end = instant(span[1]);
    }
    if (start === undefined || end === undefined) start = end = instant(meta?.eventDate);
    return start !== undefined && end !== undefined && start <= end ? { start, end } : undefined;
}
function age(at: number, referenceAt: number): string {
    const hours = Math.floor(Math.abs(referenceAt - at) / 3_600_000);
    const distance = hours < 1 ? "不足1小时" : hours < 24 ? `${hours}小时` : `${Math.floor(hours / 24)}天${hours % 24}小时`;
    return `${distance}${at <= referenceAt ? "前" : "后"}`;
}
/** Metadata is evidence about a source interval, not an exact date for every event in a summary. */
export function formatMemoryEntry(entry: MemoryEntry, referenceAt = Date.now()): string {
    const range = memoryEventRange(entry);
    let timing: string;
    if (range) {
        const start = new Date(range.start).toISOString();
        const end = new Date(range.end).toISOString();
        timing = range.start === range.end
            ? `事件时间：${start}；距本轮参考时间约${age(range.start, referenceAt)}`
            : `来源事件时间范围：${start} ～ ${end}；范围起点约${age(range.start, referenceAt)}，终点约${age(range.end, referenceAt)}`;
    } else {
        const eventDate = entry.metadata?.eventDate;
        timing = typeof eventDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(eventDate)
            ? `事件日期：${eventDate}（具体时刻未知）`
            : "事件发生时间未记录";
        const recordedAt = instant(entry.createdAt);
        if (recordedAt !== undefined) timing += `；记忆保存于${new Date(recordedAt).toISOString()}（非事件时间）`;
    }
    return `- [${timing}]\n  ${entry.content}`;
}
