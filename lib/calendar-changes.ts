import type { CalendarCommitment, CalendarScheduleItem } from "./calendar-types";
import { loadCalendarStore, saveCalendarStoreAsync, refreshCalendarData, withCalendarWriteLock, type PersistedCalendarStore } from "./calendar-storage";
import { formatIsoDate, getWeekStartIso, getWeekdayLabel, isCalendarTimeRangeAllowed, pickScheduleColorKey } from "./calendar-utils";

export type CalendarChangeContext = {
  characterIds: string[];
  userIdentityId: string;
  app: string;
  sessionId?: string;
  messageId?: string;
  now: number;
  manual?: boolean;
};
export type CalendarChange = {
  op: "schedule.save" | "schedule.cancel" | "commitment.save" | "commitment.cancel" | "commitment.complete";
  characterId?: string;
  id?: string;
  title?: string;
  date?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  location?: string;
  participantIds?: string[];
};
export type PendingCalendarChanges = { id: string; revision: number; context: CalendarChangeContext; changes: CalendarChange[]; error?: string };
export const newCalendarChangeId = () => `calendar_change_${Date.now()}_${Math.random().toString(36).slice(2)}`;

function text(value: unknown, name: string, max: number, optional = false): string {
  if (optional && (value === undefined || value === null)) return "";
  if (typeof value !== "string" || (!optional && !value.trim()) || value.length > max) throw new Error(`${name}无效`);
  return value.trim();
}
export function validateCalendarDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || formatIsoDate(new Date(`${value}T12:00:00`)) !== value) throw new Error("请使用有效的 YYYY-MM-DD 日期");
  return value;
}
function dates(now: number) {
  const current = new Date(now), tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return [formatIsoDate(current), formatIsoDate(tomorrow)];
}
function checkMutableSchedule(item: Pick<CalendarScheduleItem,"date"|"endTime">, ctx: CalendarChangeContext) {
  if (ctx.manual) return;
  if (!dates(ctx.now).includes(item.date)) throw new Error("AI 只能调整系统日期对应的今天、明天的普通日程；远期安排请保存为约定");
  if (Date.parse(`${item.date}T${item.endTime}:00`) <= ctx.now) throw new Error("已结束的日程保留为历史记录");
}
function overlaps(a: Pick<CalendarScheduleItem,"date"|"startTime"|"endTime">, b: Pick<CalendarScheduleItem,"date"|"startTime"|"endTime">) {
  return a.date === b.date && a.startTime < b.endTime && a.endTime > b.startTime;
}

