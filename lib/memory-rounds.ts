import type { NativeTimelineEntry } from "./short-term-assembler";
import { compareMemoryTime } from "./memory-context-policy";

/** Count saved exchanges, not generation attempts or individual assistant bubbles. */
export function groupMemoryRounds(entries: NativeTimelineEntry[]): NativeTimelineEntry[] {
  const ordered = [...entries].sort((a,b)=>compareMemoryTime(a.timestamp,b.timestamp));
  const completed = new Map<string, NativeTimelineEntry[]>();
  const pending = new Map<string, NativeTimelineEntry[]>();
  const legacyRound = new Map<string,string>();
  for (const entry of ordered) {
    const channel = entry.dialogueSessionId;
    if (!channel || !entry.dialogueRole) { completed.set(`event:${entry.id}`,[entry]); continue; }
    if (entry.dialogueRole === "user") {
      pending.set(channel,[...(pending.get(channel)||[]),entry]); legacyRound.delete(channel); continue;
    }
    if (entry.dialogueRole !== "assistant") continue;
    const key = entry.responseUnitId ? `${channel}:${entry.responseUnitId}`
      : legacyRound.get(channel) || `${channel}:legacy:${entry.id}`;
    legacyRound.set(channel,key);
    const inputs = pending.get(channel)||[]; pending.delete(channel);
    completed.set(key,[...(completed.get(key)||[]),...inputs,entry]);
  }
  // Pending user-only input remains in source storage and is included when answered.
  return [...completed.values()].map(rows=> {
    rows.sort((a,b)=>compareMemoryTime(a.timestamp,b.timestamp));
    const last = rows[rows.length-1];
    return {...last, id: rows.length===1 ? last.id : `round:${rows[0].id}:${last.id}`,
      startTimestamp:rows[0].timestamp, content:rows.map(row=>row.content).join("\n"),
      sourceEntryIds:rows.flatMap(row=>row.sourceEntryIds||[row.id])};
  }).sort((a,b)=>compareMemoryTime(a.timestamp,b.timestamp));
}
