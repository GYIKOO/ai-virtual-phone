import { formatZonedPromptTimestamp } from "./character-time";

/** Metadata for records already selected by the caller, never an extra memory read. */
export function buildRecentTimeContext(
    records: { source: string; timestamp: string }[], at: number, timeZone: string,
): string {
    if (!Number.isFinite(at)) return "";
    const latest = new Map<string, number>();
    for (const record of records) {
        const timestamp = Date.parse(record.timestamp);
        if (Number.isFinite(timestamp) && timestamp <= at && timestamp > (latest.get(record.source) ?? -Infinity)) {
            latest.set(record.source, timestamp);
        }
    }
    if (!latest.size) return "";
    const rows = [...latest].map(([source, timestamp]) => {
        const minutes = Math.floor((at - timestamp) / 60000);
        const age = `${Math.floor(minutes / 1440)}天${Math.floor(minutes % 1440 / 60)}小时${minutes % 60}分钟`;
        return `${source}最近一条已载入记录：${formatZonedPromptTimestamp(new Date(timestamp), timeZone, true)}；距本轮 ${age}`;
    });
    return ["【近期记录的时间跨度】", `本轮参考时刻：${new Date(at).toISOString()}（UTC）`, ...rows].join("\n");
}