/** Pure, all-or-nothing validation. All transports use this before the one store write. */
export function planCalendarChanges(original: PersistedCalendarStore, changes: CalendarChange[], ctx: CalendarChangeContext): PersistedCalendarStore {
  if (!Array.isArray(changes) || changes.length > 20 || !Number.isFinite(ctx.now)) throw new Error("日历变更数量或时间无效");
  const store = structuredClone(original);
  const stamp = new Date(ctx.now).toISOString();
  const changedCommitments = new Set<string>();
  const changedSchedules = new Set<string>();
  for (const raw of changes) {
    if (!raw || typeof raw !== "object") throw new Error("日历变更格式无效");
    const id = raw.id ? text(raw.id,"事项ID",200) : undefined;
    if (raw.op === "schedule.save" || raw.op === "schedule.cancel") {
      const characterId = text(raw.characterId,"角色ID",200);
      if (!ctx.characterIds.includes(characterId)) throw new Error("只能修改当前参与角色的日程");
      if (id?.startsWith("commitment:")) throw new Error("约定请通过约定操作修改");
      const oldPlan = id ? store.plans.find(plan => plan.ownerType === "character" && plan.ownerId === characterId && plan.items.some(item => item.id === id)) : undefined;
      const old = oldPlan?.items.find(item => item.id === id);
      if (id && !old) throw new Error("原日程不存在，请重新查看");
      if (old) { if (old.commitmentId) throw new Error("约定请通过约定操作修改"); checkMutableSchedule(old,ctx); }
      if (raw.op === "schedule.cancel") {
        if (!old || !oldPlan) throw new Error("取消日程需要明确的ID");
        oldPlan.items = oldPlan.items.filter(item => item.id !== id); oldPlan.updatedAt = stamp; continue;
      }
      const date = validateCalendarDate(raw.date), startTime=text(raw.startTime,"开始时间",5), endTime=text(raw.endTime,"结束时间",5);
      if (!date || !/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime) || !isCalendarTimeRangeAllowed(startTime,endTime)) throw new Error("日程日期或时段无效");
      const item: CalendarScheduleItem = { id: id || newCalendarChangeId(), date, startTime, endTime,
        title:text(raw.title,"事项",120), location:text(raw.location,"地点",120,true), weekday:getWeekdayLabel(date),
        colorKey:pickScheduleColorKey(startTime), source:ctx.manual ? "manual" : old?.source || "generated",
        createdAt:old?.createdAt || stamp, updatedAt:stamp };
      checkMutableSchedule(item,ctx);
      if (!id && store.plans.some(plan => plan.ownerId === characterId && plan.ownerType === "character"
        && plan.items.some(row => row.date === item.date && row.startTime === item.startTime && row.endTime === item.endTime && row.title === item.title && row.location === item.location))) continue;
      if (!ctx.manual && old && Date.parse(`${old.date}T${old.startTime}:00`) < ctx.now
        && (old.date !== date || old.startTime !== startTime)) throw new Error("正在进行的日程可调整后续安排，保留已发生的开始时间");
      if (oldPlan) { oldPlan.items=oldPlan.items.filter(row=>row.id!==id); oldPlan.updatedAt=stamp; }
      const weekStart=getWeekStartIso(new Date(`${date}T12:00:00`));
      let plan=store.plans.find(row=>row.ownerType==="character" && row.ownerId===characterId && row.weekStart===weekStart);
      if (!plan) { plan={id:newCalendarChangeId(),ownerType:"character",ownerId:characterId,weekStart,items:[],updatedAt:stamp}; store.plans.push(plan); }
      plan.items.push(item); plan.updatedAt=stamp;
      changedSchedules.add(item.id);
    } else if (["commitment.save","commitment.cancel","commitment.complete"].includes(raw.op)) {
      const old=id ? store.commitments.find(row=>row.id===id && row.userIdentityId===ctx.userIdentityId) : undefined;
      if (id && (!old || !old.participantIds.some(participant=>ctx.characterIds.includes(participant)))) throw new Error("找不到当前身份及参与者的约定");
      if (!ctx.manual && old?.date && (old.date < dates(ctx.now)[0] || (old.endTime && Date.parse(`${old.date}T${old.endTime}:00`) <= ctx.now))
        && raw.op !== "commitment.complete") throw new Error("已结束的约定可标记完成，保留原日期与内容");
      if (raw.op !== "commitment.save") {
        if (!old) throw new Error("修改约定状态需要明确的ID");
        old.status=raw.op==="commitment.cancel" ? "cancelled" : "completed"; old.updatedAt=stamp; continue;
      }
      const participants=raw.participantIds ?? old?.participantIds ?? ctx.characterIds;
      if (!Array.isArray(participants) || !participants.length || participants.some(id=>typeof id!=="string" || (!ctx.characterIds.includes(id) && !old?.participantIds.includes(id)))) throw new Error("约定参与者超出当前对话范围");
      const date=validateCalendarDate(raw.date), startTime=raw.startTime ? text(raw.startTime,"开始时间",5) : null, endTime=raw.endTime ? text(raw.endTime,"结束时间",5) : null;
      if ((startTime || endTime) && (!date || !startTime || !endTime || !/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime) || !isCalendarTimeRangeAllowed(startTime,endTime))) throw new Error("明确时段需同时提供日期、开始和结束时间；时间未定可留空");
      const entry: CalendarCommitment={id:id||newCalendarChangeId(),participantIds:[...new Set(participants)],userIdentityId:ctx.userIdentityId,
        title:text(raw.title,"约定事项",120),date,startTime,endTime,location:text(raw.location,"地点",120,true),status:"confirmed",
        source:{app:ctx.app,sessionId:ctx.sessionId,messageId:ctx.messageId},createdAt:old?.createdAt||stamp,updatedAt:stamp};
      if (!ctx.manual && date && (date < dates(ctx.now)[0] || (endTime && Date.parse(`${date}T${endTime}:00`) <= ctx.now))) throw new Error("新约定需要安排在尚未结束的时段");
      // Exact accepted repeats (e.g. a reroll) do not create another shared promise.
      const duplicate=store.commitments.find(row=>row.status==="confirmed" && row.userIdentityId===entry.userIdentityId && row.title===entry.title && row.date===date
        && row.startTime===startTime && row.endTime===endTime && row.location===entry.location && [...row.participantIds].sort().join("|")===[...entry.participantIds].sort().join("|"));
      if (!id && duplicate) continue;
      store.commitments=store.commitments.filter(row=>row.id!==entry.id); store.commitments.push(entry);
      changedCommitments.add(entry.id);
    } else throw new Error("未知日历变更操作");
  }
  // Validate after the batch, permitting a cancellation + replacement atomically.
  const confirmed=store.commitments.filter(row=>row.status==="confirmed" && row.date && row.startTime && row.endTime);
  for (let i=0;i<confirmed.length;i++) for (let j=i+1;j<confirmed.length;j++) {
    const a=confirmed[i],b=confirmed[j];
    if (a.userIdentityId===b.userIdentityId && a.participantIds.some(id=>b.participantIds.includes(id))
      && overlaps({date:a.date!,startTime:a.startTime!,endTime:a.endTime!},{date:b.date!,startTime:b.startTime!,endTime:b.endTime!})) {
      // Unchanged legacy conflicts don't block unrelated edits.
      if (changedCommitments.has(a.id) || changedCommitments.has(b.id)) throw new Error("约定与已有约定时间冲突，请明确改期或取消其中一项");
    }
  }
  for(const plan of store.plans) for(const item of plan.items) {
    if (item.source === "manual" && confirmed.some(row => changedCommitments.has(row.id) && row.userIdentityId === ctx.userIdentityId
      && row.participantIds.includes(plan.ownerId) && overlaps(item,{date:row.date!,startTime:row.startTime!,endTime:row.endTime!})))
      throw new Error("约定与手动安排时间冲突，请先调整原安排");
    if(!changedSchedules.has(item.id)) continue;
    if(confirmed.some(row=>row.userIdentityId===ctx.userIdentityId && row.participantIds.includes(plan.ownerId)
      && overlaps(item,{date:row.date!,startTime:row.startTime!,endTime:row.endTime!}))) throw new Error("普通日程与已确认约定冲突，请调整日程时段");
  }
  return store;
}

export async function commitCalendarChanges(batch: PendingCalendarChanges, messageId?: string): Promise<string | null> {
  if (batch.error) return batch.error;
  if (!batch.changes.length) return null;
  const run=async()=>{
    await refreshCalendarData();
    const store=loadCalendarStore();
    if(store.appliedBatches.includes(batch.id)) return null;
    if(store.revision!==batch.revision) return "日历在生成期间已发生变化，本次日历变更未应用，请重新确认";
    try {
      const next=planCalendarChanges(store,batch.changes,{...batch.context,messageId,now:Date.now()});
      next.appliedBatches=[...next.appliedBatches,batch.id].slice(-2048);
      await saveCalendarStoreAsync(next); return null;
    } catch(error) { return error instanceof Error ? error.message : "日历变更未保存"; }
  };
  try {
    return await withCalendarWriteLock(run);
  } catch { return "日历保存失败，正文已保留，请稍后在日历中确认安排"; }
}
