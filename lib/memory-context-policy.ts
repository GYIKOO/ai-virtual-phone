import { estimateTokens } from "./token-counter";

export type ContextDetail = "compact" | "standard" | "detailed";
export type RecentCandidate = {
  id: string;
  timestamp: string;
  text: string;
  summary?: string;
  narrative?: boolean;
  /** Only explicit same-response identities may join assistant bubbles. */
  unitId?: string;
  required?: boolean;
};
export type RecentSelection<T extends RecentCandidate> = { candidate: T; text: string };

export function compareMemoryTime(a: string, b: string): number {
  const left = Date.parse(a), right = Date.parse(b);
  return Number.isFinite(left) && Number.isFinite(right) ? left - right : a.localeCompare(b);
}

/** Request-local parsing reuse; never cache timezone-dependent dates across sends. */
export function createMemoryTimeComparator(): typeof compareMemoryTime {
  const parsed = new Map<string, number>();
  const time = (value: string) => {
    if (!parsed.has(value)) parsed.set(value, Date.parse(value));
    return parsed.get(value)!;
  };
  return (a, b) => {
    const left = time(a), right = time(b);
    return Number.isFinite(left) && Number.isFinite(right) ? left - right : a.localeCompare(b);
  };
}

/** Read-time preferences only: no persisted summary, age expiry or per-page allowances. */
export function recentContextPolicy(detail: ContextDetail = "standard") {
  return detail === "compact" ? { fullUnits: 5, narrativeUnits: 3 }
    : detail === "detailed" ? { fullUnits: 20, narrativeUnits: 8 }
      : { fullUnits: 10, narrativeUnits: 5 };
}

/** Shared by history adapters and the scene packer. Input is already visibility-filtered. */
export function selectRecentContext<T extends RecentCandidate>(
  candidates: T[], budget: number, detail: ContextDetail = "standard",
  cost: (text: string, candidate: T) => number = text => estimateTokens(text) + 16,
): RecentSelection<T>[] {
  const compareTime = createMemoryTimeComparator();
  // Same identity with conflicting text is not safely interchangeable.
  const unique = new Map<string, T>();
  for (const item of candidates) unique.set(JSON.stringify([item.id, item.text, item.summary || ""]), item);
  const ordered = [...unique.values()].sort((a, b) => compareTime(a.timestamp, b.timestamp) || a.id.localeCompare(b.id));
  const groups = new Map<string, T[]>();
  for (const item of ordered) {
    const key = item.unitId || item.id;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const units = [...groups.values()].sort((a, b) => compareTime(b.at(-1)!.timestamp, a.at(-1)!.timestamp));
  const policy = recentContextPolicy(detail);
  const narratives = units.filter(unit => unit.some(item => item.narrative)).slice(0, policy.narrativeUnits);
  const full = new Set([...units.slice(0, policy.fullUnits), ...narratives]);
  const limit = budget > 0 ? budget : Infinity;
  const selected = new Map<T[], RecentSelection<T>[]>();
  let used = 0;
  const take = (unit: T[], allowance: number, fullOnly = false) => {
    if (selected.has(unit)) return;
    const variants = fullOnly ? [false] : full.has(unit) ? [false, true] : [true];
    for (const compact of variants) {
      const rows = unit.map(candidate => ({ candidate, text: compact ? candidate.summary?.trim() || candidate.text : candidate.text }));
      const size = rows.reduce((sum, row) => sum + cost(row.text, row.candidate), 0);
      if (size > Math.min(limit - used, allowance)) continue;
      selected.set(unit, rows); used += size; return;
    }
  };
  for (const unit of units.filter(unit=>unit.some(item=>item.required))) {
    take(unit, limit-used, true);
    if (!selected.has(unit)) throw new Error("本轮完整输入超过近期上下文预算，请提高容量或缩短输入后重试。");
  }
  const requiredUsed = used;
  const discretionary = limit - requiredUsed;
  // Two reservations inside ONE budget, not additional budgets per source/participant.
  for (const unit of narratives) take(unit, Math.max(0, discretionary * .4 - (used-requiredUsed)));
  const beforeRecent = used;
  for (const unit of units) { if (used - beforeRecent >= discretionary * .4) break; take(unit, discretionary * .4 - (used - beforeRecent), true); }
  for (const unit of units) take(unit, limit - used);
  return [...selected.values()].flat().sort((a, b) => compareTime(a.candidate.timestamp, b.candidate.timestamp) || a.candidate.id.localeCompare(b.candidate.id));
}
