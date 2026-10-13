import { kvGet, kvSetAsync, kvRefresh, registerKvMigration } from "./kv-db";
import { loadCalendarConfig, loadCalendarWeekPlan, refreshCalendarData } from "./calendar-storage";
import { loadCharacters } from "./character-storage";
import { getWeekStartIso } from "./calendar-utils";

const KEY = "ai_phone_calendar_auto_runs_v1";
registerKvMigration(KEY);
type Attempt = { week: string; done?: boolean; attempts: number; retryAt: number; error?: string };
type Runs = Record<string, Attempt>;
let started = false;
let busy = false;
let timer: ReturnType<typeof setInterval> | undefined;
let controller: AbortController | undefined;

function runs(): Runs {
  try {
    const value = JSON.parse(kvGet(KEY) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, r]) => r && typeof r === "object" && typeof (r as Attempt).week === "string")) as Runs;
  } catch { return {}; }
}
async function write(id: string, value: Attempt) {
  // Retain only the current week's small execution ledger, not a simulated life history.
  const state = Object.fromEntries(Object.entries(runs()).filter(([, r]) => r.week === value.week));
  await kvSetAsync(KEY, JSON.stringify({ ...state, [id]: value }));
}
function selected(id: string): boolean {
  return loadCalendarConfig().autoGenerateCharacterIds.includes(id) && loadCharacters().some(c => c.id === id);
}
function due(now: number): string[] {
  const week = getWeekStartIso(new Date(now));
  const state = runs();
  return loadCalendarConfig().autoGenerateCharacterIds.filter(id => {
    if (!selected(id)) return false;
    if (loadCalendarWeekPlan("character", id, week)?.items.some(item => item.source === "generated")) return false;
    const previous = state[id];
    return previous?.week !== week || (!previous.done && previous.attempts < 3 && previous.retryAt <= now);
  });
}

/** Pollers call this before automatic model calls; explicit user actions remain available. */
export function deferAutomaticForCalendar(): boolean {
  if (!started || typeof document === "undefined") return false;
  if (!busy && !document.hidden) {
    const ids = due(Date.now());
    if (ids.length) {
      busy = true; // Reserve priority synchronously before any import or API await.
      void generateBatch(ids).catch(error => console.warn("[CalendarAuto]", error)).finally(() => { busy = false; });
    }
  }
  return busy;
}

async function generateBatch(ids: string[]) {
  for (const id of ids) {
    if (!started || document.hidden) break;
    if (!due(Date.now()).includes(id)) continue;
    const execute = async () => {
      await Promise.all([kvRefresh(KEY), refreshCalendarData()]);
      if (!started || document.hidden || !due(Date.now()).includes(id)) return;
      const at = Date.now();
      const week = getWeekStartIso(new Date(at));
      const old = runs()[id];
      const attempts = (old?.week === week ? old.attempts : 0) + 1;
      await write(id, { week, attempts, retryAt: at + 15 * 60_000 });
      if (!started || document.hidden || !selected(id)) return;
      const active = new AbortController();
      controller = active;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const { generateWeeklyCalendarSchedule } = await import("./calendar-engine");
        const result = await Promise.race([
          generateWeeklyCalendarSchedule("character", id, week, {
            automatic: true, referenceTime: at, signal: active.signal,
            canSave: () => started && !active.signal.aborted && selected(id) && getWeekStartIso(new Date()) === week,
          }),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => { active.abort(); reject(new Error("日程生成超时")); }, 120_000); }),
        ]);
        if (!result.success) throw new Error(result.error || "日程生成失败");
        await write(id, { week, attempts, done: true, retryAt: 0 });
      } catch (error) {
        await write(id, { week, attempts, retryAt: Date.now() + 15 * 60_000, error: error instanceof Error ? error.message : "日程生成失败" });
      } finally {
        if (timeout) clearTimeout(timeout);
        if (controller === active) controller = undefined;
        window.dispatchEvent(new Event("calendar-updated"));
      }
    };
    // Cooperate with another open Float tab when the browser supports Web Locks.
    if (typeof navigator !== "undefined" && navigator.locks) {
      await navigator.locks.request("float-calendar-auto", { ifAvailable: true }, async lock => { if (lock) await execute(); });
    } else await execute();
  }
}

function check() { deferAutomaticForCalendar(); }
export function startCalendarAutoService() {
  if (started) return;
  started = true;
  window.addEventListener("calendar-config-updated", check);
  document.addEventListener("visibilitychange", check);
  timer = setInterval(check, 60_000);
  check();
}
export function stopCalendarAutoService() {
  started = false;
  controller?.abort();
  if (timer) clearInterval(timer);
  timer = undefined;
  window.removeEventListener("calendar-config-updated", check);
  document.removeEventListener("visibilitychange", check);
}
